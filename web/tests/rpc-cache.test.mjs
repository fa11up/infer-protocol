// worker/rpc.js's response cache: canonical keys, per-call batch entries, isolate memory, in-flight coalescing, one
// head read per block window, and the provider bench's probe. The security rules have their own tests in infer.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { handleRpc, resetAllowlist, resetBench, canonicalParams, MULTICALL3 } from "../worker/rpc.js";

const OURS = "0x1111111111111111111111111111111111111111";
const ALSO = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const CHECKSUMMED = "0xABcdEFABcdEFabcdEfAbCdefabcdeFabcDEFabCD";
const HEAD = 0x18f8000;
const env = (extra = {}) => ({
  RPC_UPSTREAMS: "https://keyed.example/a, https://keyed.example/b",
  ASSETS: { fetch: async () => new Response(JSON.stringify([OURS, ALSO, MULTICALL3])) },
  ...extra,
});

/** A cache that counts lookups by kind (answers / bench) and honours max-age against Date.now. */
function countingCache() {
  const store = new Map();
  const n = { match: 0, benchMatch: 0, put: 0, benchPut: 0 };
  return {
    n,
    store,
    match: async (k) => {
      const bench = k.url.includes("/__rpc-bench/");
      n[bench ? "benchMatch" : "match"]++;
      const e = store.get(k.url);
      return e && e.until > Date.now() ? new Response(e.text) : undefined;
    },
    put: async (k, r) => {
      n[k.url.includes("/__rpc-bench/") ? "benchPut" : "put"]++;
      const age = Number(/max-age=(\d+)/.exec(r.headers.get("cache-control"))[1]);
      store.set(k.url, { text: await r.text(), until: Date.now() + age * 1000 });
    },
    delete: async (k) => store.delete(k.url),
  };
}

/** Upstream stub: records calls; `answer(url, body)` returns a Response or a JSON-RPC body; `delay` ms per call. */
function upstream(answer = () => undefined, delay = 0) {
  // The Worker's own head reads (eth_blockNumber, for finality and the archive lane) are kept apart from `calls`.
  const calls = [];
  const heads = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    (body.method === "eth_blockNumber" ? heads : calls).push({ url, method: body.method, params: body.params });
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const a = answer(url, body);
    if (a instanceof Response) return a;
    return new Response(
      JSON.stringify(a ?? { jsonrpc: "2.0", id: 1, result: body.method === "eth_blockNumber" ? `0x${HEAD.toString(16)}` : body.method === "eth_getLogs" ? [{ blockNumber: body.params[0].fromBlock }] : `0x${calls.length.toString(16).padStart(64, "0")}` }),
    );
  };
  return { calls, heads, fetch };
}

const post = (body, deps, { ip = "198.51.100.1", e = env(), host = "imdusd.com" } = {}) =>
  handleRpc(new Request(`https://${host}/rpc`, { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": ip } }), e, deps, { logs: true, pages: "the imdUSD terminal" }).then(
    async (r) => ({ source: r.headers.get("x-rpc"), body: await r.json() }),
  );
const ethCall = (to, data, tag = "0x18f7fff", id = 1, extra = {}) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to, data, ...extra }, tag] });
const fresh = () => {
  resetAllowlist();
  resetBench();
};

