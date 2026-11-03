import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function must(value, what) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing ${what}`);
  }
  return value;
}

// Everything account- or host-specific is set below; the template must not carry it.
const FORBIDDEN_TOP_LEVEL = [
  "kv_namespaces", "d1_databases", "services", "routes", "route",
  "account_id", "workers_dev", "preview_urls", "name",
];

// Strip // and /* */ comments and trailing commas from JSONC, leaving string contents intact.
function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) throw new Error("unterminated string in JSONC");
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("unterminated comment in JSONC");
      i = end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return stripTrailingCommas(out);
}

function stripTrailingCommas(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j += 1;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export function renderConnectorWrangler({ template, settings, hostname, tofuOutputs }) {
  const connector = must(settings?.connector, "settings.connector");

  const cfg = JSON.parse(stripJsonc(must(template, "template")));
  for (const key of FORBIDDEN_TOP_LEVEL) {
    if (key in cfg) throw new Error(`forbidden top-level key: ${key}`);
  }

  cfg.name = must(connector.workerName, "settings.connector.workerName");
  cfg.workers_dev = false;
  cfg.preview_urls = false;
  cfg.routes = [{ pattern: must(hostname, "hostname"), custom_domain: true }];
  cfg.kv_namespaces = [
    { binding: "OAUTH_KV", id: must(tofuOutputs?.connector_oauth_kv_id, "connector_oauth_kv_id") },
  ];
  cfg.d1_databases = [
    {
      binding: "DB",
      database_name: must(connector.d1DatabaseName, "settings.connector.d1DatabaseName"),
      database_id: must(tofuOutputs?.connector_d1_id, "connector_d1_id"),
      migrations_dir: "migrations",
    },
  ];
  cfg.services = [
    { binding: "SYNC", service: must(settings.workerName, "settings.workerName") },
  ];

  return `${JSON.stringify(cfg, null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      template: { type: "string" },
      settings: { type: "string" },
      hostname: { type: "string" },
      "tofu-outputs": { type: "string" },
      out: { type: "string" },
    },
  });
  for (const k of ["template", "settings", "hostname", "tofu-outputs", "out"]) {
    if (!values[k]) {
      console.error(
        "usage: render-connector-wrangler.mjs --template <jsonc> --settings <json> --hostname <host> --tofu-outputs <json> --out <path>",
      );
      process.exit(2);
    }
  }
  const settings = JSON.parse(readFileSync(values.settings, "utf8"));
  const tofu = JSON.parse(readFileSync(values["tofu-outputs"], "utf8"));
  const json = renderConnectorWrangler({
    template: readFileSync(values.template, "utf8"),
    settings,
    hostname: values.hostname,
    tofuOutputs: {
      connector_oauth_kv_id: tofu.connector_oauth_kv_id?.value,
      connector_d1_id: tofu.connector_d1_id?.value,
    },
  });
  writeFileSync(values.out, json);
}
