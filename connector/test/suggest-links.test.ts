// suggest_links' pure matcher (spec 2026-11-08-suggest-links-existing-pages-design.md, sections
// 3.3 and 3.5). Every test calls the real functions on example pages; nothing is stubbed. Each mask
// and stoplist rule has a test with a decoy that only that rule keeps from matching, so deleting
// the rule fails a test (docs/solutions/testing/untested-rules-survive-mutation.md).
import { describe, expect, it } from "vitest";
import { STOPWORDS, contentWords, wordSpans } from "../src/semantic/ranking";
import {
  COMMON_TITLES,
  DEFAULT_LIMIT,
  EXCLUDE_LIMIT,
  type KbTitlesPage,
  MAX_LIMIT,
  MIN_SINGLE_WORD_CHARS,
  RELATED_LIMIT,
  RELATED_TEXT_CHARS,
  RELATED_TOP_K,
  TEXT_LIMIT,
  applyLinks,
  maskRanges,
  matchLinks,
  resolvePageRef,
} from "../src/tools/suggest-links";

const WI = "00000000-0000-4000-8000-000000000001";
const WF = "00000000-0000-4000-8000-000000000002";
const OPS = "00000000-0000-4000-8000-000000000003";
const OI_PAGE = "00000000-0000-4000-8000-000000000004";
const HOS = "00000000-0000-4000-8000-000000000005";
const MH = "00000000-0000-4000-8000-000000000006";
const SPRINT_A = "00000000-0000-4000-8000-000000000007";
const SPRINT_B = "00000000-0000-4000-8000-000000000008";
const IST = "00000000-0000-4000-8000-000000000009";
const OPS_INTEL = "00000000-0000-4000-8000-00000000000a";

const PAGES: KbTitlesPage[] = [
  [WI, "Workflow Intelligence", []],
  [WF, "Workflow", []],
  [OPS, "Operational Intelligence", ["OI", "Ops Intel"]],
  // An alias page is tagged Page, so it is an index entry in its own right (spec 3.2).
  [OI_PAGE, "OI", []],
  [OPS_INTEL, "Ops Intel", []],
  [HOS, "Head of Sales", []],
  [MH, "Māori Health", []],
  [SPRINT_A, "Sprint", []],
  [SPRINT_B, "Sprint", []],
  [IST, "İstanbul Office", []],
];

function match(text: string, titles: KbTitlesPage[] = PAGES, exclude: string[] = [], limit = DEFAULT_LIMIT) {
  return matchLinks(text, titles, { exclude: new Set(exclude), limit });
}

/** Each suggestion as [title, start], in draft order. */
function hits(text: string, titles: KbTitlesPage[] = PAGES, exclude: string[] = [], limit = DEFAULT_LIMIT) {
  return match(text, titles, exclude, limit).suggestions.map((s) => [s.page.title, s.span.start]);
}

/** The offset of the `nth` (0-based) occurrence of `needle` in `text`. */
function at(text: string, needle: string, nth = 0): number {
  let from = -1;
  for (let i = 0; i <= nth; i++) {
    from = text.indexOf(needle, from + 1);
    if (from < 0) throw new Error(`no occurrence ${nth} of ${needle}`);
  }
  return from;
}

describe("constants", () => {
  it("are the plan's values, and COMMON_TITLES is spec 3.3 d verbatim", () => {
    expect([TEXT_LIMIT, DEFAULT_LIMIT, MAX_LIMIT, EXCLUDE_LIMIT]).toEqual([20_000, 25, 50, 50]);
    expect([RELATED_LIMIT, RELATED_TEXT_CHARS, RELATED_TOP_K, MIN_SINGLE_WORD_CHARS]).toEqual([5, 2_000, 20, 4]);
    expect([...COMMON_TITLES]).toEqual(
      "note notes meeting meetings task tasks todo done doing later now idea ideas summary today tomorrow yesterday project projects person people area areas resource resources page journal tag inbox draft archive misc general home index test".split(
        " ",
      ),
    );
  });
});