test("canonical params: equivalent spellings share a key, different questions never do", () => {
  const k = (call) => JSON.stringify([call.method, canonicalParams({ jsonrpc: "2.0", ...call })]);
  const same = (a, b, why) => assert.equal(k(a), k(b), why);
  const differ = (a, b, why) => assert.notEqual(k(a), k(b), why);
  const call = (tx, tag) => ({ method: "eth_call", params: tag === undefined ? [tx] : [tx, tag] });
  same(call({ to: CHECKSUMMED, data: "0xABCD" }, "latest"), call({ to: ALSO, data: "0xabcd" }, "latest"), "hex case");
  same(call({ to: ALSO, data: "0xabcd" }), call({ to: ALSO, data: "0xabcd" }, "latest"), "missing tag is latest");
  same(call({ to: ALSO, data: "0xabcd" }, "0x0018F7FFF"), call({ to: ALSO, data: "0xabcd" }, "0x18f7fff"), "block number zeros and case");
  same(call({ to: ALSO, input: "0xabcd" }, "latest"), call({ to: ALSO, data: "0xabcd" }, "latest"), "input is data");
  same(call({ data: "0xabcd", to: ALSO }, "latest"), call({ to: ALSO, data: "0xabcd" }, "latest"), "key order");
  same(call({ to: ALSO, data: "0xabcd", value: "0x00" }, "latest"), call({ to: ALSO, data: "0xabcd", value: "0x0" }, "latest"), "quantity zeros");
  differ(call({ to: ALSO, data: "0x00abcd" }, "latest"), call({ to: ALSO, data: "0xabcd" }, "latest"), "calldata keeps its zero bytes");
  differ(call({ to: ALSO, data: "0xabcd" }, "0x18f7fff"), call({ to: ALSO, data: "0xabcd" }, "0x18f7ffe"), "another block");
  differ(call({ to: ALSO, data: "0xabcd" }, "latest"), call({ to: ALSO, data: "0xabcd" }, "0x18f7fff"), "latest is not resolved into a number");
  differ(call({ to: ALSO, data: "0xabcd", from: OURS }, "latest"), call({ to: ALSO, data: "0xabcd" }, "latest"), "a sender");
  differ(call({ to: ALSO, input: "0xabcd", data: "0x1234" }, "latest"), call({ to: ALSO, data: "0x1234" }, "latest"), "input and data both set and different");

  const logs = (f) => ({ method: "eth_getLogs", params: [{ fromBlock: "0x10", toBlock: "0x20", ...f }] });
  const T = "0x" + "a".repeat(64);
  const U = "0x" + "b".repeat(64);
  same(logs({ address: CHECKSUMMED }), logs({ address: [ALSO] }), "one address is a list of one");
  same(logs({ address: [OURS, ALSO] }), logs({ address: [ALSO, OURS, ALSO] }), "the address list is a set");
  same(logs({ address: OURS, topics: [] }), logs({ address: OURS }), "no topics");
  same(logs({ address: OURS, topics: [T, null, null] }), logs({ address: OURS, topics: [T] }), "trailing wildcards");
  same(logs({ address: OURS, topics: [[U, T]] }), logs({ address: OURS, topics: [[T, U]] }), "an OR position is a set");
  same(logs({ address: OURS, fromBlock: "0x0010" }), logs({ address: OURS }), "block number zeros");
  differ(logs({ address: OURS, topics: [T, U] }), logs({ address: OURS, topics: [U, T] }), "topic positions");
  differ(logs({ address: OURS, topics: [null, T] }), logs({ address: OURS, topics: [T] }), "a leading wildcard");
  differ(logs({ address: OURS }), logs({ address: ALSO }), "another contract");
  differ(logs({ address: OURS, toBlock: "0x21" }), logs({ address: OURS }), "another range");
});

test("visitors share one answer whatever their id, spelling or address", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream();
  const deps = { fetch: up.fetch, cache };
  const a = await post(ethCall(ALSO, "0x18160ddd", "0x18f7fff", 1), deps, { ip: "198.51.100.1" });
  const b = await post(ethCall(CHECKSUMMED, "0x18160DDD", "0x018F7FFF", 42), deps, { ip: "203.0.113.9" });
  assert.equal(a.source, "upstream");
  assert.equal(b.source, "cache");
  assert.equal(b.body.id, 42);
  assert.equal(b.body.result, a.body.result);
  assert.equal(up.calls.length, 1, "one upstream call");
  // What is forwarded is the caller's own spelling: only the key is canonical.
  assert.equal(up.calls[0].params[0].to, ALSO);
  // A new isolate at the same location still shares it, through Cloudflare's cache.
  resetBench();
  const c = await post(ethCall(ALSO, "0x18160ddd", "0x18f7fff", 7), deps);
  assert.equal(c.source, "cache");
  assert.equal(up.calls.length, 1);
});

test("a batch is cached call by call and assembled in order: one new call costs one upstream call", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream(undefined, 20);
  const deps = { fetch: up.fetch, cache };
  const A = (id) => ethCall(ALSO, "0x0000000a", "0x18f7fff", id);
  const B = (id) => ethCall(ALSO, "0x0000000b", "0x18f7fff", id);
  const C = (id) => ethCall(ALSO, "0x0000000c", "0x18f7fff", id);
  const first = await post([A(1), B(2)], deps);
  assert.equal(up.calls.length, 2);
  const second = await post([A(10), C(11), B(12)], deps);
  assert.equal(up.calls.length, 3, "only C went upstream");
  assert.deepEqual(up.calls.map((c) => c.params[0].data).sort(), ["0x0000000a", "0x0000000b", "0x0000000c"]);
  assert.deepEqual(second.body.map((r) => r.id), [10, 11, 12]);
  assert.equal(second.body[0].result, first.body[0].result);
  assert.equal(second.body[2].result, first.body[1].result);
  assert.equal(second.source, "cache,upstream,cache");
  // The same call twice in one batch goes upstream once; each copy keeps its own id.
  const third = await post([C(20), ethCall(ALSO, "0x0000000d", "0x18f7fff", 21), ethCall(ALSO, "0x0000000D", "0x18f7fff", 22)], deps);
  assert.equal(up.calls.length, 4);
  assert.deepEqual(third.body.map((r) => r.id), [20, 21, 22]);
  assert.equal(third.body[1].result, third.body[2].result);
  assert.equal(third.source, "cache,upstream,coalesced");
});

