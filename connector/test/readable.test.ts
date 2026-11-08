import { describe, expect, it } from "vitest";
import { z } from "zod";
import manifest from "../tools-manifest.json";
import openapi from "../vendor/openapi.json";
import { resolveOpenApiRefs } from "../vendor/semantic_api_tools.mjs";
import { RESULT_CHAR_LIMIT, ToolError } from "../src/tools/common";
import {
  type AffectedTarget,
  CONTEXT_TOOLS,
  NO_CONTEXT_TOOLS,
  REASON_MAX,
  capWriteResult,
  contextClassFor,
  describeWrite,
  summarise,
  takeReason,
  toAffectedTargets,
} from "../src/tools/readable";
import batchInsertBlockTrees from "./fixtures/readable/batch-insert-block-trees.json";
import batchInsertDisplay from "./fixtures/readable/batch-insert-display.json";
import batchInsertDryRun from "./fixtures/readable/batch-insert-dry-run.json";
import batchInsertPropertiesOnly from "./fixtures/readable/batch-insert-properties-only.json";
import batchInsertPropertiesOnlyDryRun from "./fixtures/readable/batch-insert-properties-only-dry-run.json";
import batchMoveDryRun from "./fixtures/readable/batch-move-dry-run.json";
import batchSetBlockProperty from "./fixtures/readable/batch-set-block-property.json";
import deleteBlocks from "./fixtures/readable/delete-blocks.json";
import deleteBlocksDryRun from "./fixtures/readable/delete-blocks-dry-run.json";
import deleteBlocksE2ee from "./fixtures/readable/delete-blocks-e2ee.json";
import deletePage from "./fixtures/readable/delete-page.json";
import deletePageDryRun from "./fixtures/readable/delete-page-dry-run.json";
import deletePageToday from "./fixtures/readable/delete-page-today.json";
import deletePageTodayDryRun from "./fixtures/readable/delete-page-today-dry-run.json";
import insertBlockTree from "./fixtures/readable/insert-block-tree.json";
import insertBlockTreeDisplay from "./fixtures/readable/insert-block-tree-display.json";
import insertUnavailable from "./fixtures/readable/insert-unavailable.json";
import moveBlocks from "./fixtures/readable/move-blocks.json";
import moveBlocksDryRun from "./fixtures/readable/move-blocks-dry-run.json";
import setBlockProperty from "./fixtures/readable/set-block-property.json";
import updateBlockCode from "./fixtures/readable/update-block-code.json";
import updateBlockPlain from "./fixtures/readable/update-block-plain.json";

describe("takeReason", () => {
  it("takes the reason out of the arguments and leaves the rest as they were", () => {
    const args = { graph: "work", "block-id": "b1", body: { title: "x", reason: "body field" }, reason: "tidy duplicate notes" };
    const { reason, rest } = takeReason(args);
    expect(reason).toBe("tidy duplicate notes");
    expect(rest).toEqual({ graph: "work", "block-id": "b1", body: { title: "x", reason: "body field" } });
    expect("reason" in rest).toBe(false);
    // The caller's object is not changed.
    expect(args.reason).toBe("tidy duplicate notes");
  });

  it("no reason, an empty one or one of only spaces is no reason", () => {
    for (const given of [undefined, "", "   ", "\n\t"]) {
      const args = given === undefined ? { graph: "work" } : { graph: "work", reason: given };
      const { reason, rest } = takeReason(args);
      expect(reason, JSON.stringify(given)).toBeUndefined();
      expect(rest).toEqual({ graph: "work" });
    }
  });

  it("trims the reason it keeps", () => {
    expect(takeReason({ reason: "  tidy duplicate notes \n" }).reason).toBe("tidy duplicate notes");
  });

  it("accepts up to 200 characters, counting characters rather than UTF-16 units, and refuses more", () => {
    expect(REASON_MAX).toBe(200);
    expect(takeReason({ reason: "x".repeat(200) }).reason).toHaveLength(200);
    // 200 emoji are 400 UTF-16 units but 200 characters.
    expect(takeReason({ reason: "🙂".repeat(200) }).reason).toBe("🙂".repeat(200));
    for (const reason of ["x".repeat(201), "🙂".repeat(201), "é".repeat(150) + "x".repeat(51)]) {
      let thrown: unknown;
      try {
        takeReason({ reason });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, reason.slice(0, 5)).toBeInstanceOf(ToolError);
      expect((thrown as ToolError).status).toBe("refused");
      expect((thrown as ToolError).message).toBe("reason is 201 characters; at most 200 are accepted — shorten it");
    }
    // Spaces that would be trimmed still count against the limit only after trimming.
    expect(takeReason({ reason: ` ${"x".repeat(200)} ` }).reason).toHaveLength(200);
  });

  it("refuses a reason that is not a string", () => {
    for (const reason of [42, true, null, ["a"], { text: "a" }]) {
      expect(() => takeReason({ reason }), JSON.stringify(reason)).toThrow(
        new ToolError("reason must be a string of at most 200 characters", "refused"),
      );
    }
  });
});

