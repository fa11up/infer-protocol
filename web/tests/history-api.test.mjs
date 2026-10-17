// worker/history-api.js: imdusd.com/api/v1, the public history index. Real SQL (node:sqlite standing in for D1, with
// infer-ops' public schema: tests/fixture-public-schema.sql, a byte-identical copy checked from infer-ops).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { handleHistoryApi, parseLogsQuery, ALLOWED, MAX_ROWS, MAX_SPAN, LOGS_SQL, META_SQL } from "../worker/history-api.js";
import worker from "../worker/index.js";

const SPEC = JSON.parse(readFileSync(new URL("../public-logs.json", import.meta.url), "utf8"));
const SCHEMA = readFileSync(new URL("./fixture-public-schema.sql", import.meta.url), "utf8");
const VAULT = SPEC.history.vault;
const FEED = SPEC.history.priceFeed;
const PM = SPEC.pegPool.poolManager;
const h32 = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;

function d1(seed = () => {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  seed(raw);
  const seen = [];
  const make = (text, args = []) => ({
    bind: (...a) => make(text, a),
    all: async () => {
      seen.push(text);
      return { results: raw.prepare(text).all(...args) };
    },
  });
  return { prepare: (t) => make(t), seen, raw };
}
const insert = (raw, address, block, logIndex, topics = [h32(1)], data = "0x") =>
  raw
    .prepare("INSERT INTO logs (address, block_number, log_index, tx_hash, tx_index, block_hash, block_time, topic0, topic1, topic2, topic3, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(address, block, logIndex, h32(block * 1000 + logIndex), 3, h32(block), 1_790_000_000 + block, topics[0] ?? null, topics[1] ?? null, topics[2] ?? null, topics[3] ?? null, data);
const setMeta = (raw, k, v) => raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(k, v);

function seeded({ through = 1_000_100, unverified } = {}) {
  return d1((raw) => {
    for (let b = 1_000_000; b < 1_000_200; b += 10) insert(raw, VAULT, b, 0, [h32(0xa), h32(b)]);
    for (let b = 1_000_005; b < 1_000_200; b += 10) insert(raw, FEED, b, 1);
    insert(raw, PM, 1_000_050, 2, [SPEC.pegPool.topics.swap, SPEC.pegPool.poolId]);
    insert(raw, PM, 1_000_060, 3, [SPEC.pegPool.topics.initialize, SPEC.pegPool.poolId]);
    setMeta(raw, "through", String(through));
    if (unverified) setMeta(raw, "unverified", JSON.stringify(unverified));
  });
}
const get = (db, path, { cache = null, env = {}, headers = {} } = {}) =>
  handleHistoryApi(new Request(`https://imdusd.com${path}`, { headers }), { PUBLIC_DB: db, ...env }, { cache });

/** A Map-backed stand-in for caches.default. */
function memCache() {
  const m = new Map();
  return {
    m,
    match: async (req) => m.get(req.url)?.clone(),
    put: async (req, res) => void m.set(req.url, res.clone()),
  };
}

test("logs: eth_getLogs-shaped hex fields, clamped to `through`, with through and unverified", async () => {
  const res = await get(seeded(), `/api/v1/logs?address=${VAULT}&fromBlock=1000000&toBlock=1000199`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.through, 1_000_100);
  assert.equal(body.unverified, false);
  assert.equal(body.toBlock, 1_000_100, "nothing past `through` is served");
  assert.equal(body.logs.length, 11);
  const l = body.logs[0];
  assert.deepEqual(Object.keys(l).sort(), ["address", "blockHash", "blockNumber", "blockTimestamp", "data", "logIndex", "removed", "topics", "transactionHash", "transactionIndex"]);
  assert.equal(l.blockNumber, "0xf4240");
  assert.equal(l.logIndex, "0x0");
  assert.equal(l.transactionIndex, "0x3");
  assert.equal(l.blockTimestamp, `0x${(1_790_000_000 + 1_000_000).toString(16)}`);
  assert.deepEqual(l.topics, [h32(0xa), h32(1_000_000)]);
  assert.equal(body.next, null);
  assert.equal(body.complete, true);
});

test("logs: several addresses (either letter case), topic filters, in block order", async () => {
  const res = await get(seeded(), `/api/v1/logs?address=${FEED.toUpperCase().replace("0X", "0x")},${VAULT}&fromBlock=1000000&toBlock=1000050`);
  const body = await res.json();
  assert.equal(body.logs.length, 11);
  assert.ok(body.logs.every((l, i, a) => i === 0 || BigInt(a[i - 1].blockNumber) <= BigInt(l.blockNumber)));
  const pool = await (await get(seeded(), `/api/v1/logs?address=${PM}&fromBlock=1000000&toBlock=1000100&topic0=${SPEC.pegPool.topics.swap}&topic1=${SPEC.pegPool.poolId}`)).json();
  assert.equal(pool.logs.length, 1);
  assert.equal(pool.logs[0].topics[0], SPEC.pegPool.topics.swap);
  const both = await (await get(seeded(), `/api/v1/logs?address=${PM}&fromBlock=1000000&toBlock=1000100&topic0=${SPEC.pegPool.topics.swap},${SPEC.pegPool.topics.initialize}`)).json();
  assert.equal(both.logs.length, 2);
});

test("logs: a range wholly past `through` is empty, not an error", async () => {
  const body = await (await get(seeded(), `/api/v1/logs?address=${VAULT}&fromBlock=1000101&toBlock=1000199`)).json();
  assert.deepEqual(body.logs, []);
  assert.equal(body.through, 1_000_100);
});

test("validation: allowlist, span cap, required and malformed parameters", async () => {
  const bad = [
    [`/api/v1/logs?address=0x${"12".repeat(20)}&fromBlock=1&toBlock=2`, /not in the public index/],
    [`/api/v1/logs?fromBlock=1&toBlock=2`, /address is required/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1`, /required block numbers/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=5&toBlock=4`, /after toBlock/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=0&toBlock=${MAX_SPAN}`, /spans at most/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=-1&toBlock=4`, /block numbers/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1.5&toBlock=4`, /block numbers/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1e3&toBlock=4000`, /block numbers/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=99999999999999999&toBlock=99999999999999999`, /block numbers/],
    [`/api/v1/logs?address=${VAULT}&address=${FEED}&fromBlock=1&toBlock=2`, /twice/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1&toBlock=2&topic2=${h32(1)}`, /unknown parameter/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1&toBlock=2&topic0=0x12`, /topic0: malformed/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1&toBlock=2&topic1=${[1, 2, 3, 4, 5].map(h32).join(",")}`, /topic1: 1 to 4/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1&toBlock=2&after=7`, /after is/],
    [`/api/v1/logs?address=${VAULT}&fromBlock=1&toBlock=2&after=9:0`, /outside/],
    [`/api/v1/logs?address=${[...ALLOWED, "0x" + "00".repeat(20)].join(",")}&fromBlock=1&toBlock=2`, /1 to 10/],
    [`/api/v1/meta?x=1`, /no parameters/],
  ];
  for (const [path, re] of bad) {
    const res = await get(seeded(), path);
    assert.equal(res.status, 400, path);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", "errors carry CORS too");
    assert.match((await res.json()).error, re, path);
  }
  // Exactly the cap is allowed.
  assert.equal((await get(seeded(), `/api/v1/logs?address=${VAULT}&fromBlock=0&toBlock=${MAX_SPAN - 1}`)).status, 200);
  assert.equal((await get(seeded(), "/api/v1/nope")).status, 404);
});

test("injection attempts never reach SQL: only the two fixed statements ever run, values bound", async () => {
  const attempts = [
    `address=${VAULT}'--&fromBlock=1&toBlock=2`,
    `address=${VAULT}&fromBlock=1;DROP TABLE logs&toBlock=2`,
    `address=${VAULT}&fromBlock=1&toBlock=2&topic0=${h32(1)}') OR 1=1 --`,
    `address=${encodeURIComponent(`${VAULT}") UNION SELECT * FROM meta --`)}&fromBlock=1&toBlock=2`,
    `address=${VAULT}&fromBlock=1&toBlock=2&after=1:1%20OR%201=1`,
    `address=${VAULT}&fromBlock=0x1&toBlock=0x2%27`,
  ];
  for (const a of attempts) {
    const db = seeded();
    const res = await get(db, `/api/v1/logs?${a}`);
    assert.equal(res.status, 400, a);
    assert.deepEqual(db.seen, [], "nothing was asked of the database");
  }
  // And the successful path runs exactly the fixed statements.
  const db = seeded();
  await get(db, `/api/v1/logs?address=${VAULT},${FEED}&fromBlock=1000000&toBlock=1000100&topic0=${h32(0xa)}`);
  assert.deepEqual(db.seen, [META_SQL, LOGS_SQL]);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM logs").get().n, 42, "the table is untouched");
});

test("row cap: a full page carries a `next` cursor that resumes exactly after the last log", async () => {
  const db = d1((raw) => {
    for (let i = 0; i < MAX_ROWS + 25; i++) insert(raw, VAULT, 2_000_000 + Math.floor(i / 3), i % 3);
    setMeta(raw, "through", "2100000");
  });
  const first = await (await get(db, `/api/v1/logs?address=${VAULT}&fromBlock=2000000&toBlock=2049999`)).json();
  assert.equal(first.logs.length, MAX_ROWS);
  assert.equal(first.complete, false);
  assert.match(first.next, /^\/api\/v1\/logs\?address=0x[0-9a-f]{40}&fromBlock=2000000&toBlock=2049999&after=\d+:\d$/);
  const second = await (await get(db, first.next)).json();
  assert.equal(second.logs.length, 25);
  assert.equal(second.next, null);
  const keys = [...first.logs, ...second.logs].map((l) => `${l.blockNumber}:${l.logIndex}`);
  assert.equal(new Set(keys).size, MAX_ROWS + 25, "no log twice, none skipped");
});

test("CORS: every answer is open to any origin; OPTIONS is a preflight; only GET/HEAD", async () => {
  const ok = await get(seeded(), "/api/v1/meta", { headers: { origin: "https://example.org" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "*");
  const pre = await handleHistoryApi(new Request("https://imdusd.com/api/v1/logs", { method: "OPTIONS" }), { PUBLIC_DB: seeded() }, { cache: null });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods"), /GET/);
  const post = await handleHistoryApi(new Request("https://imdusd.com/api/v1/logs", { method: "POST", body: "{}" }), { PUBLIC_DB: seeded() }, { cache: null });
  assert.equal(post.status, 405);
});

test("cache: a closed, verified range is kept a day; one reaching `through`, or while unverified, a minute; hits skip the database", async () => {
  const cacheTtl = (r) => Number(/max-age=(\d+)/.exec(r.headers.get("cache-control"))[1]);
  const closed = await get(seeded(), `/api/v1/logs?address=${VAULT}&fromBlock=1000000&toBlock=1000050`);
  assert.equal(cacheTtl(closed), 86_400);
  const open = await get(seeded(), `/api/v1/logs?address=${VAULT}&fromBlock=1000000&toBlock=1000100`);
  assert.equal(cacheTtl(open), 60, "toBlock = through");
  const past = await get(seeded(), `/api/v1/logs?address=${VAULT}&fromBlock=1000000&toBlock=1000150`);
  assert.equal(cacheTtl(past), 60);
  const marked = await get(seeded({ unverified: { windows: [[1000000, 1000049]] } }), `/api/v1/logs?address=${VAULT}&fromBlock=1000000&toBlock=1000050`);
  assert.equal(cacheTtl(marked), 60);
  assert.equal((await marked.json()).unverified, true);
  assert.equal(cacheTtl(await get(seeded(), "/api/v1/meta")), 60);
  // Equivalent questions share one entry; a hit never reaches D1.
  const cache = memCache();
  const db = seeded();
  const a = await get(db, `/api/v1/logs?address=${VAULT},${FEED}&fromBlock=1000000&toBlock=1000050`, { cache });
  assert.equal(a.headers.get("x-history-cache"), "miss");
  const before = db.seen.length;
  const b = await get(db, `/api/v1/logs?toBlock=1000050&fromBlock=1000000&address=${FEED.toUpperCase().replace("0X", "0x")},${VAULT}`, { cache });
  assert.equal(b.headers.get("x-history-cache"), "hit");
  assert.equal(db.seen.length, before);
  assert.deepEqual(await b.json(), await a.json());
});

test("rate limit: a visitor over HISTORY_REQUESTS gets a 429 on a miss, a cache hit is still served", async () => {
  const limiter = { limit: async () => ({ success: false }) };
  const cache = memCache();
  const db = seeded();
  const path = `/api/v1/logs?address=${VAULT}&fromBlock=1000000&toBlock=1000050`;
  const r = await get(db, path, { cache, env: { HISTORY_REQUESTS: limiter } });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
  await get(db, path, { cache });
  assert.equal((await get(db, path, { cache, env: { HISTORY_REQUESTS: limiter } })).status, 200);
});

test("meta: through, unverified windows, the allowlist and the limits", async () => {
  const body = await (await get(seeded({ unverified: { windows: [[1000000, 1004999]], since: "x", detail: "y" } }), "/api/v1/meta")).json();
  assert.equal(body.chainId, 1);
  assert.equal(body.through, 1_000_100);
  assert.equal(body.unverified, true);
  assert.deepEqual(body.unverifiedWindows, [[1000000, 1004999]]);
  assert.equal(body.floor, SPEC.floor);
  assert.equal(Object.keys(body.addresses).length, 10);
  assert.deepEqual(body.limits, { maxSpan: MAX_SPAN, maxRows: MAX_ROWS, maxAddresses: 10 });
  const empty = await (await get(d1(), "/api/v1/meta")).json();
  assert.equal(empty.through, null);
});

test("no binding, or a database that fails, is a 503 and never a silent empty answer", async () => {
  const none = await handleHistoryApi(new Request("https://imdusd.com/api/v1/meta"), {}, { cache: null });
  assert.equal(none.status, 503);
  const broken = { prepare: () => ({ bind() { return this; }, all: async () => { throw Error("D1 down"); } }) };
  assert.equal((await get(broken, `/api/v1/logs?address=${VAULT}&fromBlock=1&toBlock=2`)).status, 503);
});

test("the router sends /api/v1/* to the index and nothing else", async () => {
  const assets = { fetch: async () => new Response("asset") };
  const env = { PUBLIC_DB: seeded(), ASSETS: assets };
  const api = await worker.fetch(new Request("https://imdusd.com/api/v1/meta"), env);
  assert.equal((await api.json()).through, 1_000_100);
  assert.equal(await (await worker.fetch(new Request("https://imdusd.com/api/v2/meta"), env)).text(), "asset");
});

/* ---------- the Worker can only ever see the public database ---------- */

const jsonc = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
const INFER_OPS_PRIVATE_DB = "0c06f656-4b08-4ce4-ba92-1a55e97bb58a";

test("wrangler: imdusd.com is bound to the public index only, never infer-ops' private database", () => {
  for (const file of ["../wrangler.jsonc", "../wrangler.infer.jsonc", "../wrangler.whitepaper.jsonc"]) {
    const cfg = jsonc(file);
    const dbs = cfg.d1_databases ?? [];
    for (const d of dbs) {
      assert.equal(d.binding, "PUBLIC_DB", file);
      assert.equal(d.database_name, "imdusd-public", file);
      assert.notEqual(d.database_id, INFER_OPS_PRIVATE_DB, file);
    }
    for (const k of ["kv_namespaces", "r2_buckets", "durable_objects", "services", "hyperdrive"]) assert.ok(!cfg[k], `${file}: no ${k}`);
  }
  const main = jsonc("../wrangler.jsonc");
  assert.equal(main.d1_databases.length, 1);
  assert.ok(main.assets.run_worker_first.includes("/api/v1/*"));
  assert.ok(main.ratelimits.some((r) => r.name === "HISTORY_REQUESTS"));
  // The Worker's code reads no other database binding.
  for (const f of readdirSync(new URL("../worker/", import.meta.url))) {
    const src = readFileSync(new URL(`../worker/${f}`, import.meta.url), "utf8");
    assert.ok(!/env\.DB\b/.test(src), `${f} reads env.DB`);
    assert.ok(!/\.prepare\(/.test(src) || f === "history-api.js", `${f} queries a database`);
  }
});

test("the public schema holds only logs and meta, and the API's SQL touches nothing else and writes nothing", () => {
  const tables = [...SCHEMA.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)].map((m) => m[1]).sort();
  assert.deepEqual(tables, ["logs", "meta"]);
  for (const sql of [LOGS_SQL, META_SQL]) {
    assert.match(sql, /^\s*SELECT/i);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|PRAGMA)\b/i.test(sql));
    const from = [...sql.matchAll(/FROM\s+(\w+)/gi)].map((m) => m[1]).filter((t) => t !== "json_each");
    assert.ok(from.every((t) => t === "logs" || t === "meta"), from.join());
  }
});

test("public-logs.json agrees with the terminal's own config", async () => {
  const dep = JSON.parse(readFileSync(new URL("../deployment-source.json", import.meta.url), "utf8"));
  const by = Object.fromEntries(dep.contracts.map((c) => [c.name, c.address.toLowerCase()]));
  assert.equal(SPEC.launchId, dep.launchId);
  assert.equal(SPEC.chainId, dep.chainId);
  assert.equal(SPEC.history.vault, by.ParameterizedVault);
  assert.equal(SPEC.history.priceFeed, by.PriceFeed);
  assert.equal(SPEC.history.spotFeed, by.SpotFeed);
  assert.equal(SPEC.history.nhiFeed, by.NhiFeed);
  const linked = JSON.parse(readFileSync(new URL("../rpc-allow-terminal.json", import.meta.url), "utf8")).contracts;
  for (const k of ["stablecoin", "treasury", "parameters", "workOracle"]) assert.equal(SPEC.history[k], linked[k].toLowerCase(), k);
  const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(config, new RegExp(`"${SPEC.launchId}": ${SPEC.floor}n`), "historyFloor");
  assert.ok(config.includes(SPEC.pegPool.poolId) && config.includes(`fromBlock: ${SPEC.pegPool.fromBlock.toLocaleString("en-US").replace(/,/g, "_")}`), "pegPools");
  assert.ok(config.includes(`positionManager: "${SPEC.pegPool.positionManager}"`));
  assert.ok(config.includes(`1: "${SPEC.pegPool.poolManager}"`), "poolManagers");
  const pool = readFileSync(new URL("../../points/pool.ts", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(SPEC.pegPool.topics)) assert.ok(pool.includes(`${k}: "${v}"`), k);
  assert.ok(pool.includes(`transfer: "${SPEC.pegPool.transfer}"`));
});
