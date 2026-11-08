// suggest_links' matcher (design: docs/superpowers/specs/2026-11-08-suggest-links-existing-pages-design.md,
// sections 3.3 and 3.5). Pure functions with no I/O: they take the draft and the knowledge index's
// titles and say which plain-text mentions could become [[links]]. The words come from item 27's
// tokeniser (`wordSpans`, `STOPWORDS`), so matching and semantic search split text the same way.
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { RELATED_LIMIT, RELATED_TEXT_CHARS, RELATED_TOP_K, type SemanticBindings } from "../semantic/config";
import { BindingError } from "../semantic/indexer";
import { STOPWORDS, firstWord, wordSpans } from "../semantic/ranking";
import type { SemanticStore } from "../semantic/store";
import { ToolError, resolveGraph, runTool, textResult, withCallGraphs } from "./common";
import { type KbTitlesPage, age, loadTitles } from "./kb-index";
import type { OnSuccess } from "./readable";
import type { GraphAccess } from "./semantic";
import { requestSignals, semanticMatches } from "./semantic-search";
import { ALIAS_PATTERN, GRAPH_PARAM_DESCRIPTION, annotationsFor } from "./spec.mjs";

export type { KbTitlesPage };

/** Longest draft accepted, in characters. */
export const TEXT_LIMIT = 20_000;
/** Suggestions returned when the call names no limit, and the most it may name. */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
/** Most pages `exclude` may name. */
export const EXCLUDE_LIMIT = 50;
/** `related: true`'s limits live with the semantic settings, so SEMANTIC_HELP can name them without an import cycle. */
export { RELATED_LIMIT, RELATED_TEXT_CHARS, RELATED_TOP_K };
/** A one-word title shorter than this is never suggested (stoplist rule 2). Aliases are exempt. */
export const MIN_SINGLE_WORD_CHARS = 4;

/** One-word titles too common in prose to suggest (stoplist rule 4, spec 3.3 d). */
export const COMMON_TITLES: ReadonlySet<string> = new Set(
  "note notes meeting meetings task tasks todo done doing later now idea ideas summary today tomorrow yesterday project projects person people area areas resource resources page journal tag inbox draft archive misc general home index test".split(
    " ",
  ),
);

export interface Span {
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
  text: string;
}

export interface PageRef {
  uuid: string;
  title: string;
}

export interface Suggestion {
  span: Span;
  page: PageRef;
  link: string;
  reason: string;
  also_mentioned: number;
}

export interface AmbiguousMatch {
  span: Span;
  candidates: PageRef[];
}

export interface MatchResult {
  suggestions: Suggestion[];
  ambiguous: AmbiguousMatch[];
  /** Titles of index pages the draft already links, in draft order. */
  alreadyLinked: string[];
  /** The UUIDs of those pages, in the same order. */
  linkedPages: string[];
  /** Distinct stoplisted titles and aliases the draft mentions. */
  skippedStoplist: number;
  truncated: boolean;
  /** Titles and aliases tokenised to build the candidate map (spec 3.3 c's bound). */
  tokenised: number;
}

export interface Masks {
  /** Protected [start, end) ranges, sorted and merged. */
  ranges: [number, number][];
  /** The text of every [[link]], #[[tag]], #tag and [text]([[link]]) outside code, in order. */
  linked: string[];
}