describe("wordSpans", () => {
  it("gives UTF-16 offsets into the original text for macrons and emoji", () => {
    expect(wordSpans("Māori Health")).toEqual([
      { word: "māori", start: 0, end: 5 },
      { word: "health", start: 6, end: 12 },
    ]);
    // The rocket is two UTF-16 code units.
    expect(wordSpans("🚀 Launch day")).toEqual([
      { word: "launch", start: 3, end: 9 },
      { word: "day", start: 10, end: 13 },
    ]);
    expect(wordSpans("--- 🚀 ...")).toEqual([]);
  });

  it("takes offsets before lower-casing, so İ (two code units in lower case) shifts nothing", () => {
    const text = "İzmir then İstanbul Office";
    const spans = wordSpans(text);
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [6, 10],
      [11, 19],
      [20, 26],
    ]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["İzmir", "then", "İstanbul", "Office"]);
    expect(spans.map((s) => s.word)).toEqual(["İzmir".toLowerCase(), "then", "İstanbul".toLowerCase(), "office"]);
  });

  it("splits on the same characters as contentWords", () => {
    const text = "Q3-budget/2026 (draft) whānau";
    expect(wordSpans(text).map((s) => s.word)).toEqual(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    expect(contentWords(text)).toEqual(["budget", "2026", "draft", "whānau"]);
  });
});

describe("matchLinks: matching", () => {
  it("matches a whole title ignoring case, with its exact span, line, link and reason", () => {
    const text = "Stand-up notes\nWe reviewed workflow intelligence today.";
    const start = at(text, "workflow intelligence");
    expect(match(text).suggestions).toEqual([
      {
        span: { start, end: start + 21, line: 2, text: "workflow intelligence" },
        page: { uuid: WI, title: "Workflow Intelligence" },
        link: "[[Workflow Intelligence]]",
        reason: "title",
        also_mentioned: 0,
      },
    ]);
  });

  it("matches whole words only: Workflows is not Workflow", () => {
    expect(hits("Workflows run daily.")).toEqual([]);
    expect(hits("The Workflow runs daily.")).toEqual([["Workflow", 4]]);
  });

  it("takes the longest title at a position", () => {
    expect(hits("Workflow Intelligence is live")).toEqual([["Workflow Intelligence", 0]]);
    // Same result whatever order the index lists the pages in.
    expect(hits("Workflow Intelligence is live", [...PAGES].reverse())).toEqual([["Workflow Intelligence", 0]]);
  });

  it("joins words across spaces and hyphens, but not across other punctuation or a line break", () => {
    expect(hits("Workflow-Intelligence ships")).toEqual([["Workflow Intelligence", 0]]);
    expect(hits("Workflow  Intelligence ships")).toEqual([["Workflow Intelligence", 0]]);
    expect(hits("Workflow\u00a0Intelligence ships")).toEqual([["Workflow Intelligence", 0]]);
    expect(hits("Workflow\u2010Intelligence ships")).toEqual([["Workflow Intelligence", 0]]);
    expect(hits("Workflow\u2011Intelligence ships")).toEqual([["Workflow Intelligence", 0]]);
    expect(hits("Workflow\u2014Intelligence ships")).toEqual([["Workflow", 0]]);
    expect(hits("Workflow. Intelligence ships")).toEqual([["Workflow", 0]]);
    expect(hits("Workflow\nIntelligence ships")).toEqual([["Workflow", 0]]);
    expect(hits("Workflow, Intelligence ships")).toEqual([["Workflow", 0]]);
  });

  it("never matches across a masked range", () => {
    expect(hits("Workflow `x` Intelligence")).toEqual([["Workflow", 0]]);
    expect(hits("Workflow [[x]] Intelligence")).toEqual([["Workflow", 0]]);
  });

  it("skips titles that tokenise to nothing", () => {
    const titles: KbTitlesPage[] = [
      ["00000000-0000-4000-8000-0000000000a1", "🚀", []],
      ["00000000-0000-4000-8000-0000000000a2", "---", []],
      ["00000000-0000-4000-8000-0000000000a3", "Launch Plan", []],
    ];
    const result = match("🚀 --- the Launch Plan", titles);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Launch Plan"]);
    expect(result.tokenised).toBe(1);
  });

  it("gives offsets for macrons, emoji and İ that splice back exactly", () => {
    const text = "İzmir 🚀 then Māori Health and İstanbul Office";
    const result = match(text);
    expect(result.suggestions.map((s) => [s.page.title, s.span.text])).toEqual([
      ["Māori Health", "Māori Health"],
      ["İstanbul Office", "İstanbul Office"],
    ]);
    for (const s of result.suggestions) expect(text.slice(s.span.start, s.span.end)).toBe(s.span.text);
    expect(applyLinks(text, result.suggestions)).toBe("İzmir 🚀 then [[Māori Health]] and [[İstanbul Office]]");
  });
});