describe("summarise", () => {
  it("with no targets, repeats the reason, or gives nothing", () => {
    expect(summarise([], { reason: "tidy duplicate notes" })).toBe("Reason: tidy duplicate notes");
    expect(summarise([], {})).toBe("");
    expect(summarise([], { reason: undefined })).toBe("");
  });
});

// Stage 3: what the server names in a write's response, and the summary that leads the result.
// Each fixture is a response of the shape patch 0028 answers, checked below against the vendored
// OpenAPI response schema of its operation.
type Fixture = { operationId: string; status: string; tool: string; response: Record<string, unknown> };
const FIXTURES: Record<string, Fixture> = {
  "batch-insert-block-trees": batchInsertBlockTrees,
  "batch-insert-display": batchInsertDisplay,
  "batch-insert-dry-run": batchInsertDryRun,
  "batch-insert-properties-only": batchInsertPropertiesOnly,
  "batch-insert-properties-only-dry-run": batchInsertPropertiesOnlyDryRun,
  "batch-move-dry-run": batchMoveDryRun,
  "batch-set-block-property": batchSetBlockProperty,
  "delete-blocks": deleteBlocks,
  "delete-blocks-dry-run": deleteBlocksDryRun,
  "delete-blocks-e2ee": deleteBlocksE2ee,
  "delete-page": deletePage,
  "delete-page-dry-run": deletePageDryRun,
  "delete-page-today": deletePageToday,
  "delete-page-today-dry-run": deletePageTodayDryRun,
  "insert-block-tree": insertBlockTree,
  "insert-block-tree-display": insertBlockTreeDisplay,
  "insert-unavailable": insertUnavailable,
  "move-blocks": moveBlocks,
  "move-blocks-dry-run": moveBlocksDryRun,
  "set-block-property": setBlockProperty,
  "update-block-code": updateBlockCode,
  "update-block-plain": updateBlockPlain,
};