// The outline's indentation and `- ` before a line's content.
const OUTLINE_PREFIX = /^[ \t]*(?:-[ \t]+)?/;
const BLOCK_OPEN = /^#\+BEGIN_(SRC|QUOTE|EXPORT)\b/i;
const PROPERTY_KEY = /^[^\s:]+::/;
// Inline masks, tried in this order at each position. Groups: 1 [[link]] text, 2 markdown link
// target, 3 #tag text.
const INLINE = new RegExp(
  [
    String.raw`\$\$[\s\S]*?\$\$`,
    String.raw`\\\([\s\S]*?\\\)`,
    "`[^`\\n]+`",
    String.raw`\[\[([^\n]*?)\]\]`,
    String.raw`\[[^\[\]\n]*\]\(([^)\n]*)\)`,
    String.raw`(?<![^\s(])#([^\s#\[\](){},;!?"']+)`,
    String.raw`\(\([^()\n]*\)\)`,
    String.raw`\{\{[^\n]*?\}\}`,
    String.raw`[a-z][a-z0-9+.-]*:\/\/\S+`,
    String.raw`www\.\S+`,
  ].join("|"),
  "giu",
);
const PAGE_LINK = /^\[\[(.*)\]\]$/;
const TAG_TRAILING = /[.:]+$/;
const JOINERS = /^[ \t\u00a0\u2010\u2011-]+$/;
const ALL_DIGITS = /^\p{N}+$/u;

/**
 * The ranges no suggestion may touch (spec 3.3 a), and the link text found outside code. One pass
 * over the lines finds fenced and #+BEGIN_ blocks (an unterminated one runs to the end), quote
 * lines and property keys; between blocks, one regex pass finds the inline forms.
 */
export function maskRanges(text: string): Masks {
  const ranges: [number, number][] = [];
  const linked: string[] = [];

  const inline = (from: number, to: number) => {
    if (from >= to) return;
    for (const m of text.slice(from, to).matchAll(INLINE)) {
      ranges.push([from + m.index, from + m.index + m[0].length]);
      if (m[1] !== undefined) linked.push(m[1]);
      else if (m[2] !== undefined) {
        const page = PAGE_LINK.exec(m[2]);
        if (page) linked.push(page[1]);
      } else if (m[3] !== undefined) linked.push(m[3].replace(TAG_TRAILING, ""));
    }
  };

  let block: { start: number; close: string } | null = null;
  let segment = 0;
  let pos = 0;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    const prefix = OUTLINE_PREFIX.exec(line)![0].length;
    const body = line.slice(prefix);
    if (block) {
      if (body.toUpperCase().startsWith(block.close)) {
        ranges.push([block.start, lineEnd]);
        block = null;
        segment = lineEnd;
      }
    } else {
      const open = body.startsWith("```") ? "```" : BLOCK_OPEN.exec(body)?.[1];
      if (open !== undefined) {
        inline(segment, pos);
        block = { start: pos, close: open === "```" ? open : `#+END_${open.toUpperCase()}` };
      } else {
        if (body.startsWith(">")) ranges.push([pos, lineEnd]);
        const key = PROPERTY_KEY.exec(body);
        if (key) ranges.push([pos + prefix, pos + prefix + key[0].length]);
      }
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  if (block) ranges.push([block.start, text.length]);
  else inline(segment, text.length);

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { ranges: merged, linked };
}

/** Stoplist (spec 3.3 d) over a title's or alias's words. */
function stoplisted(words: string[], alias: boolean): boolean {
  if (words.every((w) => STOPWORDS.has(w))) return true;
  if (!alias && words.length === 1 && words[0].length < MIN_SINGLE_WORD_CHARS) return true;
  if (words.every((w) => ALL_DIGITS.test(w))) return true;
  if (words.length === 1 && COMMON_TITLES.has(words[0])) return true;
  return false;
}

function isAsciiWordChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** `firstWord`, with a loop for ASCII names so most of 20,000 titles cost no regex. */
function leadingWord(name: string): string | undefined {
  let i = 0;
  for (; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c >= 128) return firstWord(name);
    if (isAsciiWordChar(c)) break;
  }
  if (i === name.length) return undefined;
  let j = i;
  for (; j < name.length; j++) {
    const c = name.charCodeAt(j);
    if (c >= 128) return firstWord(name);
    if (!isAsciiWordChar(c)) break;
  }
  return name.slice(i, j).toLowerCase();
}