describe("matchLinks: aliases", () => {
  it("links the alias and says which page it is an alias of", () => {
    const text = "Ask the OI team";
    expect(match(text).suggestions).toEqual([
      {
        span: { start: 8, end: 10, line: 1, text: "OI" },
        page: { uuid: OPS, title: "Operational Intelligence" },
        link: "[[OI]]",
        reason: "alias ‘OI’ of Operational Intelligence",
        also_mentioned: 0,
      },
    ]);
  });

  it("drops the alias page as a standalone candidate, in either index order", () => {
    for (const titles of [PAGES, [...PAGES].reverse()]) {
      const result = match("oi", titles);
      expect(result.ambiguous).toEqual([]);
      expect(result.suggestions.map((s) => [s.page.uuid, s.link])).toEqual([[OPS, "[[OI]]"]]);
      // "Ops Intel" is long enough to pass the stoplist, so only the alias rule decides this one.
      const long = match("ops intel", titles);
      expect(long.ambiguous).toEqual([]);
      expect(long.suggestions.map((s) => [s.page.uuid, s.link, s.reason])).toEqual([
        [OPS, "[[Ops Intel]]", "alias ‘Ops Intel’ of Operational Intelligence"],
      ]);
    }
  });

  it("is ambiguous when two pages share an alias", () => {
    const other = "00000000-0000-4000-8000-0000000000b1";
    const titles: KbTitlesPage[] = [...PAGES, [other, "Office Intranet", ["OI"]]];
    const result = match("The OI page", titles);
    expect(result.suggestions).toEqual([]);
    expect(result.ambiguous).toEqual([
      {
        span: { start: 4, end: 6, line: 1, text: "OI" },
        candidates: [
          { uuid: OPS, title: "Operational Intelligence" },
          { uuid: other, title: "Office Intranet" },
        ],
      },
    ]);
  });

  it("counts a title and an alias of one page as mentions of that page", () => {
    const result = match("Operational Intelligence, also called OI");
    expect(result.suggestions.map((s) => [s.page.uuid, s.reason, s.also_mentioned])).toEqual([[OPS, "title", 1]]);
  });

  it("keeps short aliases: the owner chose them as names for the page", () => {
    // A 2-letter title would be stoplisted (rule 2); the same word as an alias is suggested.
    const titles: KbTitlesPage[] = [
      ["00000000-0000-4000-8000-0000000000c1", "QA", []],
      ["00000000-0000-4000-8000-0000000000c2", "Release Checks", ["RC"]],
    ];
    const result = match("QA and RC today", titles);
    expect(result.suggestions.map((s) => s.link)).toEqual(["[[RC]]"]);
    expect(result.skippedStoplist).toBe(1);
  });
});

