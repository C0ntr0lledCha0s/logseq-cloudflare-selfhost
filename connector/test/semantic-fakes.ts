// Test doubles for semantic search: a deterministic embedder, an in-memory Vectorize index, and a
// sync server that serves listBlockChanges and searchGraph over an in-memory graph with the same
// contract as patches/0014 (full listing by UUID, changes since t, epochs, 410, 409), and getBlocks
// view=signals as patches/0035 answers it.
import { DIMENSIONS, type Embedder, type VectorIndex } from "../src/semantic/config";
import { STOPWORDS } from "../src/semantic/ranking";

/** Words that mean the same thing to the fake model, mapped to one stem. */
const SYNONYMS: Record<string, string> = {
  car: "vehicle", auto: "vehicle", vehicle: "vehicle", wof: "vehicle", warrant: "vehicle", mechanic: "vehicle", tyre: "vehicle",
  doctor: "health", gp: "health", dentist: "health", appointment: "health", checkup: "health", vaccine: "health", health: "health",
  launch: "release", ship: "release", release: "release", rollout: "release", go: "release", live: "release", deploy: "release",
  date: "schedule", deadline: "schedule", when: "schedule", schedule: "schedule", friday: "schedule", week: "schedule", monday: "schedule",
  money: "finance", budget: "finance", cost: "finance", price: "finance", pricing: "finance", spend: "finance", invoice: "finance", pay: "finance", dollar: "finance",
  kid: "child", kids: "child", son: "child", daughter: "child", school: "child", child: "child", playcentre: "child",
  hire: "people", hiring: "people", recruit: "people", candidate: "people", interview: "people", engineer: "people", contractor: "people",
  bug: "defect", crash: "defect", outage: "defect", incident: "defect", error: "defect", fix: "defect", broken: "defect",
  holiday: "travel", trip: "travel", flight: "travel", vacation: "travel", travel: "travel", queenstown: "travel", booking: "travel",
  decide: "decision", decided: "decision", decision: "decision", agreed: "decision", agree: "decision", chose: "decision", choose: "decision",
  password: "secret", bank: "secret", pin: "secret", login: "secret",
};

function stem(word: string): string {
  if (SYNONYMS[word]) return SYNONYMS[word];
  let base = word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (base.length > suffix.length + 2 && base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (SYNONYMS[base]) return SYNONYMS[base];
  return base.length > 4 && base.endsWith("e") ? base.slice(0, -1) : base;
}

function bucket(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return (h >>> 0) % DIMENSIONS;
}

/** Hashed bag of stemmed words, L2-normalised: texts sharing words or synonyms land close together. */
export function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    vector[bucket(stem(word))] += 1;
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  failWith: Error | null = null;

  async embed(texts: string[]): Promise<number[][]> {
    if (this.failWith) throw this.failWith;
    this.calls.push(texts);
    return texts.map(fakeEmbed);
  }

  get embeddedTexts(): string[] {
    return this.calls.flat();
  }
}

/**
 * A FakeEmbedder that answers mapped texts with crafted vectors, for tests that need exact cosines.
 * The indexer embeds a block's document (`Page > text`), so map keys are documents and query strings;
 * any other text falls back to fakeEmbed.
 */
export class CraftedEmbedder extends FakeEmbedder {
  vectors = new Map<string, number[]>();

  override async embed(texts: string[]): Promise<number[][]> {
    if (this.failWith) throw this.failWith;
    this.calls.push(texts);
    return texts.map((t) => this.vectors.get(t) ?? fakeEmbed(t));
  }
}

/** A unit vector whose dot product with `axis(0)` is exactly `cos` (0 to 1). */
export function unitAt(cos: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[0] = cos;
  vector[1] = Math.sqrt(1 - cos * cos);
  return vector;
}

/** The unit vector along dimension `i`. */
export function axis(i: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[i] = 1;
  return vector;
}

interface StoredVector {
  values: number[];
  namespace?: string;
}

export class FakeVectorIndex implements VectorIndex {
  vectors = new Map<string, StoredVector>();
  dimensions = DIMENSIONS;
  upserts = 0;
  deletes = 0;
  queries = 0;