test("identical calls in flight share one upstream call and are not charged to the visitor's upstream limit", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream(undefined, 30);
  const deps = { fetch: up.fetch, cache };
  const charged = [];
  const e = env({ RPC_UPSTREAM: { limit: async ({ key }) => (charged.push(key), { success: true }) } });
  const rs = await Promise.all(["198.51.100.1", "198.51.100.2", "198.51.100.3"].map((ip, i) => post(ethCall(ALSO, "0x18160ddd", "latest", i), deps, { ip, e })));
  assert.equal(up.calls.length, 1);
  assert.deepEqual(rs.map((r) => r.source).sort(), ["coalesced", "coalesced", "upstream"]);
  assert.deepEqual(rs.map((r) => r.body.id), [0, 1, 2]);
  assert.equal(new Set(rs.map((r) => r.body.result)).size, 1);
  assert.equal(charged.length, 1, "only the call that went upstream counts");
  // A simulation names its sender: never shared, never coalesced.
  up.calls.length = 0;
  await Promise.all([1, 2].map((id) => post(ethCall(ALSO, "0x18160ddd", "latest", id, { from: OURS }), deps)));
  assert.equal(up.calls.length, 2);
});

test("a follower of a rate-limited call asks for itself; the limited visitor is told so", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream(undefined, 20);
  const deps = { fetch: up.fetch, cache };
  const e = env({ RPC_UPSTREAM: { limit: async ({ key }) => ({ success: key !== "198.51.100.66" }) } });
  const [limited, ok] = await Promise.all([post(ethCall(ALSO, "0x18160ddd", "latest", 1), deps, { ip: "198.51.100.66", e }), post(ethCall(ALSO, "0x18160ddd", "latest", 2), deps, { ip: "198.51.100.2", e })]);
  assert.equal(limited.body.error.code, -32005);
  assert.equal(ok.body.id, 2);
  assert.ok(ok.body.result);
  assert.equal(up.calls.length, 1);
});

