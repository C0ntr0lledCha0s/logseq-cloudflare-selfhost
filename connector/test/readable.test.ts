import { describe, expect, it } from "vitest";
import { z } from "zod";
import manifest from "../tools-manifest.json";
import openapi from "../vendor/openapi.json";
import { resolveOpenApiRefs } from "../vendor/semantic_api_tools.mjs";
import { ToolError } from "../src/tools/common";
import {
  type AffectedTarget,
  CONTEXT_TOOLS,
  NO_CONTEXT_TOOLS,
  REASON_MAX,
  contextClassFor,
  describeWrite,
  summarise,
  takeReason,
  toAffectedTargets,
} from "../src/tools/readable";
import batchInsertBlockTrees from "./fixtures/readable/batch-insert-block-trees.json";
import batchInsertDryRun from "./fixtures/readable/batch-insert-dry-run.json";
import batchMoveDryRun from "./fixtures/readable/batch-move-dry-run.json";
import batchSetBlockProperty from "./fixtures/readable/batch-set-block-property.json";
import deleteBlocks from "./fixtures/readable/delete-blocks.json";
import deleteBlocksDryRun from "./fixtures/readable/delete-blocks-dry-run.json";
import deleteBlocksE2ee from "./fixtures/readable/delete-blocks-e2ee.json";
import deletePage from "./fixtures/readable/delete-page.json";
import deletePageDryRun from "./fixtures/readable/delete-page-dry-run.json";
import insertBlockTree from "./fixtures/readable/insert-block-tree.json";
import insertUnavailable from "./fixtures/readable/insert-unavailable.json";
import moveBlocks from "./fixtures/readable/move-blocks.json";
import moveBlocksDryRun from "./fixtures/readable/move-blocks-dry-run.json";
import setBlockProperty from "./fixtures/readable/set-block-property.json";

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
  "batch-insert-dry-run": batchInsertDryRun,
  "batch-move-dry-run": batchMoveDryRun,
  "batch-set-block-property": batchSetBlockProperty,
  "delete-blocks": deleteBlocks,
  "delete-blocks-dry-run": deleteBlocksDryRun,
  "delete-blocks-e2ee": deleteBlocksE2ee,
  "delete-page": deletePage,
  "delete-page-dry-run": deletePageDryRun,
  "insert-block-tree": insertBlockTree,
  "insert-unavailable": insertUnavailable,
  "move-blocks": moveBlocks,
  "move-blocks-dry-run": moveBlocksDryRun,
  "set-block-property": setBlockProperty,
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
