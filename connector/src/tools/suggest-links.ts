// suggest_links' matcher (design: docs/superpowers/specs/2026-11-08-suggest-links-existing-pages-design.md,
// sections 3.3 and 3.5). Pure functions with no I/O: they take the draft and the knowledge index's
// titles and say which plain-text mentions could become [[links]]. The words come from item 27's
// tokeniser (`wordSpans`, `STOPWORDS`), so matching and semantic search split text the same way.
import { STOPWORDS, firstWord, wordSpans } from "../semantic/ranking";

/** One knowledge-index page as the matcher needs it: its UUID, title and alias titles. */
export type KbTitlesPage = [uuid: string, title: string, aliases: string[]];

/** Longest draft accepted, in characters. */
export const TEXT_LIMIT = 20_000;
/** Suggestions returned when the call names no limit, and the most it may name. */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 50;
/** Most pages `exclude` may name. */
export const EXCLUDE_LIMIT = 50;
/** `related: true`: pages returned, characters of the draft embedded, and vectors queried. */
export const RELATED_LIMIT = 5;
export const RELATED_TEXT_CHARS = 2_000;
export const RELATED_TOP_K = 20;
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

  return { suggestions, ambiguous, alreadyLinked, skippedStoplist: stopHits.size, truncated, tokenised };
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
