import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { htmlPage } from "../src/html";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("connector icon", () => {
  for (const path of ["/favicon.ico", "/favicon.png"]) {
    it(`GET ${path} serves the Logseq logo as a cacheable PNG`, async () => {
      const res = await exports.default.fetch(`https://mcp.example.com${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=604800, immutable");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    });
  }

  it("answers 404 to a POST to the icon", async () => {
    const res = await exports.default.fetch("https://mcp.example.com/favicon.png", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("links the icon from HTML pages and lets the CSP load it", async () => {
    const res = htmlPage(200, "Title", "<p>x</p>");
    expect(await res.text()).toContain('<link rel="icon" type="image/png" href="/favicon.png">');
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
  });
});
