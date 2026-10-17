// The browser's use of the public history index (src/history-index.ts via history.ts and peg-logs.ts), against the real
// /api/v1 handler (worker/history-api.js) over node:sqlite: the index serves [floor, through − 12], the chain only the
// rest, and every way the index can be unusable falls back to the chain path silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleHistoryApi } from "../worker/history-api.js";

const scratch = new URL("../../test/scratch/history-index-module.mjs", import.meta.url);
await mkdir(new URL(".", scratch), { recursive: true });
const siteStub = new URL("../../test/scratch/history-index-site-stub.mjs", import.meta.url);
await writeFile(
  siteStub,
  'export const appRoot = () => new URL("http://localhost/");\nexport const href = (p = "") => new URL(p, appRoot()).href;\nexport const TERMINAL = true;\nexport const WHITEPAPER = "";\nexport const SiteHeader = () => null;\n',
);
const entry = new URL("../../test/scratch/history-index-entry.ts", import.meta.url);
const src = (f) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).pathname);
await writeFile(entry, `export * from ${src("history.ts")};\nexport * from ${src("peg-logs.ts")};\nexport * from ${src("history-index.ts")};\n`);
const { build } = await import("vite");
await build({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  mode: "test",
  resolve: { alias: [{ find: /^\.\/site$/, replacement: siteStub.pathname }] },
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: entry.pathname,
    outDir: new URL(".", scratch).pathname,
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rolldownOptions: { output: { entryFileNames: "history-index-module.mjs" } },
  },
});
const M = await import(scratch.href);

const SPEC = JSON.parse(await readFile(new URL("../public-logs.json", import.meta.url), "utf8"));
const SCHEMA = await readFile(new URL("./fixture-public-schema.sql", import.meta.url), "utf8");
const HEAD = 26_215_600;
const THROUGH = HEAD - 20;
const F = SPEC.floor;
const GROUP = Object.values(SPEC.history);
const h32 = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, "0");
const pad = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
const T = SPEC.pegPool.topics;
const PM = SPEC.pegPool.poolManager;
const POSM = SPEC.pegPool.positionManager;

/** One synthetic chain: logs of every history contract, the peg pool and one position NFT, up to HEAD. */
function chain() {
  const out = [];
  const add = (address, block, topics, data = "0x") => out.push({ address, topics, data, blockNumber: `0x${block.toString(16)}`, logIndex: `0x${(out.length % 9).toString(16)}`, transactionHash: h32(block * 100 + out.length) });
  GROUP.forEach((a, k) => {
    if (a === SPEC.history.workOracle) return; // one contract with no logs at all
    for (let b = F + 5 + k; b <= HEAD; b += 4_321) add(a, b, [h32(0xe0 + k)], `0x${word(b)}`);
    add(a, HEAD - 3, [h32(0xe0 + k)]); // inside the chain's tail
  });
  const P = SPEC.pegPool.fromBlock;
  add(PM, P, [T.initialize, SPEC.pegPool.poolId], `0x${word(0)}${word(0)}${word(0)}${word(0)}${word(-276325)}`);
  add(PM, P + 9, [T.modifyLiquidity, SPEC.pegPool.poolId, pad(POSM)], `0x${word(-276424)}${word(-276224)}${word(1000)}${word(451683)}`);
  add(POSM, P + 9, [SPEC.pegPool.transfer, h32(0), pad("0x" + "cd".repeat(20)), h32(451683)]);
  for (let b = P + 50; b <= HEAD; b += 3_000) add(PM, b, [T.swap, SPEC.pegPool.poolId, pad("0x" + "ab".repeat(20))], `0x${word(1)}${word(2)}${word(3)}${word(4)}${word(-276330)}`);
  add(PM, HEAD - 2, [T.swap, SPEC.pegPool.poolId, pad("0x" + "ab".repeat(20))], `0x${word(1)}${word(2)}${word(3)}${word(4)}${word(-276331)}`);
  add(POSM, HEAD - 1, [SPEC.pegPool.transfer, pad("0x" + "cd".repeat(20)), pad("0x" + "dd".repeat(20)), h32(451683)]);
  return out;
}
const LOGS = chain();
const inRange = (l, a, b) => BigInt(l.blockNumber) >= BigInt(a) && BigInt(l.blockNumber) <= BigInt(b);
const matches = (l, p) => [p.address].flat().map((x) => x.toLowerCase()).includes(l.address) && (p.topics ?? []).every((t, k) => t == null || [t].flat().includes(l.topics[k]));