describe("matchLinks: masks (one rule each, with the same title matching outside it)", () => {
  // The decoy comes first. Without the mask, the first mention would be suggested instead.
  const cases: [string, string, string][] = [
    ["a [[link]] whose text contains the title", "See [[Workflow Intelligence roadmap]] and Workflow Intelligence.", "Workflow Intelligence."],
    ["a #[[tag]]", "Tagged #[[Workflow Intelligence roadmap]] then Workflow Intelligence.", "Workflow Intelligence."],
    ["a #tag", "Tagged #Workflow-Intelligence then Workflow Intelligence.", "Workflow Intelligence."],
    ["a ((block ref))", "Ref ((Workflow Intelligence)) then Workflow Intelligence.", "Workflow Intelligence."],
    ["a {{macro}}", 'Run {{query "Workflow Intelligence"}} then Workflow Intelligence.', "Workflow Intelligence."],
    ["a markdown link's text", "See [Workflow Intelligence notes](notes.md) and Workflow Intelligence.", "Workflow Intelligence."],
    ["a markdown link's relative URL", "See [notes](Workflow-Intelligence.md) and Workflow Intelligence.", "Workflow Intelligence."],
    ["a scheme:// URL", "See https://example.com/Workflow-Intelligence and Workflow Intelligence.", "Workflow Intelligence."],
    ["a www. URL", "See www.workflow-intelligence.example and Workflow Intelligence.", "Workflow Intelligence."],
    ["inline code", "Run `Workflow Intelligence` then Workflow Intelligence.", "Workflow Intelligence."],
    ["a ``` fence", "- ```\n  Workflow Intelligence\n  ```\n- Workflow Intelligence.", "Workflow Intelligence."],
    ["a #+BEGIN_SRC block", "#+BEGIN_SRC\nWorkflow Intelligence\n#+END_SRC\nWorkflow Intelligence.", "Workflow Intelligence."],
    ["a #+BEGIN_QUOTE block", "#+BEGIN_QUOTE\nWorkflow Intelligence\n#+END_QUOTE\nWorkflow Intelligence.", "Workflow Intelligence."],
    ["a #+BEGIN_EXPORT block", "#+BEGIN_EXPORT html\nWorkflow Intelligence\n#+END_EXPORT\nWorkflow Intelligence.", "Workflow Intelligence."],
    ["$$math$$", "Math $$Workflow Intelligence$$ then Workflow Intelligence.", "Workflow Intelligence."],
    ["\\(math\\)", "Math \\(Workflow Intelligence\\) then Workflow Intelligence.", "Workflow Intelligence."],
    ["a > quote after the outline's - and indentation", "  - > Workflow Intelligence said so\n  - Workflow Intelligence.", "Workflow Intelligence."],
    ["a property key before ::", "workflow-intelligence:: yes\nWorkflow Intelligence.", "Workflow Intelligence."],
  ];

  for (const [name, text, outside] of cases) {
    it(`masks ${name}`, () => {
      expect(hits(text)).toEqual([["Workflow Intelligence", at(text, outside)]]);
    });
  }

  it("leaves a single $ alone, so a price still matches", () => {
    const text = "Paid $40 for Workflow Intelligence and $15 more";
    expect(hits(text)).toEqual([["Workflow Intelligence", at(text, "Workflow Intelligence")]]);
  });

  it("does not treat a > inside a line as a quote", () => {
    const text = "a > Workflow Intelligence";
    expect(hits(text)).toEqual([["Workflow Intelligence", 4]]);
  });

  it("matches a property's value, only its key is masked", () => {
    const text = "owner:: Head of Sales";
    expect(hits(text)).toEqual([["Head of Sales", 8]]);
  });

  it("runs an unterminated ``` fence to the end of the text", () => {
    const text = "Workflow Intelligence first\n```\nHead of Sales\n";
    expect(hits(text)).toEqual([["Workflow Intelligence", 0]]);
  });

  it("runs an unterminated #+BEGIN_SRC to the end of the text", () => {
    const text = "Workflow Intelligence first\n#+BEGIN_SRC\nHead of Sales\n";
    expect(hits(text)).toEqual([["Workflow Intelligence", 0]]);
  });

  it("ends a #+BEGIN_ block only at its own #+END_", () => {
    const text = "#+BEGIN_SRC\n#+END_QUOTE\nHead of Sales\n#+END_SRC\nWorkflow Intelligence";
    expect(hits(text)).toEqual([["Workflow Intelligence", at(text, "Workflow Intelligence")]]);
  });

  it("returns sorted protected ranges, merging overlaps", () => {
    const text = "`a` and [[b]] and https://x.example/y";
    expect(maskRanges(text).ranges).toEqual([
      [0, 3],
      [8, 13],
      [18, text.length],
    ]);
    // A quote line holding inline code is one range.
    expect(maskRanges("> see `x` here\nok").ranges).toEqual([[0, 14]]);
  });

  it("reads #+begin_ and #+end_ in any case", () => {
    const text = "#+begin_quote\nWorkflow Intelligence\n#+end_quote\nWorkflow Intelligence.";
    expect(hits(text)).toEqual([["Workflow Intelligence", at(text, "Workflow Intelligence.")]]);
  });

  it("takes a # inside a word as text, not a tag", () => {
    const text = "issue#Workflow and the Workflow";
    expect(hits(text)).toEqual([["Workflow", at(text, "Workflow")]]);
  });

  it("never lets a title's later word fall inside a mask", () => {
    const titles: KbTitlesPage[] = [["00000000-0000-4000-8000-0000000000d1", "Docs WWW", []]];
    const text = "Docs www.example.com is down; Docs WWW is the team.";
    expect(hits(text, titles)).toEqual([["Docs WWW", at(text, "Docs WWW")]]);
  });
});