test("isolate memory answers repeats without a cache lookup, and never past the key's window", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream();
  const deps = { fetch: up.fetch, cache };
  const realNow = Date.now;
  let now = Math.floor(realNow() / 12_000) * 12_000; // the start of a block window
  Date.now = () => now;
  try {
    await post(ethCall(ALSO, "0x18160ddd", "latest", 1), deps);
    const looked = cache.n.match;
    now += 5_000;
    assert.equal((await post(ethCall(ALSO, "0x18160ddd", "latest", 2), deps)).source, "cache");
    assert.equal(cache.n.match, looked, "served from memory");
    now += 7_000; // the next block window
    assert.equal((await post(ethCall(ALSO, "0x18160ddd", "latest", 3), deps)).source, "upstream");
    assert.equal(up.calls.length, 2);
    // A large answer (over 256 KB) is left to Cloudflare's cache.
    const big = upstream(() => ({ jsonrpc: "2.0", id: 1, result: "0x" + "ab".repeat(200_000) }));
    await post(ethCall(ALSO, "0x00000001", "0x18f7fff", 4), { fetch: big.fetch, cache });
    const before = cache.n.match;
    assert.equal((await post(ethCall(ALSO, "0x00000001", "0x18f7fff", 5), { fetch: big.fetch, cache })).source, "cache");
    assert.equal(cache.n.match, before + 1, "looked up in Cloudflare's cache");
    assert.equal(big.calls.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test("a batch of log reads asks for the chain head once", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream(undefined, 10);
  const deps = { fetch: up.fetch, cache };
  const recent = (i) => ({ jsonrpc: "2.0", id: i, method: "eth_getLogs", params: [{ address: OURS, fromBlock: `0x${(HEAD - 50 - i).toString(16)}`, toBlock: `0x${(HEAD - 1).toString(16)}` }] });
  await post(Array.from({ length: 10 }, (_, i) => recent(i)), deps);
  assert.equal(up.heads.length, 1);
  assert.equal(up.calls.filter((c) => c.method === "eth_getLogs").length, 10);
  // And a visitor's own eth_blockNumber in the same block shares that read.
  const r = await post({ jsonrpc: "2.0", id: 5, method: "eth_blockNumber" }, deps);
  assert.equal(r.source, "cache");
  assert.equal(r.body.result, `0x${HEAD.toString(16)}`);
});

test("a provider refusing old log ranges is tried by one call of a batch, and its bench is one shared entry", async () => {
  fresh();
  const cache = countingCache();
  // a is a non-archive node: it refuses log ranges older than ~100 blocks.
  const up = upstream((url, body) => (url.endsWith("/a") && body.method === "eth_getLogs" && BigInt(body.params[0].fromBlock) + 100n < BigInt(HEAD) ? new Response("archive", { status: 403 }) : undefined), 10);
  const deps = { fetch: up.fetch, cache };
  const old = (i) => ({ jsonrpc: "2.0", id: i, method: "eth_getLogs", params: [{ address: OURS, fromBlock: `0x${(0x18f0000 + i * 2000).toString(16)}`, toBlock: `0x${(0x18f0000 + i * 2000 + 1999).toString(16)}` }] });
  const r = await post(Array.from({ length: 10 }, (_, i) => old(i)), deps);
  assert.ok(r.body.every((x) => Array.isArray(x.result) && x.result.length === 1));
  const logsAt = (u) => up.calls.filter((c) => c.method === "eth_getLogs" && c.url === u).length;
  assert.equal(logsAt("https://keyed.example/a"), 1, "a refused once, not ten times");
  assert.equal(logsAt("https://keyed.example/b"), 10);
  assert.equal(cache.n.benchPut, 1, "one bench write");
  assert.ok(cache.n.benchMatch <= 2, `bench lookups: ${cache.n.benchMatch}`);
  // A new isolate learns it from the one shared entry: old ranges go to b first.
  resetBench();
  up.calls.length = 0;
  await post(old(-1), deps);
  assert.equal(logsAt("https://keyed.example/a"), 0);
  // Once a answers again (its bench ran out and it serves the range), the shared entry no longer benches it.
  resetBench();
  const realNow = Date.now;
  const later = realNow() + 6 * 60_000;
  Date.now = () => later;
  try {
    const ok = upstream(undefined, 0);
    await post(old(-2), { fetch: ok.fetch, cache });
    assert.equal(ok.calls.filter((c) => c.method === "eth_getLogs")[0].url, "https://keyed.example/a");
  } finally {
    Date.now = realNow;
  }
});

test("an empty answer for a final log window is shared for one block, never longer", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream((url, body) => (body.method === "eth_getLogs" ? { jsonrpc: "2.0", id: 1, result: [] } : undefined));
  const deps = { fetch: up.fetch, cache };
  const realNow = Date.now;
  let now = Math.floor(realNow() / 12_000) * 12_000;
  Date.now = () => now;
  try {
    const deep = { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: OURS, fromBlock: "0x18f4000", toBlock: "0x18f47cf" }] };
    await post(deep, deps);
    now += 3_000;
    assert.equal((await post({ ...deep, id: 2 }, deps)).source, "cache", "within the block");
    // No entry anywhere lives longer than a block.
    for (const [, e] of cache.store) assert.ok(e.until - now <= 12_000);
    now += 12_000;
    resetBench(); // and a new isolate, so neither memory nor the head read carry over
    assert.equal((await post({ ...deep, id: 3 }, deps)).source, "upstream", "asked again a block later");
    assert.equal(up.calls.filter((c) => c.method === "eth_getLogs").length, 2);
  } finally {
    Date.now = realNow;
  }
});

test("the security rules still apply before any cache, memory or coalescing", async () => {
  fresh();
  const cache = countingCache();
  const up = upstream();
  const deps = { fetch: up.fetch, cache };
  const OTHER = "0x2222222222222222222222222222222222222222";
  const AGG = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
  const bundle = (...t) => encodeFunctionData({ abi: AGG, functionName: "aggregate3", args: [t.map((target) => ({ target, allowFailure: true, callData: "0x18160ddd" }))] });
  // Warm the cache with an allowed bundle, then ask for one that differs only by an unlisted inner target.
  await post(ethCall(MULTICALL3, bundle(OURS, ALSO), "0x18f7fff"), deps);
  const refused = await post(ethCall(MULTICALL3, bundle(OURS, OTHER), "0x18f7fff"), deps);
  assert.match(refused.body.error.message, /not one the imdUSD terminal read/);
  assert.equal((await post(ethCall(OTHER, "0x18160ddd"), deps)).body.error.code, -32601);
  assert.match((await post({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: ALSO, data: "0x00" }, "latest", { [ALSO]: { balance: "0x1" } }] }, deps)).body.error.message, /overrides/);
  assert.match((await post({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: OURS, fromBlock: "0x1", toBlock: "0x2711" }] }, deps)).body.error.message, /at most 10000/);
  assert.equal((await post(Array.from({ length: 21 }, (_, i) => ethCall(ALSO, "0x18160ddd", "latest", i)), deps)).body.error.code, -32600);
  assert.equal(up.calls.length, 1, "only the first allowed bundle went upstream");
});
