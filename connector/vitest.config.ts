import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
          // Tests pass their own SYNC stub in the env; reaching this one is a test bug.
          serviceBindings: { SYNC: () => new Response("SYNC is not stubbed in this test", { status: 599 }) },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      globalSetup: ["./vitest.global-setup.mjs"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
