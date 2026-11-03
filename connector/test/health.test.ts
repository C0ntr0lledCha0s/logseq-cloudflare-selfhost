import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("connector worker", () => {
  it("GET /health returns {ok:true}", async () => {
    const res = await exports.default.fetch("https://mcp.example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 404 for unknown routes and non-GET /health", async () => {
    expect((await exports.default.fetch("https://mcp.example.com/nope")).status).toBe(404);
    const post = await exports.default.fetch("https://mcp.example.com/health", { method: "POST" });
    expect(post.status).toBe(404);
  });
});