interface Name {
  uuid: string;
  title: string;
  /** Set when this name is an alias of the page. */
  alias?: string;
  lower: string;
  stop: boolean;
}

interface Candidate {
  key: string;
  words: string[];
  names: Name[];
  /** Every name is stoplisted. */
  stop: boolean;
  /** The pages a match suggests: one is a suggestion, more are ambiguous, none blocks the span. */
  pages: Name[];
}

/**
 * Leftmost-longest, whole-word, case-insensitive matches of the index's titles and aliases in
 * `text` (spec 3.3), once per page, in draft order. `exclude` holds page UUIDs never suggested.
 */
export function matchLinks(
  text: string,
  titles: KbTitlesPage[],
  opts: { exclude: Set<string>; limit: number },
): MatchResult {
  const { ranges, linked } = maskRanges(text);
  const spans = wordSpans(text);
  const masked: boolean[] = [];
  let r = 0;
  for (const s of spans) {
    while (r < ranges.length && ranges[r][1] <= s.start) r++;
    masked.push(r < ranges.length && ranges[r][0] < s.end);
  }

  // Only titles whose first word the draft has (unmasked, or as link text) are tokenised.
  const wanted = new Set<string>();
  spans.forEach((s, i) => masked[i] || wanted.add(s.word));
  const linkedLower = linked.map((l) => l.toLowerCase());
  for (const l of linked) {
    const w = firstWord(l);
    if (w !== undefined) wanted.add(w);
  }

  const byKey = new Map<string, Candidate>();
  let tokenised = 0;
  const add = (uuid: string, title: string, name: string, alias: string | undefined) => {
    const first = leadingWord(name);
    if (first === undefined || !wanted.has(first)) return;
    tokenised++;
    const words = wordSpans(name).map((s) => s.word);
    const key = words.join(" ");
    let c = byKey.get(key);
    if (!c) {
      c = { key, words, names: [], stop: false, pages: [] };
      byKey.set(key, c);
    }
    c.names.push({ uuid, title, alias, lower: name.toLowerCase(), stop: stoplisted(words, alias !== undefined) });
  };
  for (const [uuid, title, aliases] of titles) {
    add(uuid, title, title, undefined);
    for (const alias of aliases) add(uuid, title, alias, alias);
  }

  // A page whose title is another page's alias is that alias's page, not a candidate of its own.
  const byLower = new Map<string, Name[]>();
  for (const c of byKey.values()) {
    const aliasOwners = new Set(c.names.filter((n) => n.alias !== undefined).map((n) => n.uuid));
    c.names = c.names.filter((n) => n.alias !== undefined || ![...aliasOwners].some((u) => u !== n.uuid));
    const live = c.names.filter((n) => !n.stop);
    c.stop = live.length === 0;
    // A page's title comes before its aliases in `titles`, so a page matched both ways keeps the title.
    const pages = new Map<string, Name>();
    for (const n of live) {
      if (!pages.has(n.uuid)) pages.set(n.uuid, n);
      byLower.set(n.lower, [...(byLower.get(n.lower) ?? []), n]);
    }
    c.pages = [...pages.values()];
  }

  const linkedPages = new Set<string>();
  const alreadyLinked: string[] = [];
  for (const l of linkedLower) {
    for (const n of byLower.get(l) ?? []) {
      if (linkedPages.has(n.uuid)) continue;
      linkedPages.add(n.uuid);
      alreadyLinked.push(n.title);
    }
  }

  const byFirst = new Map<string, Candidate[]>();
  for (const c of byKey.values()) {
    c.pages = c.pages.filter((n) => !opts.exclude.has(n.uuid) && !linkedPages.has(n.uuid));
    byFirst.set(c.words[0], [...(byFirst.get(c.words[0]) ?? []), c]);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.words.length - a.words.length);

  const fits = (words: string[], i: number): boolean => {
    for (let k = 0; k < words.length; k++) {
      const j = i + k;
      if (j >= spans.length || masked[j] || spans[j].word !== words[k]) return false;
      if (k > 0 && !JOINERS.test(text.slice(spans[j - 1].end, spans[j].start))) return false;
    }
    return true;
  };

  let line = 1;
  let counted = 0;
  const spanOf = (from: number, to: number): Span => {
    const start = spans[from].start;
    for (; counted < start; counted++) if (text.charCodeAt(counted) === 10) line++;
    return { start, end: spans[to].end, line, text: text.slice(start, spans[to].end) };
  };

  const suggestions: Suggestion[] = [];
  const suggested = new Map<string, Suggestion>();
  const ambiguous: AmbiguousMatch[] = [];
  const ambiguousKeys = new Set<string>();
  const stopHits = new Set<string>();
  let truncated = false;

  const emit = (c: Candidate, i: number) => {
    if (c.pages.length === 0) return;
    if (c.pages.length > 1) {
      if (ambiguousKeys.has(c.key)) return;
      ambiguousKeys.add(c.key);
      const candidates = c.pages.map((n) => ({ uuid: n.uuid, title: n.title }));
      ambiguous.push({ span: spanOf(i, i + c.words.length - 1), candidates });
      return;
    }
    const n = c.pages[0];
    const earlier = suggested.get(n.uuid);
    if (earlier) {
      earlier.also_mentioned++;
      return;
    }
    if (suggestions.length >= opts.limit) {
      truncated = true;
      return;
    }
    const suggestion: Suggestion = {
      span: spanOf(i, i + c.words.length - 1),
      page: { uuid: n.uuid, title: n.title },
      link: `[[${n.alias ?? n.title}]]`,
      reason: n.alias === undefined ? "title" : `alias ‘${n.alias}’ of ${n.title}`,
      also_mentioned: 0,
    };
    suggestions.push(suggestion);
    suggested.set(n.uuid, suggestion);
  };

  for (let i = 0; i < spans.length; ) {
    let taken = 1;
    for (const c of byFirst.get(spans[i].word) ?? []) {
      if (!fits(c.words, i)) continue;
      if (c.stop) {
        stopHits.add(c.key);
        continue;
      }
      emit(c, i);
      taken = c.words.length;
      break;
    }
    i += taken;
  }

  return {
    suggestions,
    ambiguous,
    alreadyLinked,
    linkedPages: [...linkedPages],
    skippedStoplist: stopHits.size,
    truncated,
    tokenised,
  };
}

