// suggest_links' pure matcher (spec 2026-11-08-suggest-links-existing-pages-design.md, sections
// 3.3 and 3.5). Every test calls the real functions on example pages; nothing is stubbed. Each mask
// and stoplist rule has a test with a decoy that only that rule keeps from matching, so deleting
// the rule fails a test (docs/solutions/testing/untested-rules-survive-mutation.md).
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { GraphStore } from "../src/graphs";
import { mcpHandler } from "../src/mcp";
import { DIMENSIONS } from "../src/semantic/config";
import { SemanticStore, initialState } from "../src/semantic/store";
import { SEMANTIC_HELP } from "../src/tools/semantic-search";
import { FakeVectorIndex, axis, unitAt } from "./semantic-fakes";
import { STOPWORDS, contentWords, wordSpans } from "../src/semantic/ranking";
import { CONNECTOR_HELP } from "../src/tools/handwritten";
import type { KbIndexEntry } from "../src/tools/kb-index";
import { annotationsFor } from "../src/tools/spec.mjs";
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
    expect([TEXT_LIMIT, DEFAULT_LIMIT, MAX_LIMIT, EXCLUDE_LIMIT]).toEqual([10_000, 25, 50, 50]);
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

  it("does not suggest a shorter title inside a longer match, so spans never overlap", () => {
    const INTEL = "00000000-0000-4000-8000-0000000000b1";
    const titles: KbTitlesPage[] = [...PAGES, [INTEL, "Intelligence", []]];
    const text = "Workflow Intelligence is live. Operational Intelligence too. Intelligence alone.";
    const result = match(text, titles);
    expect(result.suggestions.map((s) => [s.page.title, s.span.start])).toEqual([
      ["Workflow Intelligence", 0],
      ["Operational Intelligence", at(text, "Operational")],
      ["Intelligence", at(text, "Intelligence alone")],
    ]);
    const spans = result.suggestions.map((s) => s.span).sort((a, b) => a.start - b.start);
    for (let k = 1; k < spans.length; k++) expect(spans[k].start).toBeGreaterThanOrEqual(spans[k - 1].end);
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

describe("matchLinks: masks on an earlier line than a quote or property key (r1-tests-1)", () => {
  // maskRanges pushes quote and property-key ranges during its line scan and the inline ranges of
  // a segment only when that segment ends, so its ranges come out of order; the sort puts them right.
  it("keeps an inline range that comes before a quote line", () => {
    const text = "Run `Workflow Intelligence` now\n> a quote\nWorkflow Intelligence.";
    expect(maskRanges(text).ranges).toEqual([
      [4, 27],
      [32, 41],
    ]);
  });

  const inlineForms: [string, string][] = [
    ["inline code", "`Workflow Intelligence`"],
    ["a [[link]]", "[[Workflow Intelligence roadmap]]"],
    ["a scheme:// URL", "https://example.com/Workflow-Intelligence"],
    ["a {{macro}}", '{{query "Workflow Intelligence"}}'],
  ];
  const lineForms: [string, string][] = [
    ["a > quote line", "> a quote"],
    ["a property key", "status:: open"],
  ];
  for (const [inlineName, inline] of inlineForms) {
    for (const [lineName, line] of lineForms) {
      it(`masks ${inlineName} on a line before ${lineName}, and matches only outside both`, () => {
        const text = `Run ${inline} now\n${line}\nWorkflow Intelligence.`;
        expect(hits(text)).toEqual([["Workflow Intelligence", at(text, "Workflow Intelligence.")]]);
      });
    }
  }
});

describe("matchLinks: punctuation inside a title (r1-correctness-1)", () => {
  const NODE = "00000000-0000-4000-8000-0000000000e1";
  const MOTHERS = "00000000-0000-4000-8000-0000000000e2";
  const RD = "00000000-0000-4000-8000-0000000000e3";
  const Q3Q4 = "00000000-0000-4000-8000-0000000000e4";
  const APOLLO = "00000000-0000-4000-8000-0000000000e5";
  const TITLES: KbTitlesPage[] = [
    [NODE, "Node.js", []],
    [MOTHERS, "Mother's Day", []],
    [RD, "R&D Budget", []],
    [Q3Q4, "Q3/Q4 Planning", []],
    [APOLLO, "Project: Apollo", []],
  ];

  it("matches each title's own wording, ignoring case", () => {
    for (const [title, text] of [
      ["Node.js", "We moved to Node.js today."],
      ["Node.js", "We moved to NODE.JS today."],
      ["Mother's Day", "Plan for Mother's Day."],
      ["R&D Budget", "The R&D Budget was cut."],
      ["Q3/Q4 Planning", "Q3/Q4 Planning starts"],
      ["Project: Apollo", "See project: apollo for more."],
    ]) {
      const start = text.toLowerCase().indexOf(title.toLowerCase());
      expect(hits(text, TITLES), text).toEqual([[title, start]]);
    }
    const text = "Plan for Mother's Day.";
    expect(applyLinks(text, match(text, TITLES).suggestions)).toBe("Plan for [[Mother's Day]].");
  });

  it("does not match a spelling with other separators in place of the title's punctuation", () => {
    for (const text of [
      "node js is fast",
      "node-js is fast",
      "Plan for Mother Day.",
      "Plan for Mother’s Day.",
      "The R D budget was cut.",
      "The R-D Budget was cut.",
      "Q3 Q4 Planning starts",
      "Q3-Q4 Planning starts",
      "See project apollo for more.",
      "See project:apollo for more.",
    ]) {
      expect(hits(text, TITLES), text).toEqual([]);
    }
  });

  it("keeps a title's spaces and hyphens interchangeable around its punctuation", () => {
    const text = "The R&D-Budget was cut.";
    expect(hits(text, TITLES)).toEqual([["R&D Budget", at(text, "R&D")]]);
  });

  it("titles with the same words but different punctuation are different pages, not ambiguous", () => {
    const NODE_JS = "00000000-0000-4000-8000-0000000000e6";
    const titles: KbTitlesPage[] = [...TITLES, [NODE_JS, "Node JS", []]];
    const text = "Node.js and Node JS";
    const result = match(text, titles);
    expect(result.ambiguous).toEqual([]);
    expect(result.suggestions.map((s) => [s.page.title, s.span.start])).toEqual([
      ["Node.js", 0],
      ["Node JS", at(text, "Node JS")],
    ]);
    // The same punctuation in another case is the same title, so two such pages are ambiguous.
    const twin: KbTitlesPage[] = [...TITLES, ["00000000-0000-4000-8000-0000000000e7", "node.JS", []]];
    expect(match("We use Node.js.", twin).ambiguous.map((a) => a.candidates.map((c) => c.title))).toEqual([["Node.js", "node.JS"]]);
  });

  it("counts a [[link]] to a punctuated title as already linked", () => {
    const result = match("See [[node.js]], then Node.js again.", TITLES);
    expect(result.alreadyLinked).toEqual(["Node.js"]);
    expect(result.suggestions).toEqual([]);
  });
});

describe("matchLinks: words joined into an address, domain or path (r1-correctness-2, r1-integrity-1)", () => {
  const ACME = "00000000-0000-4000-8000-0000000000f1";
  const TITLES: KbTitlesPage[] = [
    [ACME, "Acme", []],
    ["00000000-0000-4000-8000-0000000000f2", "React", []],
    ["00000000-0000-4000-8000-0000000000f3", "GitHub", []],
    ["00000000-0000-4000-8000-0000000000f4", "Workflow", []],
    ["00000000-0000-4000-8000-0000000000f5", "Kubernetes", []],
    ["00000000-0000-4000-8000-0000000000f6", "Head of Sales", []],
  ];
  // The decoy comes first; the same title then matches on its own, so only the rule stops the decoy.
  const cases: [string, string, string][] = [
    ["an email address", "Email jane@acme.com about it, then Acme.", "Acme."],
    ["an email address's local part", "Email acme@example.com about it, then Acme.", "Acme."],
    ["a mailto: address", "Write to mailto:sales@acme.com or Acme.", "Acme."],
    ["a bare domain", "See acme.com for Acme.", "Acme."],
    ["a bare domain with a path", "See acme.com/pricing for Acme.", "Acme."],
    ["a hyphenated bare domain", "See acme-corp.com for Acme.", "Acme."],
    ["a subdomain", "See docs.acme.io for Acme.", "Acme."],
    ["a domain's later part", "Repo github.com/example/react and React.", "React."],
    ["a home path", "Run it in ~/code/react, then React.", "React."],
    ["a relative path", "Edit .github/workflows/workflow.yml for the Workflow.", "Workflow."],
    ["a path's first part", "Run kubernetes/deploy.sh on Kubernetes.", "Kubernetes."],
    ["a Windows path", "Open C:\\Users\\acme\\notes for Acme.", "Acme."],
    ["a file name", "Open workflow.yml for the Workflow.", "Workflow."],
    ["an identifier with _", "Set acme_api_key for Acme.", "Acme."],
    ["a multi-word title in a path", "See /teams/head of sales/plan for the Head of Sales.", "Head of Sales."],
    ["double-backtick inline code", "Use ``code with `Acme` inside`` here, then Acme.", "Acme."],
  ];
  for (const [name, text, outside] of cases) {
    it(`does not match inside ${name}`, () => {
      expect(hits(text, TITLES)).toEqual([[outside.replace(/\.$/, ""), at(text, outside)]]);
    });
  }

  it("still matches next to sentence punctuation, brackets, quotes and a possessive", () => {
    for (const text of [
      "Talk to Acme.",
      "Talk to Acme, then",
      "Talk to (Acme) now",
      "Talk to “Acme” now",
      "Talk to Acme's team",
      "Talk to Acme: now",
      "Talk to Acme... now",
      "Talk to **Acme** now",
      "Acme",
    ]) {
      expect(hits(text, TITLES), text).toEqual([["Acme", at(text, "Acme")]]);
    }
  });

  it("linked_text leaves the address, domain and path whole", () => {
    const text = "Email jane@acme.com, see acme.com/pricing and ~/code/react; Acme and React.";
    expect(applyLinks(text, match(text, TITLES).suggestions)).toBe(
      "Email jane@acme.com, see acme.com/pricing and ~/code/react; [[Acme]] and [[React]].",
    );
  });

  it("masks double-backtick inline code as one range", () => {
    expect(maskRanges("Use ``code with `Acme` inside`` here").ranges).toEqual([[4, 31]]);
    expect(maskRanges("a `b` c").ranges).toEqual([[2, 5]]);
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

  it("lists a page once when it is linked by title, in another case and by alias", () => {
    const text = "[[Workflow Intelligence]] and [[workflow intelligence]]. Ask [[OI]] or [[Operational Intelligence]].";
    const result = match(text);
    expect(result.alreadyLinked).toEqual(["Workflow Intelligence", "Operational Intelligence"]);
    expect(match("[[Ops Intel]] then [[oi]] then [[OPERATIONAL INTELLIGENCE]]").alreadyLinked).toEqual([
      "Operational Intelligence",
    ]);
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

describe("matchLinks: cost is bounded by the draft's word pairs (r1-light-1)", () => {
  it("tokenises a multi-word title only when its first two words are next to each other in the draft", () => {
    const titles: KbTitlesPage[] = [];
    for (let i = 0; i < 20_000; i++) {
      titles.push([`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, `Review Topic${i}`, []]);
    }
    // Every title starts with a draft word, but only one has its first two words side by side.
    const draft = "Review the plan. We review the topic7 notes, and Topic9 later. Review Topic70 today.";
    const result = match(draft, titles);
    expect(result.tokenised).toBe(1);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Review Topic70"]);
  });

  it("does not count a pair across a masked range, and counts a pair inside a [[link]] for already_linked", () => {
    const titles: KbTitlesPage[] = [
      ["00000000-0000-4000-8000-0000000000c1", "Launch Plan", []],
      ["00000000-0000-4000-8000-0000000000c2", "Launch Review", []],
    ];
    const result = match("Launch `x` Plan, and see [[Launch Review]].", titles);
    expect(result.tokenised).toBe(1);
    expect(result.alreadyLinked).toEqual(["Launch Review"]);
    expect(result.suggestions).toEqual([]);
  });

  it("checks a non-ASCII title's first two words by tokenising it, and still matches it", () => {
    const titles: KbTitlesPage[] = [
      ["00000000-0000-4000-8000-0000000000c3", "Māori Health", []],
      ["00000000-0000-4000-8000-0000000000c4", "Māori Language", []],
      ["00000000-0000-4000-8000-0000000000c5", "Ōtautahi Office", []],
    ];
    const result = match("Māori health and language.", titles);
    // The two Māori titles start with a draft word, so both are tokenised; Ōtautahi Office is not.
    expect(result.tokenised).toBe(2);
    expect(result.suggestions.map((s) => s.page.title)).toEqual(["Māori Health"]);
  });
});

// The tool through the MCP server, as kb-index.test.ts drives kb_index: real KV, real D1, the real
// matcher and kb-index cache. Only the SYNC binding is faked, at HTTP level, answering
// listKnowledgeIndex and getBlocks view=signals as patches 0013, 0035 and 0036 do.
describe("suggest_links tool", () => {
  const ORIGIN = "https://mcp.example.com";
  const WORK_ID = "11111111-1111-1111-1111-111111111111";
  const SECRET = "00000000-0000-4000-8000-0000000000ff";

  function indexEntry([uuid, title, aliases]: KbTitlesPage, tags: string[] = []): KbIndexEntry {
    return {
      uuid,
      title,
      tags: tags.map((t) => ({ uuid: `tag-${t}`, title: t })),
      classes: tags,
      "reference-count": 1,
      aliases,
    };
  }
  /** The index the server holds; Secret Plans is tagged private, so exclude-tags=private leaves it out. */
  const INDEX: { entry: KbIndexEntry; private: boolean }[] = [
    ...PAGES.map((p) => ({ entry: indexEntry(p), private: false })),
    { entry: indexEntry([SECRET, "Secret Plans", []], ["private"]), private: true },
  ];

  type SyncHandler = (request: Request) => Response | Promise<Response>;
  let requests: Request[];
  let stale: Set<string>;
  let indexHandler: SyncHandler;
  let blocksHandler: SyncHandler;
  let kvCounts: { get: number; put: number; keysPut: string[] };
  let spies: MockInstance[];
  /** Semantic search on: AI, VECTORIZE and the cap are bound, backed by these fakes. */
  let semanticOn: boolean;
  let aiRuns: string[][];
  let aiFails: Error | null;
  let vectors: RecordingIndex;
  /** Every SQL statement the request prepared. */
  let statements: string[];

  class RecordingIndex extends FakeVectorIndex {
    options: (VectorizeQueryOptions | undefined)[] = [];
    override async query(vector: VectorFloatArray | number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches> {
      this.options.push(options);
      return super.query(vector, options);
    }
  }

  const serveIndex: SyncHandler = (request) => {
    const url = new URL(request.url);
    const excluded = url.searchParams.get("exclude-tags") === "private";
    const pages = INDEX.filter((p) => !(excluded && p.private)).map((p) => p.entry);
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const next = start + 200;
    return Response.json({ pages: pages.slice(start, next), ...(next < pages.length ? { "next-cursor": String(next) } : {}) });
  };
  const serveSignals: SyncHandler = (request) => {
    const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",");
    return Response.json({
      blocks: ids
        .filter((id) => !stale.has(id))
        .map((uuid) => ({ uuid, "updated-at": 1, "reference-count": 1, status: null, "property-values": null })),
      missing: ids.filter((id) => stale.has(id)),
    });
  };

  function testEnv(): Env {
    const sync = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        const path = new URL(request.url).pathname;
        if (path.endsWith("/knowledge-index")) return indexHandler(request);
        if (path.endsWith("/blocks")) return blocksHandler(request);
        return Response.json({ error: `unexpected ${request.method} ${path}` }, { status: 500 });
      },
    } as unknown as Fetcher;
    const kv = env.KB_INDEX_KV;
    const counted = {
      get: (...args: unknown[]) => {
        kvCounts.get++;
        return (kv.get as (...a: unknown[]) => unknown)(...args);
      },
      put: (key: string, ...rest: unknown[]) => {
        kvCounts.put++;
        kvCounts.keysPut.push(key);
        return (kv.put as (...a: unknown[]) => unknown)(key, ...rest);
      },
      list: (...args: unknown[]) => (kv.list as (...a: unknown[]) => unknown)(...args),
      delete: (key: string) => kv.delete(key),
    } as unknown as KVNamespace;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => (statements.push(sql), target.prepare(sql));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ai = {
      run: async (_model: string, input: { text: string[] }) => {
        if (aiFails) throw aiFails;
        aiRuns.push(input.text);
        // Every draft embeds to axis 0, so a block stored at unitAt(cos) scores exactly cos.
        return { shape: [input.text.length, DIMENSIONS], data: input.text.map(() => axis(0)) };
      },
    } as unknown as Ai;
    const semantic = semanticOn ? { AI: ai, VECTORIZE: vectors as unknown as Vectorize, SEMANTIC_MAX_VECTORS: "10000" } : {};
    return { ...env, SYNC: sync, KB_INDEX_KV: counted, DB: db, ...semantic } as Env;
  }

  async function rpc(method: string, params: unknown): Promise<any> {
    const request = new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const e = testEnv();
    const ctx = createExecutionContext();
    const res = await mcpHandler(e, ctx)(request, e, ctx);
    await waitOnExecutionContext(ctx);
    const text = await res.text();
    const json = res.headers.get("Content-Type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((msg) => msg.id === 1)
      : JSON.parse(text);
    expect(json.error).toBeUndefined();
    return json.result;
  }

  async function suggest(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const result = await rpc("tools/call", { name: "suggest_links", arguments: { graph: "work", ...args } });
    return { isError: result.isError === true, text: result.content.map((c: { text: string }) => c.text).join("\n") };
  }

  /** The summary line and the JSON after it. */
  async function suggestOk(args: Record<string, unknown>): Promise<{ summary: string; body: any }> {
    const { isError, text } = await suggest(args);
    expect(isError, text).toBe(false);
    const nl = text.indexOf("\n");
    return { summary: text.slice(0, nl), body: JSON.parse(text.slice(nl + 1)) };
  }

  /** Builds the cache with one call, then forgets that call's requests and KV counts. */
  async function warm(): Promise<void> {
    await suggestOk({ text: "nothing to link here" });
    reset();
  }

  function reset(): void {
    requests = [];
    kvCounts = { get: 0, put: 0, keysPut: [] };
    aiRuns = [];
    statements = [];
    vectors.queries = 0;
    vectors.options = [];
  }

  const blockCalls = () => requests.filter((r) => new URL(r.url).pathname.endsWith("/blocks"));
  const idsOf = (r: Request) => new URL(r.url).searchParams.get("ids")!.split(",");

  beforeEach(async () => {
    await env.DB.exec("DELETE FROM graphs");
    await env.DB.exec("DELETE FROM audit_log");
    const { keys } = await env.KB_INDEX_KV.list();
    await Promise.all(keys.map((k) => env.KB_INDEX_KV.delete(k.name)));
    await new GraphStore(env.DB, env.GRAPH_TOKEN_KEY).add({
      alias: "work",
      graphId: WORK_ID,
      graphName: "work",
      mode: "write",
      permission: "both",
      expiresAt: null,
      token: "logseq_pat_workToken123",
    });
    await env.DB.exec("DELETE FROM semantic_blocks");
    await env.DB.exec("DELETE FROM semantic_state");
    semanticOn = false;
    aiFails = null;
    vectors = new RecordingIndex();
    stale = new Set();
    indexHandler = serveIndex;
    blocksHandler = serveSignals;
    reset();
    spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it("warm cache, no suggestions: 0 sync calls and 2 KV reads", async () => {
    await warm();
    const { summary, body } = await suggestOk({ text: "A note about the weather." });
    expect(requests).toEqual([]);
    expect(kvCounts).toEqual({ get: 2, put: 0, keysPut: [] });
    expect(summary).toMatch(/^0 link suggestions for graph "work" \(index built \d\d:\d\d UTC, just now\); 0 already linked; 0 dropped as stale$/);
    expect(body.suggestions).toEqual([]);
    expect(body.linked_text).toBe("A note about the weather.");
  });

  it("warm cache, suggestions: exactly 1 getBlocks view=signals call, and every spec 3.7 key", async () => {
    await warm();
    const text = "Notes on Workflow Intelligence.\nAsk OI and [[Head of Sales]] about workflow intelligence.";
    const { summary, body } = await suggestOk({ text });
    expect(requests).toHaveLength(1);
    const [call] = requests;
    const url = new URL(call.url);
    expect(call.method).toBe("GET");
    expect(url.pathname).toBe(`/api/v1/graphs/${WORK_ID}/blocks`);
    expect(url.searchParams.get("view")).toBe("signals");
    expect(idsOf(call)).toEqual([WI, OPS]);
    expect(kvCounts).toEqual({ get: 2, put: 0, keysPut: [] });

    expect(Object.keys(body).sort()).toEqual(
      [
        "graph",
        "index_built_at",
        "suggestions",
        "ambiguous",
        "related",
        "already_linked",
        "dropped_stale",
        "skipped_stoplist",
        "truncated",
        "linked_text",
      ].sort(),
    );
    expect(body.graph).toBe("work");
    expect(body.index_built_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(body.suggestions).toEqual([
      {
        span: { start: at(text, "Workflow Intelligence"), end: at(text, "Workflow Intelligence") + 21, line: 1, text: "Workflow Intelligence" },
        page: { uuid: WI, title: "Workflow Intelligence" },
        link: "[[Workflow Intelligence]]",
        reason: "title",
        also_mentioned: 1,
      },
      {
        span: { start: at(text, "OI"), end: at(text, "OI") + 2, line: 2, text: "OI" },
        page: { uuid: OPS, title: "Operational Intelligence" },
        link: "[[OI]]",
        reason: "alias ‘OI’ of Operational Intelligence",
        also_mentioned: 0,
      },
    ]);
    expect(body.ambiguous).toEqual([]);
    expect(body.related).toEqual([]);
    expect(body.already_linked).toEqual(["Head of Sales"]);
    expect(body.dropped_stale).toEqual([]);
    expect(body.skipped_stoplist).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.linked_text).toBe(
      "Notes on [[Workflow Intelligence]].\nAsk [[OI]] and [[Head of Sales]] about workflow intelligence.",
    );
    expect(summary).toMatch(/^2 link suggestions for graph "work" \(index built \d\d:\d\d UTC, just now\); 1 already linked; 0 dropped as stale$/);
  });

  it("is read-only: only knowledge-index and getBlocks GETs, no dirty mark, no audit row, READ annotations", async () => {
    // Cold: the rebuild kb_index does, then the verify read.
    const { body } = await suggestOk({ text: "Workflow Intelligence and Māori Health." });
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([WI, MH]);
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      `GET /api/v1/graphs/${WORK_ID}/knowledge-index`,
      `GET /api/v1/graphs/${WORK_ID}/blocks`,
    ]);
    expect(kvCounts.keysPut.sort()).toEqual(["kb-index-titles:work", "kb-index:work"]);
    expect(await env.KB_INDEX_KV.get("kb-index-dirty:work")).toBeNull();
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").all<{ n: number }>();
    expect(results[0].n).toBe(0);
    expect(annotationsFor("suggest_links")).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const tools = (await rpc("tools/list", {})).tools;
    const tool = tools.find((t: { name: string }) => t.name === "suggest_links");
    expect(tool.annotations).toEqual(annotationsFor("suggest_links"));
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["exclude", "graph", "limit", "page", "text", "verify"]);
  });

  it("verify drops a page getBlocks lists as missing from suggestions and linked_text, into dropped_stale", async () => {
    await warm();
    stale = new Set([WI]);
    const text = "Workflow Intelligence met Head of Sales.";
    const { summary, body } = await suggestOk({ text });
    expect(blockCalls()).toHaveLength(1);
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([HOS]);
    expect(body.dropped_stale).toEqual([{ uuid: WI, title: "Workflow Intelligence" }]);
    expect(body.linked_text).toBe("Workflow Intelligence met [[Head of Sales]].");
    expect(summary).toMatch(/; 1 dropped as stale$/);
  });

  it("verify treats a UUID absent from blocks as stale even when missing does not list it", async () => {
    await warm();
    blocksHandler = () => Response.json({ blocks: [], missing: [] });
    const { body } = await suggestOk({ text: "Workflow Intelligence." });
    expect(body.suggestions).toEqual([]);
    expect(body.dropped_stale).toEqual([{ uuid: WI, title: "Workflow Intelligence" }]);
    expect(body.linked_text).toBe("Workflow Intelligence.");
  });

  it("limit with a stale page: verify runs on the limited suggestions only and does not promote the next", async () => {
    await warm();
    stale = new Set([WI]);
    const text = "Workflow Intelligence, Head of Sales and Māori Health.";
    const { body } = await suggestOk({ text, limit: 2 });
    expect(blockCalls()).toHaveLength(1);
    expect(idsOf(blockCalls()[0])).toEqual([WI, HOS]);
    expect(body.truncated).toBe(true);
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([HOS]);
    expect(body.dropped_stale).toEqual([{ uuid: WI, title: "Workflow Intelligence" }]);
    expect(body.linked_text).toBe("Workflow Intelligence, [[Head of Sales]] and Māori Health.");
  });

  it("a failed verify fails the call, naming getBlocks and the reason", async () => {
    await warm();
    blocksHandler = () => Response.json({ error: "boom" }, { status: 500 });
    const failed = await suggest({ text: "Workflow Intelligence." });
    expect(failed.isError).toBe(true);
    expect(failed.text).toBe("verify: getBlocks failed: sync server error (HTTP 500): boom");

    blocksHandler = () => Response.json({ nothing: true });
    const shapeless = await suggest({ text: "Workflow Intelligence." });
    expect(shapeless.isError).toBe(true);
    expect(shapeless.text).toBe("verify: getBlocks failed: getBlocks returned no blocks array");
  });

  it("verify: false makes no getBlocks call and the summary says the UUIDs are unverified", async () => {
    await warm();
    stale = new Set([WI]);
    const { summary, body } = await suggestOk({ text: "Workflow Intelligence.", verify: false });
    expect(requests).toEqual([]);
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([WI]);
    expect(body.dropped_stale).toEqual([]);
    expect(summary).toMatch(/; not verified \(verify: false\): the UUIDs come from the index built just now$/);
  });

  it("never suggests a page tagged private, which the index leaves out", async () => {
    const { body } = await suggestOk({ text: "The Secret Plans for Workflow Intelligence." });
    for (const r of requests.filter((r) => new URL(r.url).pathname.endsWith("/knowledge-index"))) {
      expect(new URL(r.url).searchParams.get("exclude-tags")).toBe("private");
    }
    expect(body.suggestions.map((s: any) => s.page.title)).toEqual(["Workflow Intelligence"]);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(idsOf(blockCalls()[0])).toEqual([WI]);
  });

  it("page excludes the page being written, named by UUID (either case), title or title ignoring case", async () => {
    await warm();
    const text = "Workflow Intelligence and Head of Sales.";
    for (const page of [WI, WI.toUpperCase(), "Workflow Intelligence", "workflow intelligence"]) {
      const { summary, body } = await suggestOk({ text, page });
      expect(body.suggestions.map((s: any) => s.page.uuid), page).toEqual([HOS]);
      expect(summary, page).not.toContain("page:");
    }
  });

  it("page shared by two pages is refused naming both UUIDs; the UUID of one excludes only that one", async () => {
    await warm();
    const refused = await suggest({ text: "Sprint review.", page: "sprint" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(`page: 2 pages are titled ‘sprint’ (Sprint ${SPRINT_A}, Sprint ${SPRINT_B}); pass the UUID`);
    expect(requests).toEqual([]);

    const { body } = await suggestOk({ text: "Sprint review.", page: SPRINT_A });
    expect(body.ambiguous).toEqual([]);
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([SPRINT_B]);
  });

  it("an exact title wins over a title equal only ignoring case, so it is not refused", async () => {
    const lower = "00000000-0000-4000-8000-0000000000ee";
    INDEX.push({ entry: indexEntry([lower, "head of sales", []]), private: false });
    try {
      const { body } = await suggestOk({ text: "Head of Sales and Workflow Intelligence.", page: "Head of Sales" });
      // Head of Sales is excluded, so the other page with that title is no longer ambiguous.
      expect(body.ambiguous).toEqual([]);
      expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([lower, WI]);
    } finally {
      INDEX.pop();
    }
  });

  it("a page or exclude entry naming no index page is a note, not an error", async () => {
    await warm();
    // An alias, a journal date, a bare integer and an unknown title or UUID are not index pages.
    for (const page of ["2026-11-08", "42", "New Page", "00000000-0000-4000-8000-0000000000aa"]) {
      const { summary, body } = await suggestOk({ text: "Workflow Intelligence.", page });
      expect(body.suggestions.map((s: any) => s.page.uuid), page).toEqual([WI]);
      expect(summary, page).toContain(
        `; page: no page ‘${page}’ in the index (journals and pages tagged private are not in it); nothing was excluded`,
      );
    }
    const { summary, body } = await suggestOk({ text: "Workflow Intelligence.", exclude: ["Nowhere", WI] });
    expect(body.suggestions).toEqual([]);
    expect(summary).toContain("; exclude: no page ‘Nowhere’ in the index");
  });

  it("page names a page by its own title, not an alias: the alias page Ops Intel leaves its target suggested", async () => {
    await warm();
    const { summary, body } = await suggestOk({ text: "Operational Intelligence.", page: "Ops Intel" });
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([OPS]);
    expect(summary).not.toContain("page:");
  });

  it("exclude takes UUIDs and titles, in any order, and an ambiguous title is refused", async () => {
    await warm();
    const text = "Workflow Intelligence, Head of Sales and Māori Health.";
    const forward = await suggestOk({ text, exclude: [WI, "head of sales"] });
    const reversed = await suggestOk({ text, exclude: ["head of sales", WI] });
    expect(forward.body.suggestions.map((s: any) => s.page.uuid)).toEqual([MH]);
    expect(reversed.body).toEqual(forward.body);
    // A repeated entry is a no-op, not a refusal.
    const repeated = await suggestOk({ text, exclude: [WI, WI, "Workflow Intelligence"] });
    expect(repeated.body.suggestions.map((s: any) => s.page.uuid)).toEqual([HOS, MH]);

    const refused = await suggest({ text, exclude: [WI, "Sprint"] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(`exclude[1]: 2 pages are titled ‘Sprint’ (Sprint ${SPRINT_A}, Sprint ${SPRINT_B}); pass the UUID`);
  });

  it("text over the limit is refused before any KV or sync call; the limit itself is accepted", async () => {
    const refused = await suggest({ text: "x".repeat(TEXT_LIMIT + 1) });
    expect(refused).toEqual({ isError: true, text: "text: 10,001 characters is over the 10,000 limit" });
    expect(requests).toEqual([]);
    expect(kvCounts.get + kvCounts.put).toBe(0);

    const big = await suggest({ text: "Workflow Intelligence ".repeat(1000).slice(0, TEXT_LIMIT) });
    expect(big.isError, big.text).toBe(false);
  });

  it("more exclude entries than the limit are refused before any KV or sync call; the limit itself is accepted", async () => {
    const many = Array.from({ length: EXCLUDE_LIMIT + 1 }, (_, i) => `Page ${i}`);
    const refused = await suggest({ text: "Workflow Intelligence.", exclude: many });
    expect(refused).toEqual({ isError: true, text: "exclude: 51 entries is over the 50 limit" });
    expect(requests).toEqual([]);
    expect(kvCounts.get + kvCounts.put).toBe(0);

    const { body } = await suggestOk({ text: "Workflow Intelligence.", exclude: many.slice(0, EXCLUDE_LIMIT) });
    expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([WI]);
  });

  it("an E2EE graph's 409 gives the readable error", async () => {
    indexHandler = () => Response.json({ error: "graph insights are unavailable for E2EE graphs" }, { status: 409 });
    const result = await suggest({ text: "Workflow Intelligence." });
    expect(result).toEqual({
      isError: true,
      text: "suggest_links needs the knowledge index, which is unavailable for E2EE graphs",
    });
    expect(blockCalls()).toEqual([]);
  });

  it("the knowledge index's too-large refusal is unchanged", async () => {
    indexHandler = () => Response.json({ pages: [], "next-cursor": "more" });
    const result = await suggest({ text: "Workflow Intelligence." });
    expect(result).toEqual({ isError: true, text: "the knowledge index of 'work' has more than 20000 pages" });
    expect(blockCalls()).toEqual([]);
  });

  it("an ambiguous-only draft makes no getBlocks call and leaves linked_text as the draft", async () => {
    await warm();
    const text = "Sprint planning on Monday.";
    const { body } = await suggestOk({ text });
    expect(requests).toEqual([]);
    expect(body.suggestions).toEqual([]);
    expect(body.ambiguous).toEqual([
      {
        span: { start: 0, end: 6, line: 1, text: "Sprint" },
        candidates: [
          { uuid: SPRINT_A, title: "Sprint" },
          { uuid: SPRINT_B, title: "Sprint" },
        ],
      },
    ]);
    expect(body.linked_text).toBe(text);
  });

  it("the description and help name the limits from the constants", async () => {
    const tools = (await rpc("tools/list", {})).tools;
    const tool = tools.find((t: { name: string }) => t.name === "suggest_links");
    const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    expect(tool.description).toContain(`${thousands(TEXT_LIMIT)} characters`);
    expect(tool.description).toContain(`at most ${MAX_LIMIT}`);
    expect(tool.description).toContain(`default ${DEFAULT_LIMIT}`);
    expect(tool.description).toContain(`up to ${EXCLUDE_LIMIT}`);
    expect(tool.description).toMatch(/read-only/i);
    expect(tool.inputSchema.properties.limit.maximum).toBe(MAX_LIMIT);
    expect(CONNECTOR_HELP).toContain("suggest_links");
    const help = (await rpc("tools/call", { name: "connector_help", arguments: {} })).content[0].text;
    expect(help).toContain("call suggest_links");
  });

  describe("related: true (spec 3.6)", () => {
    const JOURNAL = "00000000-0000-4000-8000-0000000000aa";
    let hit = 0;

    /** One indexed block on `page`, stored in D1 and in the fake index at similarity `cos` to any draft. */
    async function indexed(page: string, cos: number, title = "x"): Promise<string> {
      hit += 1;
      const vectorId = `v-${hit}`;
      const uuid = `00000000-0000-4000-9000-${hit.toString(16).padStart(12, "0")}`;
      const store = new SemanticStore(env.DB);
      // The indexer leases a graph, creating its state row, before it writes any block.
      if (!(await store.state(WORK_ID))) await store.lease(WORK_ID, 0, 0);
      await store.commit({
        upserts: [{ vectorId, uuid, pageId: page, pageTitle: title, breadcrumb: [], text: "t", tags: [], document: "t", hash: "h", private: false }],
        deleteVectorIds: [],
        state: initialState(WORK_ID),
      });
      await vectors.upsert([{ id: vectorId, values: unitAt(cos), namespace: WORK_ID }]);
      return vectorId;
    }

    const relatedOf = (body: any) => body.related.map((r: any) => [r.page.title, r.similarity]);
    const semanticReads = () => statements.filter((sql) => sql.includes("semantic_"));

    beforeEach(() => {
      semanticOn = true;
    });

    it("costs exactly 1 embedding, 1 Vectorize query (topK 20, no values or metadata) and 1 blocksFor read", async () => {
      await indexed(HOS, 0.9);
      await warm();
      const { body } = await suggestOk({ text: "A note about hiring.", related: true });
      expect(aiRuns).toHaveLength(1);
      expect(vectors.queries).toBe(1);
      expect(vectors.options).toEqual([{ topK: RELATED_TOP_K, namespace: WORK_ID }]);
      expect(semanticReads()).toHaveLength(1);
      expect(semanticReads()[0]).toContain("FROM semantic_blocks");
      expect(relatedOf(body)).toEqual([["Head of Sales", 0.9]]);
      expect(body.related[0]).toEqual({ page: { uuid: HOS, title: "Head of Sales" }, similarity: 0.9, reason: "related by meaning" });
    });

    it("returns at most 5 pages, best similarity first, all in the index: none suggested, journal or private", async () => {
      await indexed(WI, 0.99); // suggested by the draft
      await indexed(JOURNAL, 0.98); // a journal block: not in the titles key
      await indexed(SECRET, 0.97); // a page tagged private: not in the titles key
      await indexed(HOS, 0.6);
      await indexed(HOS, 0.95); // the page's best block wins
      await indexed(MH, 0.94);
      await indexed(IST, 0.93);
      await indexed(OPS, 0.92);
      await indexed(OPS_INTEL, 0.91);
      await indexed(OI_PAGE, 0.5);
      await indexed(WF, 0.4);
      await warm();
      const { summary, body } = await suggestOk({ text: "Notes on Workflow Intelligence.", related: true });
      expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([WI]);
      expect(relatedOf(body)).toEqual([
        ["Head of Sales", 0.95],
        ["Māori Health", 0.94],
        ["İstanbul Office", 0.93],
        ["Operational Intelligence", 0.92],
        ["Ops Intel", 0.91],
      ]);
      expect(body.related).toHaveLength(RELATED_LIMIT);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body)).not.toContain(JOURNAL);
      expect(body.linked_text).toBe("Notes on [[Workflow Intelligence]].");
      expect(summary).toMatch(/; 5 related$/);
    });

    it("lists a page once, with its best block's similarity, however many of its blocks are near", async () => {
      await indexed(HOS, 0.9);
      await indexed(HOS, 0.8);
      await indexed(MH, 0.7);
      await indexed(HOS, 0.6);
      await warm();
      const { body } = await suggestOk({ text: "A note about hiring.", related: true });
      expect(relatedOf(body)).toEqual([
        ["Head of Sales", 0.9],
        ["Māori Health", 0.7],
      ]);
    });

    it("leaves out pages already linked, excluded, the page being written and ambiguous, so the next ones fill in", async () => {
      await indexed(HOS, 0.99); // already linked
      await indexed(MH, 0.98); // excluded
      await indexed(IST, 0.97); // the page being written
      await indexed(SPRINT_A, 0.96); // ambiguous in the draft
      await indexed(OPS, 0.5);
      await warm();
      const text = "Ask [[Head of Sales]] about the Sprint.";
      const { body } = await suggestOk({ text, related: true, exclude: ["Māori Health"], page: IST });
      expect(body.ambiguous).toHaveLength(1);
      expect(relatedOf(body)).toEqual([["Operational Intelligence", 0.5]]);
    });

    it("embeds the draft with masked ranges removed, at most 2,000 characters", async () => {
      await warm();
      const text =
        "```\ncodeword\n```\nSee [[Head of Sales]] and `inlineword` at https://example.com/urlword.\n" +
        "plain ".repeat(400) +
        "tailword";
      await suggestOk({ text, related: true });
      expect(aiRuns).toHaveLength(1);
      const [embedded] = aiRuns[0];
      expect(aiRuns[0]).toHaveLength(1);
      expect(embedded.length).toBeLessThanOrEqual(RELATED_TEXT_CHARS);
      expect(embedded).toContain("plain");
      for (const masked of ["codeword", "Head of Sales", "inlineword", "urlword"]) expect(embedded).not.toContain(masked);
      expect(embedded).not.toContain("tailword");
    });

    it("a draft that is all masks embeds nothing and returns no related pages", async () => {
      await indexed(HOS, 0.9);
      await warm();
      const { body } = await suggestOk({ text: "[[Workflow Intelligence]] `code`", related: true });
      expect(aiRuns).toEqual([]);
      expect(vectors.queries).toBe(0);
      expect(semanticReads()).toEqual([]);
      expect(body.related).toEqual([]);
    });

    it("verifies related pages in the same single getBlocks call, and moves a stale one to dropped_stale", async () => {
      await indexed(HOS, 0.9);
      await indexed(MH, 0.8);
      await warm();
      stale = new Set([MH]);
      const { body } = await suggestOk({ text: "Notes on Workflow Intelligence.", related: true });
      expect(requests).toHaveLength(1);
      expect(idsOf(blockCalls()[0])).toEqual([WI, HOS, MH]);
      expect(relatedOf(body)).toEqual([["Head of Sales", 0.9]]);
      expect(body.dropped_stale).toEqual([{ uuid: MH, title: "Māori Health" }]);
      expect(body.linked_text).toBe("Notes on [[Workflow Intelligence]].");
    });

    it("verifies related pages when there is no suggestion, and verify: false reads nothing back", async () => {
      await indexed(HOS, 0.9);
      await warm();
      stale = new Set([HOS]);
      const verified = await suggestOk({ text: "A note about hiring.", related: true });
      expect(blockCalls()).toHaveLength(1);
      expect(idsOf(blockCalls()[0])).toEqual([HOS]);
      expect(verified.body.related).toEqual([]);
      expect(verified.body.dropped_stale).toEqual([{ uuid: HOS, title: "Head of Sales" }]);

      reset();
      const unverified = await suggestOk({ text: "A note about hiring.", related: true, verify: false });
      expect(requests).toEqual([]);
      expect(relatedOf(unverified.body)).toEqual([["Head of Sales", 0.9]]);
    });

    it("a failed embedding fails the call, naming the semantic query, with no getBlocks call", async () => {
      await warm();
      aiFails = new Error("AI down");
      const failed = await suggest({ text: "Notes on Workflow Intelligence.", related: true });
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain("semantic query");
      expect(failed.text).toContain("AI down");
      expect(blockCalls()).toEqual([]);
    });

    it("related absent or false makes no AI call, Vectorize query or semantic read, and returns related: []", async () => {
      await indexed(HOS, 0.9);
      await warm();
      for (const args of [{}, { related: false }]) {
        reset();
        const { summary, body } = await suggestOk({ text: "Notes on Workflow Intelligence.", ...args });
        expect(aiRuns).toEqual([]);
        expect(vectors.queries).toBe(0);
        expect(semanticReads()).toEqual([]);
        expect(body.related).toEqual([]);
        expect(summary).not.toContain("related");
      }
    });

    it("is in the schema, and SEMANTIC_HELP describes it with the limit from the constant", async () => {
      const tools = (await rpc("tools/list", {})).tools;
      const tool = tools.find((t: { name: string }) => t.name === "suggest_links");
      expect(tool.inputSchema.properties.related.type).toBe("boolean");
      expect(tool.inputSchema.properties.related.description).toContain(`at most ${RELATED_LIMIT}`);
      expect(SEMANTIC_HELP).toContain("suggest_links");
      expect(SEMANTIC_HELP).toContain(`related: true`);
      expect(SEMANTIC_HELP).toContain(`at most ${RELATED_LIMIT} pages`);
      expect(SEMANTIC_HELP).toContain(`first ${RELATED_TEXT_CHARS.toLocaleString("en-NZ")} characters`);
      expect(tool.inputSchema.properties.related.description).toContain(`first ${RELATED_TEXT_CHARS.toLocaleString("en-NZ")} characters`);
      const help = (await rpc("tools/call", { name: "connector_help", arguments: {} })).content[0].text;
      expect(help).toContain(`at most ${RELATED_LIMIT} pages`);
    });
  });

  describe("related with semantic search off", () => {
    it("is not in the schema, and the help does not describe it", async () => {
      const tools = (await rpc("tools/list", {})).tools;
      const tool = tools.find((t: { name: string }) => t.name === "suggest_links");
      expect(Object.keys(tool.inputSchema.properties)).not.toContain("related");
      const help = (await rpc("tools/call", { name: "connector_help", arguments: {} })).content[0].text;
      expect(help).not.toContain("related: true");
    });

    it("related: true (or any value but false) is refused before any KV, sync or AI call", async () => {
      for (const related of [true, "true", 1]) {
        reset();
        const refused = await suggest({ text: "Notes on Workflow Intelligence.", related });
        expect(refused).toEqual({ isError: true, text: "related: semantic search is off on this connector" });
        expect(requests).toEqual([]);
        expect(kvCounts.get + kvCounts.put).toBe(0);
        expect(aiRuns).toEqual([]);
      }
    });

    it("related: false is a no-op, and calls without related are unchanged", async () => {
      await warm();
      for (const args of [{ related: false }, {}, { verify: false }]) {
        reset();
        const { body } = await suggestOk({ text: "Notes on Workflow Intelligence.", ...args });
        expect(body.suggestions.map((s: any) => s.page.uuid)).toEqual([WI]);
        expect(body.related).toEqual([]);
        expect(aiRuns).toEqual([]);
      }
    });
  });
});
