import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { GraphStore, normalizeAlias, normalizeToken } from "../src/graphs";

const TOKEN = "logseq_pat_abcDEF123_-xyz";
const BASE = {
  alias: "work",
  graphId: "11111111-1111-1111-1111-111111111111",
  graphName: "Work graph",
  mode: "write" as const,
  permission: "both" as const,
  expiresAt: null,
  token: TOKEN,
};

function store(): GraphStore {
  return new GraphStore(env.DB, env.GRAPH_TOKEN_KEY);
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM graphs");
});

describe("normalizeToken", () => {
  it("trims one trailing newline and rejects inner whitespace and bad chars", () => {
    expect(normalizeToken(`${TOKEN}\n`)).toBe(TOKEN);
    expect(normalizeToken(`  ${TOKEN} \r\n`)).toBe(TOKEN);
    for (const bad of [`logseq_pat_ab cd`, `logseq_pat_ab\ncd`, `logseq_pat_ab$cd`, `logseq_pat_`, `other_abc`, ``]) {
      expect(() => normalizeToken(bad)).toThrow("token has unexpected characters (stray whitespace or newline?)");
    }
  });
});

describe("normalizeAlias", () => {
  it("lowercases, replaces non-alphanumerics with a hyphen and collapses repeats", () => {
    expect(normalizeAlias("My  Work_Graph")).toBe("my-work-graph");
    expect(normalizeAlias("a!!b")).toBe("a-b");
  });

  it("rejects values that do not match the alias pattern", () => {
    expect(() => normalizeAlias("")).toThrow();
    expect(() => normalizeAlias("--x")).toThrow();
    expect(() => normalizeAlias("a".repeat(41))).toThrow();
    expect(normalizeAlias("a".repeat(40))).toBe("a".repeat(40));
  });
});

describe("GraphStore", () => {
  it("token round-trips encrypted; token_ct differs from plaintext and between two adds of same token", async () => {
    const s = store();
    await s.add(BASE);
    await s.add({ ...BASE, alias: "second", graphId: "22222222-2222-2222-2222-222222222222" });
    expect(await s.token("work")).toBe(TOKEN);
    const rows = (await env.DB.prepare("SELECT alias, token_ct, token_iv, key_id FROM graphs ORDER BY alias").all<{
      alias: string;
      token_ct: string;
      token_iv: string;
      key_id: string;
    }>()).results;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.token_ct).not.toContain(TOKEN);
      expect(row.token_ct).not.toContain("logseq_pat");
      expect(row.key_id).toBe("k1");
    }
    expect(rows[0].token_ct).not.toBe(rows[1].token_ct);
    expect(rows[0].token_iv).not.toBe(rows[1].token_iv);
  });

  it("add trims a trailing newline from the token and rejects a malformed one", async () => {
    const s = store();
    await s.add({ ...BASE, token: `${TOKEN}\n` });
    expect(await s.token("work")).toBe(TOKEN);
    await expect(s.add({ ...BASE, alias: "other", graphId: "g2", token: "nope" })).rejects.toThrow("token has unexpected");
  });

  it("rejects a tampered ciphertext and a wrong key", async () => {
    const s = store();
    await s.add(BASE);
    await expect(new GraphStore(env.DB, "00".repeat(32)).token("work")).rejects.toThrow();
    await env.DB.exec("UPDATE graphs SET token_ct = 'AAAA' WHERE alias = 'work'");
    await expect(s.token("work")).rejects.toThrow();
  });

  it("a ciphertext copied onto another graph's row does not decrypt (graph id is bound as AAD)", async () => {
    const s = store();
    await s.add({ ...BASE, alias: "a", graphId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", token: "logseq_pat_tokenA" });
    await s.add({ ...BASE, alias: "b", graphId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", token: "logseq_pat_tokenB" });
    await env.DB.exec(
      "UPDATE graphs SET token_ct = (SELECT token_ct FROM graphs WHERE alias = 'a'), token_iv = (SELECT token_iv FROM graphs WHERE alias = 'a') WHERE alias = 'b'",
    );
    expect(await s.token("a")).toBe("logseq_pat_tokenA");
    await expect(s.token("b")).rejects.toThrow();
  });

  it("constructor throws unless the key is 64 hex characters", () => {
    for (const bad of ["", "abcd", "zz".repeat(32), "00".repeat(31), "00".repeat(33)]) {
      expect(() => new GraphStore(env.DB, bad)).toThrow("GRAPH_TOKEN_KEY");
    }
  });

  it("duplicate alias or graph_id rejected", async () => {
    const s = store();
    await s.add(BASE);
    await expect(s.add({ ...BASE, graphId: "other-id" })).rejects.toThrow(/alias/);
    await expect(s.add({ ...BASE, alias: "other" })).rejects.toThrow(/graph/);
    expect(await s.list()).toHaveLength(1);
  });

  it("add rejects an invalid alias", async () => {
    await expect(store().add({ ...BASE, alias: "Not Valid" })).rejects.toThrow(/alias/);
  });

  it("replaceToken refuses a different graph id", async () => {
    const s = store();
    await s.add(BASE);
    const next = "logseq_pat_replacement";
    await expect(s.replaceToken("work", next, "99999999-9999-9999-9999-999999999999")).rejects.toThrow();
    expect(await s.token("work")).toBe(TOKEN);
    await s.replaceToken("work", `${next}\n`, BASE.graphId);
    expect(await s.token("work")).toBe(next);
  });

  it("remove then get returns null immediately", async () => {
    const s = store();
    await s.add(BASE);
    await s.remove("work");
    expect(await s.get("work")).toBeNull();
    await expect(s.token("work")).rejects.toThrow();
    await expect(s.remove("work")).rejects.toThrow();
  });

  it("list never exposes token fields", async () => {
    const s = store();
    await s.add(BASE);
    const [rec] = await s.list();
    expect(Object.keys(rec).sort()).toEqual(
      ["alias", "expiresAt", "graphId", "graphName", "lastUsedAt", "mode", "permission"].sort(),
    );
    expect(JSON.stringify(await s.list())).not.toContain("logseq_pat");
    expect(Object.keys((await s.get("work"))!)).not.toContain("token");
    expect(await s.get("missing")).toBeNull();
  });

  it("update changes mode and expiresAt; renaming keeps uniqueness and normalizes", async () => {
    const s = store();
    await s.add(BASE);
    await s.add({ ...BASE, alias: "home", graphId: "g2" });
    await s.update("work", { mode: "read", expiresAt: "2027-01-01T00:00:00.000Z" });
    expect(await s.get("work")).toMatchObject({ mode: "read", expiresAt: "2027-01-01T00:00:00.000Z" });
    await s.update("work", { expiresAt: null });
    expect((await s.get("work"))!.expiresAt).toBeNull();

    await expect(s.update("work", { alias: "home" })).rejects.toThrow(/alias/);
    await expect(s.update("work", { alias: "--" })).rejects.toThrow();
    await s.update("work", { alias: "Work Graph 2" });
    expect(await s.get("work")).toBeNull();
    expect(await s.token("work-graph-2")).toBe(TOKEN);
    await expect(s.update("missing", { mode: "read" })).rejects.toThrow();
  });

  it("touch sets last_used_at to an ISO timestamp and throws for a missing alias", async () => {
    const s = store();
    await s.add(BASE);
    expect((await s.get("work"))!.lastUsedAt).toBeNull();
    await s.touch("work");
    const at = (await s.get("work"))!.lastUsedAt!;
    expect(new Date(at).toISOString()).toBe(at);
    await expect(s.touch("missing")).rejects.toThrow();
  });
});