function fixture(name: string) {
  const f = FIXTURES[name];
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

function summaryOf(name: string, reason?: string): string {
  const f = fixture(name);
  return describeWrite(f.tool, { content: [{ type: "text", text: JSON.stringify(f.response) }] }, reason).summary;
}

const SNIPPET = "Call Sam about the contract renewal before Friday's review meeting with the boar";

describe("fixtures", () => {
  const resolved = resolveOpenApiRefs(openapi, openapi) as any;
  const contextKeys = Object.keys(resolved.components.schemas.BlockContext.properties);

  it("each matches its operation's response schema, and its contexts use only BlockContext fields", () => {
    expect(Object.keys(FIXTURES).length).toBeGreaterThanOrEqual(10);
    for (const [file, f] of Object.entries(FIXTURES)) {
      const op = Object.values(resolved.paths as Record<string, Record<string, any>>)
        .flatMap((item) => Object.values(item))
        .find((o) => o?.operationId === f.operationId);
      expect(op, file).toBeDefined();
      const schema = op.responses[f.status].content["application/json"].schema;
      expect(() => z.fromJSONSchema(schema).parse(f.response), file).not.toThrow();
      const contexts = [f.response.target, ...((f.response.affected as unknown[]) ?? [])].concat(
        ((f.response.entries as any[]) ?? []).flatMap((e) => [e.target, ...(e.affected ?? [])]),
      );
      for (const ctx of contexts.filter(Boolean) as Record<string, unknown>[]) {
        expect(Object.keys(ctx).filter((k) => !contextKeys.includes(k)), file).toEqual([]);
        expect(() => z.fromJSONSchema(resolved.components.schemas.BlockContext).parse(ctx), file).not.toThrow();
      }
    }
  });
});

describe("toAffectedTargets", () => {
  it("normalises each target and affected entry, at the top level and per batch entry", () => {
    expect(toAffectedTargets(fixture("delete-blocks").response)[0]).toEqual({
      uuid: "8d1c2b6e-4f0a-4c51-9a77-1f0e3b2c4d01",
      kind: "block",
      role: "affected",
      pageUuid: "00000001-2026-1105-0000-000000000000",
      pageTitle: "Nov 5th, 2026",
      breadcrumb: ["Meeting", "Agenda"],
      snippet: SNIPPET,
      descendants: 3,
    });
    expect(toAffectedTargets(fixture("batch-insert-block-trees").response).map((t) => [t.role, t.snippet])).toEqual([
      ["target", "Notes"],
      ["affected", "Car"],
      ["target", "Ideas"],
      ["affected", "One"],
    ]);
    expect(toAffectedTargets(fixture("move-blocks").response)[0]).toMatchObject({
      from: { pageTitle: "Nov 5th, 2026", breadcrumb: ["Notes"] },
      to: { pageTitle: "Nov 5th, 2026", breadcrumb: ["Meeting", "Agenda"] },
    });
    expect(toAffectedTargets(fixture("delete-blocks-e2ee").response)).toEqual([
      { uuid: "8d1c2b6e-4f0a-4c51-9a77-1f0e3b2c4d01", kind: "block", role: "affected", pageUuid: "00000001-2026-1105-0000-000000000000", breadcrumb: [], descendants: 2, e2ee: true },
    ]);
  });

  it("gives nothing for a response without context", () => {
    for (const response of [null, undefined, "DELETE /x succeeded", [], { ok: true }, { affected: [{ snippet: "no uuid" }] }, { target: 3 }]) {
      expect(toAffectedTargets(response), JSON.stringify(response)).toEqual([]);
    }
  });
});

describe("summarise", () => {
  it("names each deleted block by page, breadcrumb and snippet, with the reason last", () => {
    expect(summaryOf("delete-blocks", "tidy duplicate notes")).toBe(
      [
        "Deleted 3 blocks:",
        `- Nov 5th, 2026 > Meeting > Agenda > "${SNIPPET}" (+3 children)`,
        '- Nov 5th, 2026 > "[[Meeting]]" (+0 children)',
        '- Nov 5th, 2026 > … > L7 > "Deep leaf" (+0 children)',
        "Reason: tidy duplicate notes",
      ].join("\n"),
    );
  });

  it("elides a path of more than four segments to the first and the last two", () => {
    const t = (breadcrumb: string[]): AffectedTarget => ({ uuid: "u", kind: "block", role: "affected", pageTitle: "P", breadcrumb, snippet: "s" });
    const lines = (breadcrumb: string[]) => summarise([t(breadcrumb)], { tool: "delete_block" }).split("\n")[1];
    expect(lines([])).toBe('- P > "s"');
    expect(lines(["A", "B"])).toBe('- P > A > B > "s"');
    expect(lines(["A", "B", "C"])).toBe('- P > … > C > "s"');
    expect(lines(["A", "B", "C", "D"])).toBe('- P > … > D > "s"');
    expect(lines(["A", "B", "C", "D", "E"])).toBe('- P > … > E > "s"');
  });

  it("names a moved block's from and to, a page, an insert's new blocks and a property write's block", () => {
    expect(summaryOf("move-blocks")).toBe('Moved 1 block:\n- "Book flights" from Nov 5th, 2026 > Notes to Nov 5th, 2026 > Meeting > Agenda');
    expect(summaryOf("delete-page")).toBe('Deleted 1 page:\n- page "Scratch"');
    expect(summaryOf("insert-block-tree")).toBe(
      'Inserted 2 blocks:\n- Nov 5th, 2026 > Meeting > Agenda > "New item" (+2 children)\n- Nov 5th, 2026 > Meeting > Agenda > "Second" (+0 children)',
    );
    expect(summaryOf("batch-insert-block-trees")).toBe('Inserted 2 blocks:\n- Nov 5th, 2026 > Notes > "Car" (+1 child)\n- Ideas > "One" (+0 children)');
    expect(summaryOf("set-block-property")).toBe('Set a property on 1 block:\n- Nov 5th, 2026 > Notes > "Book flights"');
    expect(summaryOf("batch-set-block-property")).toBe(
      'Set properties on 2 blocks:\n- Nov 5th, 2026 > Notes > "Book flights"\n- Nov 5th, 2026 > Meeting > "Agenda"',
    );
  });

  it("says a dry run changed nothing", () => {
    expect(summaryOf("delete-blocks-dry-run", "check first")).toBe(
      'Dry run, nothing changed: would delete 1 block:\n- Nov 5th, 2026 > Notes > "Book flights" (+1 child, 2 references)\nReason: check first',
    );
  });

  // Stage 6: each of the five dry runs, with the counts the server adds to them.
  it("a delete_page dry run gives the page's block count, references and first blocks", () => {
    expect(summaryOf("delete-page-dry-run")).toBe(
      'Dry run, nothing changed: would delete 1 page:\n- page "Scratch" (7 blocks, 1 reference; first blocks: "Zero", "A first", "B")',
    );
  });

  it("move_blocks and batch_move_blocks dry runs say where each block would go", () => {
    expect(summaryOf("move-blocks-dry-run", "tidy")).toBe(
      'Dry run, nothing changed: would move 1 block:\n- "Notes" from Nov 5th, 2026 to Nov 5th, 2026 > [[Meeting]]\nReason: tidy',
    );
    expect(summaryOf("batch-move-dry-run")).toBe(
      [
        "Dry run, nothing changed: would move 2 blocks:",
        '- "Sam\'s number" from Nov 5th, 2026 > Meeting > Agenda to Nov 5th, 2026 > Notes',
        '- "Book flights" from Nov 5th, 2026 > Notes to Nov 5th, 2026 > Notes > Sam\'s number',
      ].join("\n"),
    );
  });

  it("a batch_insert_block_trees dry run names the pages it would create", () => {
    expect(summaryOf("batch-insert-dry-run")).toBe(
      [
        "Dry run, nothing changed: would insert 2 blocks:",
        '- Nov 5th, 2026 > Notes > "Pack" (+1 child)',
        '- Trip ideas > "First" (+0 children)',
        'Would create page "Trip ideas".',
      ].join("\n"),
    );
  });

  it("counts and would-create are read from the response, and singular counts read as such", () => {
    const targets = toAffectedTargets(fixture("batch-insert-dry-run").response);
    expect(targets.filter((t) => t.wouldCreate).map((t) => t.pageTitle)).toEqual(["Trip ideas"]);
    expect(toAffectedTargets(fixture("delete-page-dry-run").response)[0]).toMatchObject({
      references: 1,
      blocks: 7,
      roots: ["Zero", "A first", "B"],
    });
    const one: AffectedTarget = { uuid: "u", kind: "page", role: "affected", pageTitle: "P", breadcrumb: [], snippet: "P", blocks: 1, references: 0, roots: [] };
    expect(summarise([one], { tool: "delete_page", dryRun: true })).toBe('Dry run, nothing changed: would delete 1 page:\n- page "P" (1 block, 0 references)');
    expect(summarise([{ ...one, kind: "block", blocks: undefined, roots: undefined, descendants: 0, references: 1 }], { tool: "delete_blocks", dryRun: true })).toBe(
      'Dry run, nothing changed: would delete 1 block:\n- P > "P" (+0 children, 1 reference)',
    );
  });

  it("a real write is never described as a dry run, and created pages are not called would-create", () => {
    const response: Record<string, unknown> = { ...fixture("batch-insert-dry-run").response, "dry-run": undefined };
    response.entries = (response.entries as Record<string, unknown>[]).map(({ "would-create": _w, ...e }) => ({ ...e, created: true }));
    const summary = describeWrite("batch_insert_block_trees", { content: [{ type: "text", text: JSON.stringify(response) }] }, undefined).summary;
    expect(summary.startsWith("Inserted 2 blocks:")).toBe(true);
    expect(summary).not.toContain("Would create");
  });

  it("says titles are unavailable on an E2EE graph instead of showing UUID-only lines as complete", () => {
    expect(summaryOf("delete-blocks-e2ee")).toBe(
      "Deleted 1 block (titles unavailable on an E2EE graph):\n- block 8d1c2b6e-4f0a-4c51-9a77-1f0e3b2c4d01 (+2 children)",
    );
  });

  it("says when the context could not be read, and that the write stands", () => {
    expect(summaryOf("insert-unavailable", "add the agenda")).toBe(
      "Context unavailable (the block is no longer in the graph); the write was applied.\nReason: add the agenda",
    );
  });

  // Review round 1.
  it("a batch_insert_block_trees entry that only sets properties is not called an insert", () => {
    expect(summaryOf("batch-insert-properties-only", "tag pages")).toBe(
      [
        "Inserted 1 block:",
        '- Nov 5th, 2026 > Notes > "Hotel" (+0 children)',
        "Set properties on 2 pages:",
        '- page "Alpha"',
        '- page "Beta"',
        "Reason: tag pages",
      ].join("\n"),
    );
    expect(summaryOf("batch-insert-properties-only-dry-run")).toBe(
      [
        "Dry run, nothing changed: would set properties on 2 pages:",
        '- page "Alpha"',
        '- page "Beta"',
        'Would create page "Beta".',
      ].join("\n"),
    );
    // A dry run that also inserts keeps its dry-run head on the inserts.
    const mixed = { ...fixture("batch-insert-properties-only").response, "dry-run": true };
    expect(describeWrite("batch_insert_block_trees", { content: [{ type: "text", text: JSON.stringify(mixed) }] }, undefined).summary).toBe(
      [
        "Dry run, nothing changed: would insert 1 block:",
        '- Nov 5th, 2026 > Notes > "Hotel" (+0 children)',
        "Would set properties on 2 pages:",
        '- page "Alpha"',
        '- page "Beta"',
      ].join("\n"),
    );
  });

  it("an insert never falls back to naming its targets as what it inserted, while other writes still do", () => {
    const target: AffectedTarget = { uuid: "u", kind: "page", role: "target", pageTitle: "Alpha", breadcrumb: [], snippet: "Alpha" };
    for (const tool of ["insert_block_tree", "insert_block_children", "batch_insert_block_trees", "capture_to_today"]) {
      expect(summarise([target], { tool }), tool).toBe("");
    }
    expect(summarise([target], { tool: "set_block_property" })).toBe('Set a property on 1 page:\n- page "Alpha"');
    expect(summarise([target], { tool: "update_block" })).toBe('Updated 1 page:\n- page "Alpha"');
  });

  it("delete_page on today's journal says its blocks were cleared and the page kept", () => {
    expect(summaryOf("delete-page-today", "clear today")).toBe(
      "Cleared today's journal: 2 blocks were deleted and the page kept:\n- journal \"Nov 6th, 2026\"\nReason: clear today",
    );
    expect(summaryOf("delete-page-today-dry-run")).toBe(
      'Dry run, nothing changed: would clear today\'s journal, deleting its blocks and keeping the page:\n- journal "Nov 6th, 2026" (2 blocks, 0 references; first blocks: "Nov 6th, 2026 note")',
    );
    expect(summaryOf("delete-page")).toBe('Deleted 1 page:\n- page "Scratch"');
  });

  it("a dry run whose context could not be read says nothing was changed", () => {
    const response = { ...fixture("move-blocks").response, "dry-run": true, context: "unavailable", "context-reason": "boom" };
    const summary = describeWrite("move_blocks", { content: [{ type: "text", text: JSON.stringify(response) }] }, undefined).summary;
    expect(summary).toContain("Context unavailable (boom); nothing was changed.");
    expect(summary).not.toContain("the write was applied");
  });

  it("a tool that names no targets keeps the stage 2 summary", () => {
    const result = { content: [{ type: "text" as const, text: JSON.stringify({ uuid: "p", title: "Standup" }) }] };
    expect(describeWrite("create_page", result, "new page")).toEqual({ targets: [], summary: "Reason: new page" });
    expect(describeWrite("create_page", result, undefined)).toEqual({ targets: [], summary: "" });
  });
});

describe("context classes", () => {
  it("every write tool is classified, as context or no-context, and only once", () => {
    const writes = (manifest as { name: string; annotations: { readOnlyHint: boolean } }[])
      .filter((t) => !t.annotations.readOnlyHint)
      .map((t) => t.name);
    expect(writes.length).toBeGreaterThan(20);
    const unclassified = writes.filter((n) => !(n in CONTEXT_TOOLS) && !(n in NO_CONTEXT_TOOLS));
    const both = writes.filter((n) => n in CONTEXT_TOOLS && n in NO_CONTEXT_TOOLS);
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
    // Nothing is classified that is not a write tool.
    expect([...Object.keys(CONTEXT_TOOLS), ...Object.keys(NO_CONTEXT_TOOLS)].filter((n) => !writes.includes(n))).toEqual([]);
    for (const reason of Object.values(NO_CONTEXT_TOOLS)) expect(reason.length).toBeGreaterThan(10);
  });

  it("a tool in neither table is refused", () => {
    expect(contextClassFor("delete_blocks")).toBe("context");
    expect(contextClassFor("create_property")).toBe("no-context");
    expect(() => contextClassFor("not_a_tool")).toThrow(
      "no context class for write tool not_a_tool: add it to CONTEXT_TOOLS or NO_CONTEXT_TOOLS",
    );
  });
});

describe("capWriteResult", () => {
  const texts = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "");

  it("leaves a result under the cap as it is", () => {
    const result = { content: [{ type: "text" as const, text: "Moved 1 block:" }, { type: "text" as const, text: "{}" }] };
    expect(capWriteResult(result)).toEqual(result);
  });

  it("cuts the summary, not the JSON, when the JSON alone fits", () => {
    const json = JSON.stringify({ moved: 1, pad: "j".repeat(140_000) });
    const capped = capWriteResult({ content: [{ type: "text", text: "s".repeat(20_000) }, { type: "text", text: json }] });
    const [summary, kept] = texts(capped);
    expect(kept).toBe(json);
    expect(summary.length + kept.length).toBe(RESULT_CHAR_LIMIT);
    expect(summary).toMatch(/^s+\n\n\[summary cut: the write was applied; the JSON result below is complete\]$/);
  });

  it("a cut summary keeps its last line, the audit entry Claude cites", () => {
    const json = JSON.stringify({ moved: 1, pad: "j".repeat(140_000) });
    const last = "Logged as audit entry 4242";
    const capped = capWriteResult({ content: [{ type: "text", text: `${"s".repeat(20_000)}\nReason: tidy\n${last}` }, { type: "text", text: json }] });
    const [summary, kept] = texts(capped);
    expect(kept).toBe(json);
    expect(summary.length + kept.length).toBe(RESULT_CHAR_LIMIT);
    expect(summary).toMatch(new RegExp(`^s+\\n\\n\\[summary cut: the write was applied; the JSON result below is complete\\]\\n${last}$`));
  });

  it("when the JSON alone is over the cap, keeps the summary and cuts the JSON with a write's notice", () => {
    const capped = capWriteResult({ content: [{ type: "text", text: "Moved 1 block:" }, { type: "text", text: "j".repeat(200_000) }] });
    const [summary, json] = texts(capped);
    expect(summary).toBe("Moved 1 block:");
    expect(summary.length + json.length).toBe(RESULT_CHAR_LIMIT);
    expect(json).toMatch(/\[truncated: the write was applied; its result had 200014 characters and the limit is 150000, so the JSON is cut\. Read the pages it names to see the outcome\.\]$/);
  });
});