  async describe(): Promise<VectorizeIndexInfo> {
    return {
      vectorCount: this.vectors.size,
      dimensions: this.dimensions,
      processedUpToDatetime: 0,
      processedUpToMutation: 0,
    };
  }

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    this.upserts += 1;
    for (const v of vectors) {
      if (v.values.length !== this.dimensions) throw new Error("wrong dimensions");
      if (v.id.length > 64) throw new Error("id too long");
      this.vectors.set(v.id, { values: Array.from(v.values), namespace: v.namespace });
    }
    return { mutationId: `m${this.upserts}` };
  }

  async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
    this.deletes += 1;
    for (const id of ids) this.vectors.delete(id);
    return { mutationId: `d${this.deletes}` };
  }

  async query(vector: VectorFloatArray | number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches> {
    this.queries += 1;
    const q = Array.from(vector);
    const matches = [...this.vectors.entries()]
      .filter(([, v]) => v.namespace === options?.namespace)
      .map(([id, v]) => ({ id, score: v.values.reduce((sum, x, i) => sum + x * q[i], 0) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, options?.topK ?? 5);
    return { matches, count: matches.length };
  }
}

/** What getBlocks view=signals reports for a block or page (patch 0035). Ages are days before the request. */
export interface FakeSignals {
  ageDays?: number | null;
  /** An exact updated-at in ms, used in place of ageDays when given. */
  updatedAt?: number;
  referenceCount?: number;
  status?: string | null;
  /** Property ident to value titles. */
  properties?: Record<string, string[]>;
}

interface FakePage {
  uuid: string;
  title: string;
  tags: string[];
  signals?: FakeSignals;
}

interface FakeBlock {
  uuid: string;
  pageId: string;
  parentId: string | null;
  text: string;
  tags: string[];
  signals?: FakeSignals;
}

let uuidCounter = 0;
/** Sortable, unique, well-formed UUIDs. */
export function nextUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
}

/** One graph on the fake sync server, with a tx-log-like change list. */
export class FakeGraph {
  epoch = "epoch-1";
  t = 0;
  e2ee = false;
  /** When set, every request to this graph answers this status. */
  failStatus: number | null = null;
  /** When set, only a search whose q equals this term (or one of these terms) answers 500, after any delay. */
  failSearchFor: string | readonly string[] | null = null;
  /** Milliseconds a search for this q waits before it answers, so a test can order answers in time. */
  searchDelays = new Map<string, number>();
  pages = new Map<string, FakePage>();
  blocks = new Map<string, FakeBlock>();
  log: { t: number; uuids: string[] }[] = [];
  feedRequests: URL[] = [];
  searchRequests: URL[] = [];
  /** Every getBlocks view=signals request, failed ones included. */
  signalsRequests: URL[] = [];
  /** When set, a signals request answers this status. */
  failSignals: number | null = null;
  /** Property idents the graph declares besides those in some block's or page's signals. */
  properties = new Set<string>();

  constructor(
    readonly graphId: string,
    readonly token: string,
  ) {}

  private record(uuids: string[]): void {
    this.t += 1;
    this.log.push({ t: this.t, uuids });
  }

  private subtree(uuid: string): string[] {
    const out = [uuid];
    for (const b of this.blocks.values()) if (b.parentId === uuid) out.push(...this.subtree(b.uuid));
    return out;
  }

  addPage(title: string, tags: string[] = [], uuid = nextUuid()): string {
    this.pages.set(uuid, { uuid, title, tags });
    this.record([uuid]);
    return uuid;
  }

  addBlock(pageId: string, text: string, opts: { parent?: string; tags?: string[]; uuid?: string; signals?: FakeSignals } = {}): string {
    const uuid = opts.uuid ?? nextUuid();
    this.blocks.set(uuid, { uuid, pageId, parentId: opts.parent ?? null, text, tags: opts.tags ?? [], signals: opts.signals });
    this.record([uuid]);
    return uuid;
  }

  /** Sets a block's or page's signals; not a content change, so the change list is untouched. */
  setSignals(uuid: string, signals: FakeSignals): void {
    const entity = this.blocks.get(uuid) ?? this.pages.get(uuid);
    if (!entity) throw new Error(`no block or page ${uuid}`);
    entity.signals = signals;
  }

  edit(uuid: string, text: string): void {
    const block = this.blocks.get(uuid);
    if (!block) throw new Error(`no block ${uuid}`);
    block.text = text;
    this.record(this.subtree(uuid));
  }

  tagBlock(uuid: string, tag: string): void {
    const block = this.blocks.get(uuid);
    if (!block) throw new Error(`no block ${uuid}`);
    block.tags.push(tag);
    this.record(this.subtree(uuid));
  }

  renamePage(uuid: string, title: string): void {
    const page = this.pages.get(uuid);
    if (!page) throw new Error(`no page ${uuid}`);
    page.title = title;
    this.record([uuid, ...[...this.blocks.values()].filter((b) => b.pageId === uuid).map((b) => b.uuid)]);
  }

  remove(uuid: string, opts: { silently?: boolean } = {}): void {
    const gone = this.subtree(uuid);
    for (const id of gone) this.blocks.delete(id);
    if (!opts.silently) this.record(gone);
  }

  /** As a snapshot re-upload: a new epoch and a restarted t, with the change list gone. */
  reset(): void {
    this.epoch = `epoch-${Number(this.epoch.split("-")[1]) + 1}`;
    this.t = 0;
    this.log = [];
  }

  private ancestors(block: FakeBlock): FakeBlock[] {
    const out: FakeBlock[] = [];
    let parent = block.parentId ? this.blocks.get(block.parentId) : undefined;
    while (parent) {
      out.unshift(parent);
      parent = parent.parentId ? this.blocks.get(parent.parentId) : undefined;
    }
    return out;
  }

  private response(block: FakeBlock) {
    const page = this.pages.get(block.pageId);
    if (!page) throw new Error(`block ${block.uuid} has no page`);
    const above = this.ancestors(block);
    return {
      uuid: block.uuid,
      "page-id": page.uuid,
      "page-title": page.title,
      breadcrumb: above.map((b) => b.text),
      text: block.text,
      tags: [...new Set([...page.tags, ...above.flatMap((b) => b.tags), ...block.tags])].sort(),
      "updated-at": 0,
    };
  }

  private content(uuid: string): FakeBlock | undefined {
    const block = this.blocks.get(uuid);
    return block && block.text.trim() !== "" ? block : undefined;
  }

  feed(url: URL): Response {
    this.feedRequests.push(url);
    if (this.e2ee) return Response.json({ error: "block changes are unavailable for E2EE graphs" }, { status: 409 });
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const cursor = url.searchParams.get("cursor");
    const since = url.searchParams.get("since");
    const epoch = url.searchParams.get("epoch");
    let ids: string[];
    if (since === null) {
      ids = [...this.blocks.keys()].filter((id) => this.content(id)).sort();
    } else {
      if (epoch !== this.epoch || Number(since) > this.t) {
        return Response.json({ error: "changes since that point are no longer available" }, { status: 410 });
      }
      ids = [...new Set(this.log.filter((e) => e.t > Number(since)).flatMap((e) => e.uuids))].sort();
    }
    const remaining = cursor === null ? ids : ids.filter((id) => id > cursor);
    const page = remaining.slice(0, limit);
    const more = remaining.length > limit;
    return Response.json({
      epoch: this.epoch,
      t: this.t,
      blocks: page.flatMap((id) => {
        const block = this.content(id);
        return block ? [this.response(block)] : [];
      }),
      removed: page.filter((id) => !this.content(id)),
      "next-cursor": more ? page[page.length - 1] : null,
    });
  }

  /** Whether some block or page carries this property, or the graph declares it. */
  private declares(ident: string): boolean {
    if (this.properties.has(ident)) return true;
    return [...this.pages.values(), ...this.blocks.values()].some((e) => e.signals?.properties?.[ident] !== undefined);
  }

  private propertyValues(entity: FakeBlock | FakePage, ident: string): string[] {
    const own = entity.signals?.properties?.[ident];
    if (own && own.length > 0) return own;
    const page = "pageId" in entity ? this.pages.get(entity.pageId) : undefined;
    const inherited = page?.signals?.properties?.[ident];
    return inherited && inherited.length > 0 ? inherited : [];
  }

  /**
   * getBlocks view=signals (patch 0035): up to 100 UUIDs, no duplicates, unknown ones under missing;
   * per entity only uuid, updated-at (now minus ageDays, or null), reference-count (stops at 1000),
   * status and property-values (null without property; else the block's, else its page's, else []).
   */
  signals(url: URL): Response {
    this.signalsRequests.push(url);
    if (this.failSignals !== null) return Response.json({ error: "signals failing" }, { status: this.failSignals });
    const raw = url.searchParams.get("ids") ?? "";
    const ids = raw.split(",").map((id) => id.trim());
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const bad = (error: string) => Response.json({ error }, { status: 400 });
    if (raw.trim() === "" || !ids.every((id) => uuid.test(id))) return bad("ids must be a comma-separated list of UUIDs");
    if (ids.length > 100) return bad("at most 100 ids");
    if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) return bad("duplicate id");
    const property = url.searchParams.get("property");
    if (property !== null && !this.declares(property)) return bad(`property not found: ${property}`);
    const now = Date.now();
    const found = ids.flatMap((id) => {
      const entity = this.blocks.get(id) ?? this.pages.get(id);
      return entity ? [entity] : [];
    });
    return Response.json({
      blocks: found.map((entity) => {
        const s = entity.signals ?? {};
        return {
          uuid: entity.uuid,
          "updated-at": s.updatedAt ?? (s.ageDays === undefined || s.ageDays === null ? null : now - s.ageDays * 86_400_000),
          "reference-count": Math.min(1000, s.referenceCount ?? 0),
          status: s.status ?? null,
          "property-values": property === null ? null : this.propertyValues(entity, property),
        };
      }),
      missing: ids.filter((id) => !this.blocks.has(id) && !this.pages.has(id)),
    });
  }

  /** searchGraph: the whole query as a case-insensitive substring of a title; exact match, then pages, then blocks. */
  search(url: URL): Response {
    this.searchRequests.push(url);
    const needle = (url.searchParams.get("q") ?? "").toLowerCase();
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const hits = [
      ...[...this.pages.values()].map((p) => ({ uuid: p.uuid, title: p.title, resource: "pages" })),
      ...[...this.blocks.values()].map((b) => ({ uuid: b.uuid, title: b.text, resource: "blocks" })),
    ].filter((h) => h.title.toLowerCase().includes(needle));
    const rank = (h: { title: string; resource: string }) =>
      h.title.toLowerCase() === needle ? 0 : h.resource === "pages" ? 1 : 2;
    hits.sort((a, b) => rank(a) - rank(b) || a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    return Response.json({ results: hits.slice(0, limit) });
  }
}

/** A SYNC binding serving these graphs; anything else is a test bug. */
export function fakeSync(graphs: FakeGraph[]): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const match = /^\/api\/v1\/graphs\/([^/]+)\/(block-changes|search|blocks)$/.exec(url.pathname);
      const graph = match && graphs.find((g) => g.graphId === decodeURIComponent(match[1]));
      // getBlocks is served for view=signals only, so a summary or outline call is a test bug.
      const unserved = match?.[2] === "blocks" && url.searchParams.get("view") !== "signals";
      if (!match || !graph || request.method !== "GET" || unserved) {
        return Response.json({ error: `unexpected sync call ${request.method} ${url.pathname}` }, { status: 599 });
      }
      if (request.headers.get("Authorization") !== `Bearer ${graph.token}`) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      if (graph.failStatus !== null) return Response.json({ error: "failing" }, { status: graph.failStatus });
      if (match[2] === "blocks") return graph.signals(url);
      if (match[2] !== "search") return graph.feed(url);
      const q = url.searchParams.get("q") ?? "";
      const delay = graph.searchDelays.get(q);
      if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
      const failing = graph.failSearchFor;
      if (failing !== null && (typeof failing === "string" ? failing === q : failing.includes(q))) {
        graph.searchRequests.push(url);
        return Response.json({ error: `search for ${q} failed` }, { status: 500 });
      }
      return graph.search(url);
    },
  } as unknown as Fetcher;
}