/** `text` with each suggestion's span replaced by its link, spliced from the end so offsets hold. */
export function applyLinks(text: string, suggestions: Pick<Suggestion, "span" | "link">[]): string {
  let out = text;
  for (const s of [...suggestions].sort((a, b) => b.span.start - a.span.start)) {
    out = out.slice(0, s.span.start) + s.link + out.slice(s.span.end);
  }
  return out;
}

/**
 * The page `ref` names (spec 3.5): an exact UUID, else an exact title, else one title equal
 * ignoring case. Two pages sharing the title is `ambiguous`; no page is null. Aliases are not
 * resolved.
 */
export function resolvePageRef(
  titles: KbTitlesPage[],
  ref: string,
): { uuid: string } | { ambiguous: KbTitlesPage[] } | null {
  const lower = ref.toLowerCase();
  const byUuid = titles.find((p) => p[0].toLowerCase() === lower);
  if (byUuid) return { uuid: byUuid[0] };
  for (const same of [(p: KbTitlesPage) => p[1] === ref, (p: KbTitlesPage) => p[1].toLowerCase() === lower]) {
    const found = titles.filter(same);
    if (found.length === 1) return { uuid: found[0][0] };
    if (found.length > 1) return { ambiguous: found };
  }
  return null;
}

// The tool (spec sections 3.4, 3.5, 3.7, 3.8 and 4). Read-only: it reads the kb_index titles key
// (rebuilding it as kb_index would when stale), matches, and verifies the suggested pages with one
// getBlocks view=signals read. It never writes to the graph, logs no audit entry and never marks
// the index dirty.