function indexDb({ through = THROUGH, unverified } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA);
  const ins = raw.prepare("INSERT INTO logs (address, block_number, log_index, tx_hash, block_time, topic0, topic1, topic2, topic3, data) VALUES (?,?,?,?,?,?,?,?,?,?)");
  for (const l of LOGS) if (BigInt(l.blockNumber) <= BigInt(through)) ins.run(l.address, Number(BigInt(l.blockNumber)), Number(BigInt(l.logIndex)), l.transactionHash, 1, l.topics[0] ?? null, l.topics[1] ?? null, l.topics[2] ?? null, l.topics[3] ?? null, l.data);
  raw.prepare("INSERT INTO meta VALUES ('through', ?)").run(String(through));
  if (unverified) raw.prepare("INSERT INTO meta VALUES ('unverified', ?)").run(JSON.stringify(unverified));
  const make = (text, args = []) => ({ bind: (...a) => make(text, a), all: async () => ({ results: raw.prepare(text).all(...args) }) });
  return { prepare: (t) => make(t) };
}

/** A runtime whose chain is LOGS, recording every eth_getLogs; fetch routes /api/v1 to the real handler. */
function setup({ host = "imdusd.com", db = indexDb(), api } = {}) {
  const ranges = [];
  const apiCalls = [];
  globalThis.location = { hostname: host, origin: `https://${host}` };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (!u.pathname.startsWith("/api/v1/")) throw Error(`unexpected fetch ${url}`);
    apiCalls.push(u.pathname + u.search);
    if (api) return api(u);
    return handleHistoryApi(new Request(u), { PUBLIC_DB: db }, { cache: null });
  };
  const getLogs = async (p) => {
    ranges.push([Number(p.fromBlock), Number(p.toBlock)]);
    return LOGS.filter((l) => inRange(l, p.fromBlock, p.toBlock) && matches(l, p));
  };
  const client = {
    getLogs,
    request: async ({ method, params }) => {
      assert.equal(method, "eth_getLogs");
      return getLogs(params[0]);
    },
  };
  const r = { config: { chainId: 1, launchId: SPEC.launchId }, client };
  M.historyGroup(r, GROUP);
  return { r, ranges, apiCalls };
}
const vault = { address: SPEC.history.vault, abi: [] };
const oracle = { address: SPEC.history.workOracle, abi: [] };
const keys = (logs) => logs.map((l) => `${BigInt(l.blockNumber)}:${Number(BigInt(l.logIndex))}`);

test("history: the index serves up to through − 12, the chain only the tail, and the result is the chain's", async () => {
  const { r, ranges, apiCalls } = setup();
  const h = await M.history(r, vault, BigInt(HEAD));
  assert.equal(h.source, "Index");
  assert.equal(h.index, BigInt(THROUGH));
  const want = LOGS.filter((l) => l.address === SPEC.history.vault);
  assert.deepEqual(keys(h.logs), keys(want));
  // Chain reads: only the aligned window(s) holding (through − 12, head].
  assert.ok(ranges.length <= 2, JSON.stringify(ranges));
  for (const [, b] of ranges) assert.ok(b >= THROUGH - 11);
  // Index reads: meta plus one request per aligned 50,000-block chunk.
  assert.equal(apiCalls.filter((c) => c.startsWith("/api/v1/meta")).length, 1);
  assert.equal(apiCalls.filter((c) => c.startsWith("/api/v1/logs")).length, 2);
  // The other contracts of the group come from the same index answer: no further API request.
  const before = apiCalls.length;
  const o = await M.history(r, oracle, BigInt(HEAD));
  assert.equal(o.logs.length, 0, "a contract with no logs is believed from the verified index, not sent to Blockscout");
  assert.equal(apiCalls.length, before);
});