describe("summarise, long results", () => {
  const t = (i: number, pageTitle: string): AffectedTarget => ({
    uuid: `u${i}`, kind: "block", role: "affected", pageTitle, breadcrumb: ["Parent"], snippet: `Block ${i}`,
  });

  it("lists at most 20 blocks per section and says how many more the JSON holds", () => {
    const lines = summarise(Array.from({ length: 21 }, (_, i) => t(i, "Page")), { tool: "delete_blocks" }).split("\n");
    expect(lines[0]).toBe("Deleted 21 blocks:");
    expect(lines.slice(1)).toEqual([...Array.from({ length: 20 }, (_, i) => `- Page > Parent > "Block ${i}"`), "- … and 1 more, listed in the JSON result"]);
    const twenty = summarise(Array.from({ length: 20 }, (_, i) => t(i, "Page")), { tool: "delete_blocks" });
    expect(twenty).not.toContain("more, listed");
  });

  it("cuts a page title to 80 characters (code points), as the server cuts snippets", () => {
    const title = "😀".repeat(100);
    const out = summarise([t(0, title)], { tool: "delete_blocks" });
    expect(out.split("\n")[1]).toBe(`- ${"😀".repeat(80)} > Parent > "Block 0"`);
    const moved = summarise([{ ...t(0, ""), from: { pageTitle: title, breadcrumb: [] }, to: { pageTitle: title, breadcrumb: [] } }], { tool: "move_blocks" });
    expect(moved.split("\n")[1]).toBe(`- "Block 0" from ${"😀".repeat(80)} to ${"😀".repeat(80)}`);
  });
});

