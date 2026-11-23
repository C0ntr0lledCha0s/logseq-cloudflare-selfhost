import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { healthTagPropertiesSecret, renderWrangler } from "./render-wrangler.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = readFileSync(
  join(root, "scripts", "fixtures", "upstream-wrangler.toml"),
  "utf8",
);
const settings = JSON.parse(
  readFileSync(join(root, "config", "settings.json"), "utf8"),
);
const hostname = "sync.example.com";
const tofuOutputs = { d1_database_id: "00000000-0000-0000-0000-000000000000" };

function render(over = {}) {
  const { upstreamToml = fixture, ...rest } = over;
  return parse(
    renderWrangler({ upstreamToml, settings, tofuOutputs, hostname, ...rest }),
  );
}

// Insert a var into the top-level [vars] table of the fixture.
function withVar(line) {
  return fixture.replace("[vars]\n", `[vars]\n${line}\n`);
}

test("free plan drops limits and worker_loaders", () => {
  const out = render({ settings: { ...settings, plan: "free" } });
  assert.equal(out.limits, undefined);
  assert.equal(out.worker_loaders, undefined);
  assert.equal(out.ratelimits.length, 2);
  assert.ok(out.durable_objects);
  assert.ok(out.version_metadata);
});

test("paid plan keeps limits and drops worker_loaders", () => {
  const out = render({ settings: { ...settings, plan: "paid" } });
  assert.equal(out.limits.cpu_ms, 300000);
  assert.equal(out.worker_loaders, undefined);
});

test("names and ids come from settings, domain from hostname", () => {
  const out = render();
  assert.equal(out.name, "logseq-sync");
  assert.equal(out.workers_dev, false);
  assert.equal(out.preview_urls, false);
  assert.deepEqual({ ...out.routes[0] }, {
    pattern: "sync.example.com",
    custom_domain: true,
  });
  assert.equal(out.r2_buckets[0].bucket_name, "logseq-sync-assets");
  assert.equal(out.d1_databases[0].database_name, "logseq-sync-index");
  assert.equal(out.d1_databases[0].database_id, tofuOutputs.d1_database_id);
  const ns = Object.fromEntries(
    out.ratelimits.map((r) => [r.name, r.namespace_id]),
  );
  assert.deepEqual(ns, {
    SEMANTIC_READ_RATE_LIMITER: "1001",
    SEMANTIC_WRITE_RATE_LIMITER: "1002",
  });
  assert.equal(out.ratelimits[0].simple.limit, 120);
  assert.equal("env" in out, false);
  assert.equal(out.main, "entry.mjs");
});

test("unsafe or unused vars are removed or rejected", () => {
  const out = render({
    upstreamToml: withVar('COGNITO_CLIENT_IDS = "a,b"\nOPENAI_APPS_CHALLENGE = "x"'),
  });
  assert.equal("COGNITO_CLIENT_IDS" in out.vars, false);
  assert.equal("OPENAI_APPS_CHALLENGE" in out.vars, false);
  assert.equal(out.vars.COGNITO_CLIENT_ID, "69cs1lgme7p8kbgld8n5kseii6");
});

test("forbidden vars throw", () => {
  for (const key of ["DB_SYNC_ALLOW_UNVERIFIED_JWT_CLAIMS", "SENTRY_DSN"]) {
    assert.throws(
      () => render({ upstreamToml: withVar(`${key} = "true"`) }),
      new RegExp(`forbidden var: ${key}`),
    );
  }
});