describe("matchLinks: already linked", () => {
  it("skips a page linked earlier in any case, and lists it", () => {
    const text = "See [[workflow intelligence]]. Later, Workflow Intelligence again.";
    const result = match(text);
    expect(result.suggestions).toEqual([]);
    expect(result.alreadyLinked).toEqual(["Workflow Intelligence"]);
  });

  it("counts #[[Title]] and #Title as links", () => {
    const tagged = match("Tagged #[[Workflow Intelligence]]; Workflow Intelligence.");
    expect(tagged.suggestions).toEqual([]);
    expect(tagged.alreadyLinked).toEqual(["Workflow Intelligence"]);

    const text = "Tagged #workflow. The Workflow and Workflow Intelligence.";
    const hashed = match(text);
    expect(hashed.suggestions.map((s) => s.page.title)).toEqual(["Workflow Intelligence"]);
    expect(hashed.alreadyLinked).toEqual(["Workflow"]);
  });

  it("counts a link to an alias as a link to its page", () => {
    const result = match("Ask [[OI]]. Operational Intelligence owns it.");
    expect(result.suggestions).toEqual([]);
    expect(result.alreadyLinked).toEqual(["Operational Intelligence"]);
  });

  it("counts a markdown link to a [[page]] as a link", () => {
    const result = match("See [the plan]([[Workflow Intelligence]]) and Workflow Intelligence.");
    expect(result.suggestions).toEqual([]);
    expect(result.alreadyLinked).toEqual(["Workflow Intelligence"]);
  });

  it("does not count a [[link]] inside code", () => {
    const text = "```\n[[Workflow]]\n```\nThe Workflow.";
    expect(hits(text)).toEqual([["Workflow", at(text, "Workflow.")]]);
    expect(match(text).alreadyLinked).toEqual([]);
  });

  it("does not count a link to a different title that shares the words", () => {
    // #Workflow-Intelligence links the page "Workflow-Intelligence", not "Workflow Intelligence".
    const result = match("#Workflow-Intelligence then Workflow Intelligence");
    expect(result.alreadyLinked).toEqual([]);
  });
});

describe("matchLinks: once per page", () => {
  it("suggests the first mention and counts the rest", () => {
    const text = "Workflow Intelligence. Then workflow intelligence, and WORKFLOW INTELLIGENCE.";
    const result = match(text);
    expect(result.suggestions.map((s) => [s.span.start, s.also_mentioned])).toEqual([[0, 2]]);
  });

  it("does not count mentions inside masks", () => {
    const result = match("Workflow Intelligence and `Workflow Intelligence`");
    expect(result.suggestions.map((s) => s.also_mentioned)).toEqual([0]);
  });
});