/** 31204 as "31,204", without an Intl formatter. */
export function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export const SUGGEST_LINKS_DESCRIPTION =
  `Suggest [[links]] to pages that already exist for draft markdown you are about to write (up to ${thousands(TEXT_LIMIT)} characters). Read-only: it never writes. ` +
  "Each suggestion gives the matched span (start, end, line, text), the page's title and UUID, the link to write and the reason (its title, or an alias of it). Matching is whole words, ignoring case, longest title first, and once per page (also_mentioned counts the later mentions); a page the draft already links is listed under already_linked. " +
  "Text inside [[links]], tags, block refs, macros, markdown links, URLs, inline code, code blocks, math, quotes and property keys is never matched, nor are short or common titles (skipped_stoplist counts them). " +
  "Only pages in the knowledge index are suggested: no journals, tags, properties or pages tagged private. Two pages sharing a title are listed under ambiguous and never linked: ask which one is meant. " +
  `page names the page being written (UUID or title), and exclude names up to ${EXCLUDE_LIMIT} more pages never to suggest. limit is at most ${MAX_LIMIT} suggestions (default ${DEFAULT_LIMIT}), in draft order; truncated says when there were more. ` +
  "verify (default true) reads the suggested pages back with one getBlocks request and moves any deleted since the index was built to dropped_stale; verify: false skips that and the first line says the UUIDs are unverified. " +
  "linked_text is the draft with the suggestions applied: show it to the user, then write it with update_block or insert_block_tree.";

/** `ref` as one index page's UUID; null (and a note) when no page has it; refused when several do. */
function resolveRef(pages: KbTitlesPage[], ref: string, field: string, notes: string[], unknown: string): string | null {
  const found = resolvePageRef(pages, ref);
  if (found === null) {
    notes.push(`${field}: no page ‘${ref}’ in the index${unknown}`);
    return null;
  }
  if ("ambiguous" in found) {
    const listed = found.ambiguous.map(([uuid, title]) => `${title} ${uuid}`).join(", ");
    throw new ToolError(`${field}: ${found.ambiguous.length} pages are titled ‘${ref}’ (${listed}); pass the UUID`, "refused");
  }
  return found.uuid;
}

export interface RelatedPage {
  page: PageRef;
  similarity: number;
  reason: "related by meaning";
}

/** The draft as `related` embeds it (spec 3.6): masked ranges removed, spaces collapsed, then the first `RELATED_TEXT_CHARS`. */
export function relatedText(text: string): string {
  let out = "";
  let at = 0;
  for (const [start, end] of maskRanges(text).ranges) {
    out += `${text.slice(at, start)} `;
    at = end;
  }
  out += text.slice(at);
  return out.replace(/\s+/g, " ").trim().slice(0, RELATED_TEXT_CHARS);
}

/**
 * Up to `RELATED_LIMIT` index pages close in meaning to the draft (spec 3.6): one embedding, one
 * Vectorize query of `RELATED_TOP_K` and one `blocksFor` read by vector id. Hits are grouped by page,
 * best similarity first; a page not in the titles key (a journal, a page tagged private) or in `skip`
 * is left out.
 */