test("timeZone becomes the TIMEZONE var that sets 'today'", () => {
  assert.equal(render().vars.TIMEZONE, "Pacific/Auckland", "the owner's zone, from config/settings.json");
  const { timeZone: _omit, ...withoutZone } = settings;
  assert.equal("TIMEZONE" in render({ settings: withoutZone }).vars, false, "unset: the server uses UTC");
  const { health: _health, ...withoutZoneOrHealth } = withoutZone;
  assert.equal(
    render({ upstreamToml: fixture.replace(/\[vars\][^[]*/, ""), settings: withoutZoneOrHealth }).vars,
    undefined,
    "unset adds no [vars] table",
  );
  assert.equal(render({ settings: { ...settings, timeZone: "UTC" } }).vars.TIMEZONE, "UTC");
  assert.equal(
    render({ upstreamToml: fixture.replace(/\[vars\][^[]*/, ""), settings }).vars.TIMEZONE,
    "Pacific/Auckland",
    "upstream with no [vars] table still gets it",
  );
});

test("an unknown or blank timeZone throws", () => {
  for (const timeZone of ["Mars/Olympus", "", "  ", 13]) {
    assert.throws(() => render({ settings: { ...settings, timeZone } }), /settings\.timeZone/);
  }
});

// Reviews r2-tests-3, r2-correctness-1 and r2-light-1: wrangler deploy prints every [vars] value in
// the public run log, so the pairs are a Worker secret (healthTagPropertiesSecret), never a var.
test("HEALTH_TAG_PROPERTIES is never a [vars] entry", () => {
  const pairs = [{ tag: "zz Book", property: "zz author" }];
  assert.equal("HEALTH_TAG_PROPERTIES" in render().vars, false, "the committed settings");
  assert.equal(
    "HEALTH_TAG_PROPERTIES" in render({ settings: { ...settings, health: { expectedTagProperties: pairs } } }).vars,
    false,
    "settings.json pairs",
  );
  assert.equal(
    "HEALTH_TAG_PROPERTIES" in render({ upstreamToml: withVar(`HEALTH_TAG_PROPERTIES = '${JSON.stringify(pairs)}'`) }).vars,
    false,
    "nor one carried over from upstream",
  );
  assert.equal(render().vars.TIMEZONE, "Pacific/Auckland", "the other vars are kept");
});

function secret(over = {}) {
  return JSON.parse(healthTagPropertiesSecret({ settings, ...over }));
}

test("health.expectedTagProperties becomes the HEALTH_TAG_PROPERTIES secret, JSON-encoded", () => {
  assert.deepEqual(secret(), [], "the committed default: no pairs");
  const pairs = [{ tag: "zz Book", property: "zz author" }, { tag: "zz Book", property: "user.property/rating" }];
  assert.deepEqual(secret({ settings: { ...settings, health: { expectedTagProperties: pairs } } }), pairs);
  const fifty = Array.from({ length: 50 }, (_, i) => ({ tag: "zz Book", property: `zz p${i}` }));
  assert.equal(secret({ settings: { ...settings, health: { expectedTagProperties: fifty } } }).length, 50,
    "50 pairs is the cap, and allowed");
  const extra = [{ tag: "zz Book", property: "zz author", note: "dropped" }];
  assert.deepEqual(secret({ settings: { ...settings, health: { expectedTagProperties: extra } } }),
    [{ tag: "zz Book", property: "zz author" }], "only tag and property are kept");
});

test("an absent health.expectedTagProperties sends [] so a deploy clears the Worker's old pairs", () => {
  const { health: _omit, ...withoutHealth } = settings;
  assert.deepEqual(secret({ settings: withoutHealth }), [], "no health key");
  assert.deepEqual(secret({ settings: { ...withoutHealth, health: {} } }), [], "health without expectedTagProperties");
});

test("a malformed health.expectedTagProperties throws naming the entry", () => {
  const key = "settings.health.expectedTagProperties";
  const cases = [
    [{ tag: "zz Book", property: "zz author" }, `${key} must be an array`],
    ["[]", `${key} must be an array`],
    [Array.from({ length: 51 }, () => ({ tag: "zz Book", property: "zz author" })), `${key} must hold at most 50 pairs (got 51)`],
    [[{ tag: "zz Book", property: "zz author" }, "zz Book/zz author"], `${key}[1] must be an object with tag and property`],
    [[null], `${key}[0] must be an object with tag and property`],
    [[["zz Book", "zz author"]], `${key}[0] must be an object with tag and property`],
    [[{ tag: "zz Book", property: "zz author" }, { property: "zz author" }], `${key}[1].tag must be a non-empty string`],
    [[{ tag: "zz Book", property: "" }], `${key}[0].property must be a non-empty string`],
    [[{ tag: "  ", property: "zz author" }], `${key}[0].tag must be a non-empty string`],
    [[{ tag: "zz Book", property: 7 }], `${key}[0].property must be a non-empty string`],
  ];
  for (const [expectedTagProperties, message] of cases) {
    assert.throws(
      () => secret({ settings: { ...settings, health: { expectedTagProperties } } }),
      (error) => error.message === message,
      `${JSON.stringify(expectedTagProperties).slice(0, 60)} -> ${message}`,
    );
  }
  assert.throws(() => secret({ settings: { ...settings, health: [] } }), /settings\.health must be an object/);
});

// Review r1-light-1: CI renders from the committed settings.json, whose default must stay [] in a
// public repo, so the owner's pairs come from the HEALTH_TAG_PROPERTIES GitHub secret instead.
test("a HEALTH_TAG_PROPERTIES GitHub secret replaces settings.health.expectedTagProperties", () => {
  const pairs = [{ tag: "zz Book", property: "zz author" }];
  assert.deepEqual(secret({ healthTagProperties: JSON.stringify(pairs) }), pairs, "over the committed []");
  const { health: _omit, ...withoutHealth } = settings;
  assert.deepEqual(secret({ settings: withoutHealth, healthTagProperties: JSON.stringify(pairs) }), pairs,
    "and with no health key at all");
  assert.deepEqual(secret({ healthTagProperties: "[]" }), [], "[] is a value: no pairs");
  for (const unset of [undefined, "", "  "]) {
    const settingsPairs = [{ tag: "zz Novel", property: "zz series" }];
    assert.deepEqual(
      secret({ settings: { ...settings, health: { expectedTagProperties: settingsPairs } }, healthTagProperties: unset }),
      settingsPairs,
      `an unset or blank secret (${JSON.stringify(unset)}) leaves settings.json in charge`,
    );
  }
});

test("a malformed HEALTH_TAG_PROPERTIES secret throws naming it and the entry", () => {
  const key = "the HEALTH_TAG_PROPERTIES secret";
  const cases = [
    ["not json", `${key} is not JSON`],
    [JSON.stringify({ tag: "zz Book", property: "zz author" }), `${key} must be an array`],
    [JSON.stringify(Array.from({ length: 51 }, () => ({ tag: "zz Book", property: "zz author" }))), `${key} must hold at most 50 pairs (got 51)`],
    [JSON.stringify([{ tag: "zz Book" }]), `${key}[0].property must be a non-empty string`],
    [JSON.stringify([{ tag: "zz Book", property: "zz author" }, "zz Book/zz author"]), `${key}[1] must be an object with tag and property`],
  ];
  for (const [healthTagProperties, message] of cases) {
    assert.throws(() => secret({ healthTagProperties }), (error) => error.message === message, message);
  }
});

test("unknown plan throws", () => {
  assert.throws(() => render({ settings: { ...settings, plan: "pro" } }), /plan/);
});

test("unknown rate limiter throws", () => {
  const { SEMANTIC_WRITE_RATE_LIMITER: _drop, ...rest } =
    settings.rateLimitNamespaces;
  assert.throws(
    () => render({ settings: { ...settings, rateLimitNamespaces: rest } }),
    /SEMANTIC_WRITE_RATE_LIMITER/,
  );
});

for (const [key, value] of [
  ["deleted_classes", '[ "SyncDO" ]'],
  ["renamed_classes", '[ { from = "SyncDO", to = "Other" } ]'],
  ["transferred_classes", '[ { from = "SyncDO", from_script = "x", to = "Other" } ]'],
]) {
  test(`${key} in a migration is refused`, () => {
    const toml = fixture.replace(
      '[[migrations]]\ntag = "v1"',
      `[[migrations]]\ntag = "v9"\n${key} = ${value}\n\n[[migrations]]\ntag = "v1"`,
    );
    assert.notEqual(toml, fixture);
    assert.throws(() => render({ upstreamToml: toml }), /destructive Durable Object migration v9 refused/);
  });
}

test("missing d1_database_id throws", () => {
  assert.throws(() => render({ tofuOutputs: {} }), /d1_database_id/);
});

test("rendered output contains no upstream account identifiers", () => {
  const up = parse(fixture);
  const sections = [up, ...Object.values(up.env)];
  const ours = new Set(["1001", "1002"]);
  const leaks = new Set();
  for (const s of sections) {
    for (const b of s.r2_buckets ?? []) leaks.add(b.bucket_name);
    for (const d of s.d1_databases ?? []) {
      leaks.add(d.database_name);
      leaks.add(d.database_id);
    }
    for (const r of s.ratelimits ?? []) {
      if (!ours.has(r.namespace_id)) leaks.add(r.namespace_id);
    }
  }
  assert.ok(leaks.size >= 6);
  for (const plan of ["free", "paid"]) {
    const text = renderWrangler({
      upstreamToml: fixture,
      settings: { ...settings, plan },
      tofuOutputs,
      hostname,
    });
    for (const id of leaks) {
      assert.equal(text.includes(`"${id}"`), false, `${plan} leaks ${id}`);
    }
  }
});

test("renamed, missing or extra r2/d1 bindings throw", () => {
  const swap = (from, to) => fixture.replace(from, to);
  assert.throws(
    () => render({ upstreamToml: swap('binding = "LOGSEQ_SYNC_ASSETS"\nbucket_name = "logseq-sync-assets-prod"', 'binding = "RENAMED"\nbucket_name = "logseq-sync-assets-prod"') }),
    /exactly one binding: LOGSEQ_SYNC_ASSETS/,
  );
  assert.throws(
    () => render({ upstreamToml: swap('binding = "DB"\ndatabase_name', 'binding = "OTHER"\ndatabase_name') }),
    /exactly one binding: DB/,
  );
  const extraR2 = fixture.replace("[[d1_databases]]", '[[r2_buckets]]\nbinding = "X"\nbucket_name = "x"\n\n[[d1_databases]]');
  assert.throws(() => render({ upstreamToml: extraR2 }), /r2_buckets/);
  const extraD1 = fixture.replace("[[migrations]]", '[[d1_databases]]\nbinding = "X"\ndatabase_name = "x"\ndatabase_id = "y"\n\n[[migrations]]');
  assert.throws(() => render({ upstreamToml: extraD1 }), /d1_databases/);
});

test("account-scoped top-level keys throw", () => {
  const cases = {
    kv_namespaces: '[[kv_namespaces]]\nbinding = "KV"\nid = "x"\n\n',
    queues: '[[queues.producers]]\nbinding = "Q"\nqueue = "q"\n\n',
    services: '[[services]]\nbinding = "S"\nservice = "s"\n\n',
    hyperdrive: '[[hyperdrive]]\nbinding = "H"\nid = "h"\n\n',
    vectorize: '[[vectorize]]\nbinding = "V"\nindex_name = "v"\n\n',
    account_id: null,
    route: null,
    routes: null,
  };
  for (const [key, block] of Object.entries(cases)) {
    const toml = block
      ? block + fixture
      : `${key} = ${key === "routes" ? '["a.example.com"]' : '"x"'}\n` + fixture;
    assert.throws(() => render({ upstreamToml: toml }), new RegExp(`forbidden top-level key: ${key}`), key);
  }
});

test("missing or empty hostname is rejected", () => {
  for (const bad of [undefined, null, ""]) {
    assert.throws(() => render({ hostname: bad }), /missing hostname/);
  }
});

test("invocation logs are on, whatever upstream sets", () => {
  const out = render();
  assert.equal(out.observability.enabled, true);
  assert.equal(out.observability.logs.invocation_logs, true);
  const noBlock = render({
    upstreamToml: fixture.replace(/\[observability\]\nenabled = true\n\n\[observability\.logs\]\ninvocation_logs = false\n/, ""),
  });
  assert.equal(noBlock.observability.enabled, true);
  assert.equal(noBlock.observability.logs.invocation_logs, true);
});