// Patch 0037: a write whose response gives a block's display type (update_block's block, an insert's
// verbose blocks) shows it on that block's summary line; a block without one reads as before.
describe("summarise, code, math and quote blocks", () => {
  it("an update_block result shows the block's display type and lang", () => {
    expect(summaryOf("update-block-code")).toBe('Updated 1 block:\n- Nov 5th, 2026 > Notes > "print(1)" (display-type code, lang python)');
  });

  it("a plain block's update_block summary is unchanged", () => {
    expect(summaryOf("update-block-plain")).toBe('Updated 1 block:\n- Nov 5th, 2026 > Notes > "Book flights"');
  });

  it("an insert shows each new top-level block's display type, before its counts; plain blocks are unchanged", () => {
    expect(summaryOf("insert-block-tree-display")).toBe(
      [
        "Inserted 4 blocks:",
        '- Nov 5th, 2026 > Meeting > Agenda > "#include <stdio.h>" (display-type code, lang c, +1 child)',
        '- Nov 5th, 2026 > Meeting > Agenda > "E=mc^2" (display-type math, +0 children)',
        '- Nov 5th, 2026 > Meeting > Agenda > "Example" (display-type quote, +0 children)',
        '- Nov 5th, 2026 > Meeting > Agenda > "```query" (+0 children)',
      ].join("\n"),
    );
    // Without verbose the server sends no display type, and the summary is the one it always was.
    expect(summaryOf("insert-block-tree")).toBe(
      'Inserted 2 blocks:\n- Nov 5th, 2026 > Meeting > Agenda > "New item" (+2 children)\n- Nov 5th, 2026 > Meeting > Agenda > "Second" (+0 children)',
    );
  });

  it("a batch insert takes each entry's display types from that entry's own blocks", () => {
    expect(summaryOf("batch-insert-display")).toBe(
      'Inserted 2 blocks:\n- Ideas > "Example" (display-type quote, +0 children)\n- Ideas > "graph TD" (display-type code, lang mermaid, +0 children)',
    );
    // In the other entry order, each block keeps its own type.
    const f = fixture("batch-insert-display");
    const reversed = { ...f.response, entries: [...(f.response.entries as unknown[])].reverse() };
    expect(describeWrite(f.tool, { content: [{ type: "text", text: JSON.stringify(reversed) }] }, undefined).summary).toBe(
      'Inserted 2 blocks:\n- Ideas > "graph TD" (display-type code, lang mermaid, +0 children)\n- Ideas > "Example" (display-type quote, +0 children)',
    );
  });

  it("a display type the server never answers, or a lang on its own, is not shown as a type", () => {
    const f = fixture("update-block-code");
    const line = (extra: Record<string, unknown>) =>
      describeWrite(f.tool, { content: [{ type: "text", text: JSON.stringify({ ...f.response, ...extra }) }] }, undefined).summary.split("\n")[1];
    expect(line({ "display-type": "cod", lang: undefined })).toBe('- Nov 5th, 2026 > Notes > "print(1)"');
    expect(line({ "display-type": 3, lang: undefined })).toBe('- Nov 5th, 2026 > Notes > "print(1)"');
    expect(line({ "display-type": undefined })).toBe('- Nov 5th, 2026 > Notes > "print(1)"');
    expect(line({ "display-type": "math", lang: undefined })).toBe('- Nov 5th, 2026 > Notes > "print(1)" (display-type math)');
    expect(line({ "display-type": "quote", lang: undefined })).toBe('- Nov 5th, 2026 > Notes > "print(1)" (display-type quote)');
  });

  it("toAffectedTargets carries the display type and lang on the block they belong to", () => {
    const targets = toAffectedTargets(fixture("insert-block-tree-display").response);
    expect(targets.map((t) => [t.role, t.snippet, t.displayType, t.lang])).toEqual([
      ["target", "Agenda", undefined, undefined],
      ["affected", "#include <stdio.h>", "code", "c"],
      ["affected", "E=mc^2", "math", undefined],
      ["affected", "Example", "quote", undefined],
      ["affected", "```query", undefined, undefined],
    ]);
  });
});