describe("matchLinks: stoplist (one rule each, with a near miss that matches)", () => {
  const page = (n: number, title: string): KbTitlesPage => [`00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, title, []];

  it("rule 1: every word is a stopword; Head of Sales still matches", () => {
    const titles = [page(1, "What About"), page(2, "Head of Sales")];
    const result = match("What about the Head of Sales?", titles);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Head of Sales"]);
    expect(result.skippedStoplist).toBe(1);
  });

  it("rule 2: a single word shorter than 4 characters; 4 characters match", () => {
    const titles = [page(1, "Ops"), page(2, "Opus")];
    const result = match("Ops and Opus", titles);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Opus"]);
    expect(result.skippedStoplist).toBe(1);
  });

  it("rule 3: all digits; Q3 Plan matches", () => {
    const titles = [page(1, "2026"), page(2, "2026 11"), page(3, "Q3 Plan")];
    const result = match("In 2026 11 the Q3 Plan", titles);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Q3 Plan"]);
    expect(result.skippedStoplist).toBe(2);
  });

  it("rule 4: each COMMON_TITLES word alone; Meeting Notes 2026 matches", () => {
    const titles = [...COMMON_TITLES].map((word, n) => page(n, word[0].toUpperCase() + word.slice(1)));
    titles.push(page(99, "Meeting Notes 2026"));
    const text = `${[...COMMON_TITLES].join(" and ")}. Meeting Notes 2026.`;
    const result = match(text, titles);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Meeting Notes 2026"]);
    expect(result.skippedStoplist).toBe(COMMON_TITLES.size);
  });

  it("each COMMON_TITLES word of 4 or more letters is stopped by rule 4 alone", () => {
    for (const word of COMMON_TITLES) {
      if (word.length < MIN_SINGLE_WORD_CHARS || STOPWORDS.has(word)) continue;
      const result = match(`The ${word} list`, [page(1, word)]);
      expect(result.suggestions, word).toEqual([]);
      expect(result.skippedStoplist, word).toBe(1);
    }
  });

  it("counts each stoplisted title once, and only when the draft mentions it", () => {
    const titles = [page(1, "Ops"), page(2, "Inbox"), page(3, "Head of Sales")];
    expect(match("Ops, ops and OPS", titles).skippedStoplist).toBe(1);
    expect(match("Head of Sales", titles).skippedStoplist).toBe(0);
  });
});

describe("matchLinks: exclusion, ambiguity and limit", () => {
  it("never suggests an excluded page, and its span does not fall back to a shorter title", () => {
    const text = "Workflow Intelligence, then the Workflow.";
    expect(hits(text, PAGES, [WI])).toEqual([["Workflow", at(text, "Workflow.")]]);
  });

  it("excludes a page's aliases with it, and not in favour of the alias page", () => {
    expect(hits("Ask the OI team", PAGES, [OPS])).toEqual([]);
    expect(hits("Ask Ops Intel", PAGES, [OPS])).toEqual([]);
  });

  it("lists duplicate titles as ambiguous and leaves them out of applyLinks", () => {
    const text = "Sprint review for Workflow Intelligence";
    const result = match(text);
    expect(result.ambiguous).toEqual([
      {
        span: { start: 0, end: 6, line: 1, text: "Sprint" },
        candidates: [
          { uuid: SPRINT_A, title: "Sprint" },
          { uuid: SPRINT_B, title: "Sprint" },
        ],
      },
    ]);
    expect(applyLinks(text, result.suggestions)).toBe("Sprint review for [[Workflow Intelligence]]");
  });

  it("titles equal ignoring case are ambiguous", () => {
    const titles: KbTitlesPage[] = [
      [SPRINT_A, "Sprint", []],
      [SPRINT_B, "SPRINT", []],
    ];
    expect(match("sprint", titles).ambiguous[0].candidates.map((c) => c.uuid)).toEqual([SPRINT_A, SPRINT_B]);
  });

  it("an excluded duplicate leaves the other page as the suggestion", () => {
    expect(match("Sprint", PAGES, [SPRINT_A]).suggestions.map((s) => s.page.uuid)).toEqual([SPRINT_B]);
  });

  it("an ambiguous span is listed once", () => {
    expect(match("Sprint one, sprint two").ambiguous).toHaveLength(1);
  });

  it("returns at most limit suggestions in draft order and says when it truncated", () => {
    const text = "Head of Sales, Workflow Intelligence and Māori Health";
    const two = match(text, PAGES, [], 2);
    expect(two.suggestions.map((s) => s.page.title)).toEqual(["Head of Sales", "Workflow Intelligence"]);
    expect(two.truncated).toBe(true);
    expect(match(text, PAGES, [], 3).truncated).toBe(false);
  });

  it("a later mention of a page already suggested does not truncate", () => {
    const result = match("Head of Sales, Workflow Intelligence, Head of Sales", PAGES, [], 2);
    expect(result.truncated).toBe(false);
    expect(result.suggestions.map((s) => s.also_mentioned)).toEqual([1, 0]);
  });
});

describe("applyLinks", () => {
  it("replaces exactly the given spans, title matches with the stored title and aliases with the alias", () => {
    const text = "workflow intelligence: ask OI, then the Head of Sales.";
    const result = match(text);
    const linked = "[[Workflow Intelligence]]: ask [[OI]], then the [[Head of Sales]].";
    expect(applyLinks(text, result.suggestions)).toBe(linked);
    expect(applyLinks(text, [...result.suggestions].reverse())).toBe(linked);
    expect(applyLinks(text, [])).toBe(text);
  });
});

describe("resolvePageRef", () => {
  const titles: KbTitlesPage[] = [
    [WI, "Workflow Intelligence", []],
    [OPS, "Operational Intelligence", ["OI"]],
    [SPRINT_A, "Sprint", []],
    [SPRINT_B, "Sprint", []],
    [HOS, "Head of Sales", []],
    [MH, "head of sales", []],
    [WF, "Retro", []],
    [IST, "RETRO", []],
    ["6f1c0a2b-aaaa-4bbb-8ccc-ddddeeeeffff", "Hex Page", []],
  ];

  it("resolves a UUID, in either case", () => {
    expect(resolvePageRef(titles, WI)).toEqual({ uuid: WI });
    const hex = "6f1c0a2b-aaaa-4bbb-8ccc-ddddeeeeffff";
    expect(resolvePageRef(titles, hex.toUpperCase())).toEqual({ uuid: hex });
  });

  it("resolves an exact title before one equal ignoring case", () => {
    expect(resolvePageRef(titles, "Workflow Intelligence")).toEqual({ uuid: WI });
    expect(resolvePageRef(titles, "workflow intelligence")).toEqual({ uuid: WI });
    expect(resolvePageRef(titles, "head of sales")).toEqual({ uuid: MH });
    expect(resolvePageRef(titles, "Head of Sales")).toEqual({ uuid: HOS });
  });

  it("is ambiguous for a title two pages share, exactly or ignoring case", () => {
    expect(resolvePageRef(titles, "Sprint")).toEqual({ ambiguous: [titles[2], titles[3]] });
    expect(resolvePageRef(titles, "retro")).toEqual({ ambiguous: [titles[6], titles[7]] });
  });

  it("is null for an unknown page, an alias or an unknown UUID", () => {
    expect(resolvePageRef(titles, "Secret Plans")).toBeNull();
    expect(resolvePageRef(titles, "OI")).toBeNull();
    expect(resolvePageRef(titles, "00000000-0000-4000-8000-0000000000ff")).toBeNull();
  });
});

describe("matchLinks: cost is sized by the draft", () => {
  it("tokenises only titles whose first word is in the draft, with 20,000 titles", () => {
    const titles: KbTitlesPage[] = [];
    for (let i = 0; i < 20_000; i++) {
      titles.push([`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `Topic${i} Review`, []]);
    }
    const words: string[] = [];
    for (let i = 0; i < 200; i++) words.push(i % 10 === 0 ? `topic${i * 7}` : `word${i}`);
    const draft = words.join(" ") + " Topic70 Review";
    const draftWords = new Set(wordSpans(draft).map((s) => s.word));
    const bound = titles.filter(([, title]) => draftWords.has(wordSpans(title)[0].word)).length;
    const result = match(draft, titles);
    expect(bound).toBe(20);
    expect(result.tokenised).toBeGreaterThan(0);
    expect(result.tokenised).toBeLessThanOrEqual(bound);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Topic70 Review"]);
  });
});