async function relatedPages(
  semantic: { store: SemanticStore; bindings: SemanticBindings },
  graphId: string,
  text: string,
  pages: KbTitlesPage[],
  skip: Set<string>,
): Promise<RelatedPage[]> {
  const draft = relatedText(text);
  if (draft === "") return [];
  let matches;
  try {
    matches = await semanticMatches(semantic.bindings, graphId, draft, RELATED_TOP_K);
  } catch (error) {
    if (error instanceof BindingError) throw new ToolError(error.message, "binding-error");
    throw error;
  }
  const blocks = await semantic.store.blocksFor(graphId, matches.map((m) => m.id), []);
  const pageOf = new Map(blocks.map((b) => [b.vectorId, b.pageId]));
  const titleOf = new Map(pages.map(([uuid, title]) => [uuid, title]));
  const related = new Map<string, RelatedPage>();
  for (const m of [...matches].sort((a, b) => b.similarity - a.similarity)) {
    const uuid = pageOf.get(m.id);
    const title = uuid === undefined ? undefined : titleOf.get(uuid);
    if (uuid === undefined || title === undefined || skip.has(uuid) || related.has(uuid)) continue;
    related.set(uuid, { page: { uuid, title }, similarity: Number(m.similarity.toFixed(3)), reason: "related by meaning" });
    if (related.size === RELATED_LIMIT) break;
  }
  return [...related.values()];
}

/**
 * Registers `suggest_links`. `semantic` is the isolate's semantic search (null when off); the
 * `related` leg that uses it is spec section 3.6.
 */