test("history: the same answer whether through the index or the chain alone", async () => {
  const a = setup();
  const viaIndex = await M.history(a.r, { address: SPEC.history.priceFeed, abi: [] }, BigInt(HEAD));
  const b = setup({ host: "localhost" });
  const viaChain = await M.history(b.r, { address: SPEC.history.priceFeed, abi: [] }, BigInt(HEAD));
  assert.equal(viaChain.source, "RPC");
  assert.deepEqual(keys(viaIndex.logs), keys(viaChain.logs));
  assert.deepEqual(b.apiCalls, [], "off imdusd.com the API is never asked");
  assert.ok(b.ranges.length >= 10, "the chain path reads every window from the floor");
});

for (const [name, opts] of [
  ["unverified", { db: indexDb({ unverified: { windows: [[1, 2]] } }) }],
  ["more than 30 minutes behind the head", { db: indexDb({ through: HEAD - 400 }) }],
  ["failing (HTTP 500)", { api: () => new Response("x", { status: 500 }) }],
  ["malformed", { api: (u) => Response.json(u.pathname.endsWith("meta") ? { chainId: 1, through: THROUGH, unverified: false, floor: F, addresses: SPEC.history } : { logs: [{ address: SPEC.history.vault, blockNumber: "nope" }], through: THROUGH, unverified: false, next: null }) }],
  ["another chain", { api: () => Response.json({ chainId: 11155111, through: THROUGH, unverified: false, floor: F, addresses: SPEC.history }) }],
  ["unreachable", { api: () => Promise.reject(Error("network")) }],
]) {
  test(`history: an index that is ${name} falls back to the chain silently`, async () => {
    const { r, ranges } = setup(opts);
    const h = await M.history(r, vault, BigInt(HEAD));
    assert.equal(h.source, "RPC");
    assert.deepEqual(keys(h.logs), keys(LOGS.filter((l) => l.address === SPEC.history.vault)));
    assert.ok(ranges.length >= 10);
  });
}

test("history: a refresh inside the tail reads the chain only, and still says its history came from the index", async () => {
  const { r, ranges, apiCalls } = setup();
  await M.history(r, vault, BigInt(HEAD));
  ranges.length = 0;
  const again = await M.history(r, vault, BigInt(HEAD + 5));
  assert.equal(again.source, "Index");
  assert.ok(ranges.length <= 2);
  assert.ok(apiCalls.filter((c) => c.startsWith("/api/v1/logs")).length <= 2, "no new index read for a tail refresh");
});

test("opt-in off imdusd.com: localStorage imdusd:history-index = same-origin", async () => {
  const s = setup({ host: "localhost" });
  globalThis.localStorage = { getItem: (k) => (k === "imdusd:history-index" ? "same-origin" : null), setItem: () => {} };
  const h = await M.history(s.r, vault, BigInt(HEAD));
  assert.equal(h.source, "Index");
  assert.ok(s.apiCalls.length >= 2);
});

test("peg pool: logs and position transfers from the index, the chain only for the tail, same as the chain alone", async () => {
  const a = setup();
  const viaIndex = await M.pegPoolLogs(a.r, HEAD);
  for (const [, b] of a.ranges) assert.ok(b >= THROUGH - 11, "only tail windows from the chain");
  const b = setup({ host: "localhost" });
  const viaChain = await M.pegPoolLogs(b.r, HEAD);
  const k = (x) => x.map((l) => `${BigInt(l.blockNumber)}:${BigInt(l.logIndex)}`).sort();
  assert.deepEqual(k(viaIndex.pool), k(viaChain.pool));
  assert.deepEqual(k(viaIndex.nft), k(viaChain.nft));
  assert.equal(viaIndex.nft.length, 2, "the mint and the later move");
  assert.ok(viaIndex.pool.some((l) => l.topics[0] === T.initialize));
  assert.ok(a.ranges.length < b.ranges.length / 3, `${a.ranges.length} vs ${b.ranges.length} chain reads`);
});
