import { base64url } from "../crypto";

/** One block from the sync server's listBlockChanges feed (patches/0014). */
export interface FeedBlock {
  uuid: string;
  pageId: string;
  pageTitle: string;
  breadcrumb: string[];
  text: string;
  tags: string[];
}

/** A page of listBlockChanges. */
export interface FeedPage {
  epoch: string;
  t: number;
  blocks: FeedBlock[];
  removed: string[];
  nextCursor: string | null;
}

/** A block as the index stores it. `tags` are lowercased. */
export interface BlockDocument {
  vectorId: string;
  uuid: string;
  pageId: string;
  pageTitle: string;
  breadcrumb: string[];
  text: string;
  tags: string[];
  /** What is embedded: page title > ancestors > text. */
  document: string;
  hash: string;
  private: boolean;
}

/** The tag that keeps a block, and everything under it, out of the index (any case). */
export const PRIVATE_TAG = "private";
const CRUMB_CHARS = 120;
/** Stays under the model's 512 tokens. */
const DOCUMENT_CHARS = 1500;

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * The block's Vectorize ID: 24 bytes of SHA-256 over graph and block, base64url (32 characters,
 * under Vectorize's 64-byte limit). Scoped by graph because imports can copy block UUIDs.
 */
export async function vectorId(graphId: string, blockUuid: string): Promise<string> {
  return base64url((await sha256(`${graphId}:${blockUuid}`)).slice(0, 24));
}

/** `Page > ancestor > … > text`, each ancestor cut to 120 characters and the whole to 1,500. */
export function documentText(block: Pick<FeedBlock, "pageTitle" | "breadcrumb" | "text">): string {
  const crumbs = block.breadcrumb.map((c) => (c.length > CRUMB_CHARS ? `${c.slice(0, CRUMB_CHARS)}…` : c));
  return [block.pageTitle, ...crumbs, block.text].join(" > ").slice(0, DOCUMENT_CHARS);
}

export async function toDocument(graphId: string, block: FeedBlock): Promise<BlockDocument> {
  const tags = block.tags.map((t) => t.toLowerCase());
  const document = documentText(block);
  return {
    vectorId: await vectorId(graphId, block.uuid),
    uuid: block.uuid,
    pageId: block.pageId,
    pageTitle: block.pageTitle,
    breadcrumb: block.breadcrumb,
    text: block.text,
    tags,
    document,
    hash: base64url(await sha256(document)),
    private: tags.includes(PRIVATE_TAG),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Validates a listBlockChanges response. Throws on any other shape: the feed is our own patch. */
export function parseFeedPage(body: unknown): FeedPage {
  const b = body as Record<string, unknown> | null;
  if (
    typeof b?.epoch !== "string" ||
    !Number.isSafeInteger(b.t) ||
    !Array.isArray(b.blocks) ||
    !isStringArray(b.removed) ||
    (b["next-cursor"] !== undefined && typeof b["next-cursor"] !== "string")
  ) {
    throw new Error("listBlockChanges returned an unexpected shape");
  }
  const blocks = b.blocks.map((raw: unknown): FeedBlock => {
    const r = raw as Record<string, unknown> | null;
    if (
      typeof r?.uuid !== "string" ||
      typeof r["page-id"] !== "string" ||
      typeof r["page-title"] !== "string" ||
      !isStringArray(r.breadcrumb) ||
      typeof r.text !== "string" ||
      !isStringArray(r.tags)
    ) {
      throw new Error("listBlockChanges returned a malformed block");
    }
    return {
      uuid: r.uuid,
      pageId: r["page-id"],
      pageTitle: r["page-title"],
      breadcrumb: r.breadcrumb,
      text: r.text,
      tags: r.tags,
    };
  });
  return {
    epoch: b.epoch,
    t: b.t as number,
    blocks,
    removed: b.removed,
    nextCursor: (b["next-cursor"] as string | undefined) ?? null,
  };
}