export function registerSuggestLinksTool(
  server: McpServer,
  access: GraphAccess,
  semantic: { store: SemanticStore; bindings: SemanticBindings } | null,
  onSuccess: OnSuccess,
): void {
  const fields = {
    graph: z.string().regex(new RegExp(ALIAS_PATTERN)).describe(GRAPH_PARAM_DESCRIPTION),
    text: z.string().min(1).describe(`The draft markdown, up to ${thousands(TEXT_LIMIT)} characters.`),
    page: z
      .string()
      .min(1)
      .optional()
      .describe("The page being written, by UUID or title; it is never suggested. A title several pages share is refused."),
    exclude: z
      .array(z.string().min(1))
      .optional()
      .describe(`Up to ${EXCLUDE_LIMIT} more pages never to suggest, by UUID or title.`),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(`Most suggestions returned, in draft order (default ${DEFAULT_LIMIT}).`),
    verify: z
      .boolean()
      .optional()
      .describe("Read the suggested pages back with one getBlocks request and drop any deleted since the index was built (default true)."),
  };
  // With semantic search off, `related` is not in the schema; passthrough keeps a passed one visible so it is refused, not dropped.
  const inputSchema = semantic
    ? z.object({
        ...fields,
        related: z
          .boolean()
          .optional()
          .describe(
            `Also list at most ${RELATED_LIMIT} index pages close in meaning to the draft that it does not name, from one embedding of its first ${thousands(RELATED_TEXT_CHARS)} characters with links, code and the other masked text removed. They are verified with the suggestions and never added to linked_text (default false).`,
          ),
      })
    : z.object(fields).passthrough();
  server.registerTool(
    "suggest_links",
    {
      description: SUGGEST_LINKS_DESCRIPTION,
      inputSchema,
      annotations: annotationsFor("suggest_links"),
    },
    (args: z.infer<z.ZodObject<typeof fields>> & { related?: unknown }) => {
      const { graph: alias, text, page, exclude = [], limit = DEFAULT_LIMIT, verify = true, related } = args;
      return runTool("suggest_links", alias, () =>
        withCallGraphs(async () => {
          // Input checks run before any KV or sync call.
          if (text.length > TEXT_LIMIT) {
            throw new ToolError(`text: ${thousands(text.length)} characters is over the ${thousands(TEXT_LIMIT)} limit`, "refused");
          }
          if (exclude.length > EXCLUDE_LIMIT) {
            throw new ToolError(`exclude: ${exclude.length} entries is over the ${EXCLUDE_LIMIT} limit`, "refused");
          }
          // related: false is a no-op either way; any other value needs semantic search.
          if (semantic === null && related !== undefined && related !== false) {
            throw new ToolError("related: semantic search is off on this connector", "refused");
          }
          const wantRelated = semantic !== null && related === true;

          const now = Date.now();
          let titles;
          try {
            titles = await loadTitles(access, alias, now);
          } catch (error) {
            if (error instanceof ToolError && error.status === "http-409") {
              throw new ToolError("suggest_links needs the knowledge index, which is unavailable for E2EE graphs", error.status);
            }
            throw error;
          }

          const notes: string[] = [];
          const excluded = new Set<string>();
          if (page !== undefined) {
            const uuid = resolveRef(
              titles.pages,
              page,
              "page",
              notes,
              " (journals and pages tagged private are not in it); nothing was excluded",
            );
            if (uuid !== null) excluded.add(uuid);
          }
          exclude.forEach((ref, i) => {
            const uuid = resolveRef(titles.pages, ref, `exclude[${i}]`, [], "");
            if (uuid === null) notes.push(`exclude: no page ‘${ref}’ in the index`);
            else excluded.add(uuid);
          });

          const result = matchLinks(text, titles.pages, { exclude: excluded, limit });
          let suggestions = result.suggestions;
          let graph: Awaited<ReturnType<typeof resolveGraph>> | undefined;
          const resolved = async () => (graph ??= await resolveGraph(access, alias, false));
          let relatedList: RelatedPage[] = [];
          if (wantRelated) {
            // Pages the draft names (suggested, ambiguous, already linked) or the call excludes are not "related".
            const skip = new Set([
              ...excluded,
              ...suggestions.map((s) => s.page.uuid),
              ...result.ambiguous.flatMap((a) => a.candidates.map((c) => c.uuid)),
              ...result.linkedPages,
            ]);
            relatedList = await relatedPages(semantic, (await resolved()).graphId, text, titles.pages, skip);
          }
          const droppedStale: PageRef[] = [];
          if (verify && suggestions.length + relatedList.length > 0) {
            const { graphId, pat } = await resolved();
            const ids = [...suggestions.map((s) => s.page.uuid), ...relatedList.map((r) => r.page.uuid)];
            let found: Awaited<ReturnType<typeof requestSignals>>;
            try {
              found = await requestSignals(access, alias, graphId, pat, ids);
            } catch (error) {
              const reason = `verify: getBlocks failed: ${error instanceof Error ? error.message : String(error)}`;
              throw new ToolError(reason, error instanceof ToolError ? error.status : "verify-failed");
            }
            // A page the server lists as missing, or leaves out of blocks, is gone since the index was built.
            const missing = new Set(found.missing);
            const live = (uuid: string) => found.signals.has(uuid) && !missing.has(uuid);
            for (const s of suggestions) if (!live(s.page.uuid)) droppedStale.push(s.page);
            suggestions = suggestions.filter((s) => live(s.page.uuid));
            for (const r of relatedList) if (!live(r.page.uuid)) droppedStale.push(r.page);
            relatedList = relatedList.filter((r) => live(r.page.uuid));
          }

          const built = new Date(titles.builtAt).toISOString();
          const ago = age(Date.now() - titles.builtAt);
          const count = suggestions.length;
          const summary = [
            `${count} link ${count === 1 ? "suggestion" : "suggestions"} for graph "${alias}" (index built ${built.slice(11, 16)} UTC, ${ago})`,
            `${result.alreadyLinked.length} already linked`,
            `${droppedStale.length} dropped as stale`,
            ...(wantRelated ? [`${relatedList.length} related`] : []),
            ...(verify ? [] : [`not verified (verify: false): the UUIDs come from the index built ${ago}`]),
            ...notes,
          ].join("; ");
          const body = {
            graph: alias,
            index_built_at: built,
            suggestions,
            ambiguous: result.ambiguous,
            related: relatedList,
            already_linked: result.alreadyLinked,
            dropped_stale: droppedStale,
            skipped_stoplist: result.skippedStoplist,
            truncated: result.truncated,
            linked_text: applyLinks(text, suggestions),
          };
          onSuccess("suggest_links", alias);
          return textResult(`${summary}\n${JSON.stringify(body, null, 2)}`);
        }),
      );
    },
  );
}
