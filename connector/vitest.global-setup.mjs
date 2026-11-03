import { existsSync } from "node:fs";

/** The tools are built from the vendored upstream API; fail with the fix rather than a module error. */
export default function checkVendor() {
  for (const file of ["vendor/openapi.json", "vendor/semantic_api_tools.mjs"]) {
    if (!existsSync(new URL(file, import.meta.url))) {
      throw new Error(
        `connector/${file} is missing: run scripts/vendor-upstream-api.sh <built upstream checkout> before the connector tests`,
      );
    }
  }
}
