import { describe, expect, it } from "vitest";
import { ToolError } from "../src/tools/common";
import { REASON_MAX, summarise, takeReason } from "../src/tools/readable";

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
