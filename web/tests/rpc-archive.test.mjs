// worker/rpc.js's archive lane: calls reaching past ARCHIVE_DEPTH go to the keyed archive secrets (INFURA_RPC_URL,
// NODEREAL_RPC_URL), then RPC_UPSTREAMS, then keyless archive gateways; recent calls never touch the archive keys,
// and no secret URL ever reaches a visitor.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRpc, resetAllowlist, resetBench } from "../worker/rpc.js";

const OURS = "0x1111111111111111111111111111111111111111";
const HEAD = 0x18f8000;
const INFURA = "https://mainnet.infura.io/v3/infurasecretkey0123456789";
const NODEREAL = "https://eth-mainnet.nodereal.io/v1/noderealsecretkey0123456789";
const KEYED = "https://keyed.example/chainstacksecret0123456789";
const TENDERLY = "https://gateway.tenderly.co/public/mainnet";
const POCKET = "https://eth.api.pocket.network";
const SECRETS = ["infurasecretkey0123456789", "noderealsecretkey0123456789", "chainstacksecret0123456789"];
const env = (extra = {}) => ({
  RPC_UPSTREAMS: KEYED,
  INFURA_RPC_URL: INFURA,
  NODEREAL_RPC_URL: NODEREAL,
  ASSETS: { fetch: async () => new Response(JSON.stringify([OURS])) },
  ...extra,
});
const memCache = () => {
  const store = new Map();
  return { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => void store.set(k.url, r), delete: async (k) => store.delete(k.url) };
};
/** `refuse(url, body)` returns a Response / JSON-RPC body to fail with, or undefined to answer. */
function upstream(refuse = () => undefined) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method });
    const r = refuse(url, body);
    if (r instanceof Error) throw r;
    if (r instanceof Response) return r;
    if (r) return new Response(JSON.stringify(r));
    const result = body.method === "eth_blockNumber" ? `0x${HEAD.toString(16)}` : body.method === "eth_getLogs" ? [{ from: url.length }] : "0x01";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  const to = (method) => calls.filter((c) => c.method === method).map((c) => c.url);
  return { calls, fetch, to };
}
const post = async (body, deps, e = env()) => {
  const r = await handleRpc(new Request("https://imdusd.com/rpc", { method: "POST", body: JSON.stringify(body) }), e, deps, { logs: true, pages: "the imdUSD terminal" });
  return { text: await r.clone().text(), body: await r.json() };
};
const hex = (n) => `0x${n.toString(16)}`;
const logs = (from, span = 2000, id = 1) => ({ jsonrpc: "2.0", id, method: "eth_getLogs", params: [{ address: OURS, fromBlock: hex(from), toBlock: hex(from + span - 1) }] });
const callAt = (block, id = 1) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: OURS, data: "0x18160ddd" }, hex(block)] });
const fresh = () => {
  resetAllowlist();
  resetBench();
};

test("old log ranges and old-block reads go to the archive secrets first; recent calls keep today's order", async () => {
  fresh();
  const up = upstream();
  const deps = { fetch: up.fetch, cache: memCache() };
  await post(logs(HEAD - 50_000), deps);
  assert.deepEqual(up.to("eth_getLogs"), [INFURA]);
  await post(callAt(HEAD - 1_000), deps);
  assert.deepEqual(up.to("eth_call"), [INFURA]);
  for (const method of ["eth_getBalance", "eth_getCode"]) {
    await post({ jsonrpc: "2.0", id: 1, method, params: [OURS, hex(HEAD - 500)] }, deps);
    assert.deepEqual(up.to(method), [INFURA], method);
  }
  // Recent: the keyed upstream, never an archive key, and the head reads do not spend them either.
  up.calls.length = 0;
  await post(callAt(HEAD - 10, 2), deps);
  await post({ jsonrpc: "2.0", id: 3, method: "eth_call", params: [{ to: OURS, data: "0x70a08231" }, "latest"] }, deps);
  await post(logs(HEAD - 60, 50), deps);
  await post({ jsonrpc: "2.0", id: 4, method: "eth_getBlockByNumber", params: [hex(HEAD - 50_000), false] }, deps);
  assert.ok(up.calls.length >= 4);
  assert.ok(up.calls.every((c) => c.url === KEYED), JSON.stringify(up.calls));
});

test("an open log range reaching past the archive depth: the final part from the archive lane, cached; the last blocks from the recent lane", async () => {
  fresh();
  const asked = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex(HEAD) }));
    const f = body.params[0];
    asked.push({ url, from: Number(f.fromBlock), to: Number(f.toBlock) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ blockNumber: f.fromBlock }] }));
  };
  const deps = { fetch, cache: memCache() };
  const open = { jsonrpc: "2.0", id: 7, method: "eth_getLogs", params: [{ address: OURS, fromBlock: hex(HEAD - 2000), toBlock: hex(HEAD) }] };
  const cut = HEAD - 96; // HEAD − 100, rounded up to a step of 32
  const r = await post(open, deps);
  assert.equal(r.body.id, 7);
  assert.deepEqual(r.body.result, [{ blockNumber: hex(HEAD - 2000) }, { blockNumber: hex(cut) }], "old part first, then the recent part");
  assert.deepEqual([...asked].sort((a, b) => a.from - b.from), [
    { url: INFURA, from: HEAD - 2000, to: cut - 1 },
    { url: KEYED, from: cut, to: HEAD },
  ]);
  // The same open range again: the final part is cached; only the recent part may go out again.
  asked.length = 0;
  await post({ ...open, id: 8 }, deps);
  assert.ok(asked.every((a) => a.url !== INFURA), "no second archive call");
  // A range that is recent, or already final, is answered whole as before.
  asked.length = 0;
  await post(logs(HEAD - 2000 - 1000, 1000), deps);
  await post({ jsonrpc: "2.0", id: 9, method: "eth_getLogs", params: [{ address: OURS, fromBlock: hex(HEAD - 80), toBlock: hex(HEAD) }] }, deps);
  assert.deepEqual(asked.map((a) => a.to - a.from + 1), [1000, 81]);
});

test("without the archive secrets, old calls go to RPC_UPSTREAMS then the keyless archive gateways", async () => {
  fresh();
  const up = upstream((url, body) => (url !== POCKET && body.method === "eth_getLogs" ? new Response("no", { status: 403 }) : undefined));
  const deps = { fetch: up.fetch, cache: memCache() };
  const e = env({ INFURA_RPC_URL: undefined, NODEREAL_RPC_URL: "" });
  const r = await post(logs(HEAD - 50_000), deps, e);
  assert.ok(Array.isArray(r.body.result));
  assert.deepEqual(up.to("eth_getLogs"), [KEYED, TENDERLY, POCKET]);
  // No RPC_UPSTREAMS at all: the gateways alone (nothing is undefined in the list).
  fresh();
  const up2 = upstream();
  await post(logs(HEAD - 50_000), { fetch: up2.fetch, cache: memCache() }, env({ RPC_UPSTREAMS: undefined, INFURA_RPC_URL: undefined, NODEREAL_RPC_URL: undefined }));
  assert.deepEqual(up2.to("eth_getLogs"), [TENDERLY]);
});

test("a rate limit or a too-wide answer moves to the next upstream; a revert is an answer", async () => {
  fresh();
  let infura = () => new Response("", { status: 429 });
  let nodereal = () => ({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query returned more than 10000 results" } });
  const up = upstream((url) => (url === INFURA ? infura() : url === NODEREAL ? nodereal() : undefined));
  const deps = { fetch: up.fetch, cache: memCache() };
  const r = await post(logs(HEAD - 50_000), deps);
  assert.ok(Array.isArray(r.body.result));
  assert.deepEqual(up.to("eth_getLogs"), [INFURA, NODEREAL, KEYED]);
  // Infura is benched (briefly) for old logs; NodeReal was only asked something too wide for it, so it is first now.
  up.calls.length = 0;
  nodereal = () => undefined;
  await post(logs(HEAD - 40_000), deps);
  assert.deepEqual(up.to("eth_getLogs"), [NODEREAL]);
  // A revert whose reason looks like provider trouble is still the chain's answer.
  up.calls.length = 0;
  infura = () => ({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: header not found", data: "0x08c379a0" } });
  resetBench();
  const rev = await post(callAt(HEAD - 1_000), deps);
  assert.equal(rev.body.error.code, 3);
  assert.deepEqual(up.to("eth_call"), [INFURA]);
});

test("Pocket is skipped for a log span over 5,000 blocks, without being asked or benched", async () => {
  fresh();
  const up = upstream((url, body) => (url === POCKET || body.method === "eth_blockNumber" ? undefined : new Response("", { status: 503 })));
  const deps = { fetch: up.fetch, cache: memCache() };
  const wide = await post(logs(HEAD - 50_000, 6_000), deps);
  assert.equal(wide.body.error.code, -32603);
  assert.ok(!up.to("eth_getLogs").includes(POCKET));
  const narrow = await post(logs(HEAD - 40_000, 5_000), deps);
  assert.ok(Array.isArray(narrow.body.result));
  assert.equal(up.to("eth_getLogs").at(-1), POCKET);
});

test("no secret URL or key reaches a visitor, even when providers quote them", async () => {
  fresh();
  const up = upstream((url, body) =>
    body.method === "eth_blockNumber"
      ? undefined
      : url === INFURA
        ? new Error(`fetch to ${url} failed`)
        : url === NODEREAL
          ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: `archive unavailable for key ${url.split("/").pop()}` } }
          : url === KEYED
            ? new Error(`connect ECONNREFUSED ${url}`)
            : new Response("", { status: 502 }),
  );
  const deps = { fetch: up.fetch, cache: memCache() };
  const logged = [];
  const log = console.log;
  console.log = (...a) => logged.push(a.join(" "));
  try {
    const rs = [await post(logs(HEAD - 50_000), deps), await post(callAt(HEAD - 1_000), deps), await post(callAt(HEAD - 1), deps)];
    // The last provider tried for a recent call is a public one; force a keyed message to be the last one too.
    fresh();
    const only = upstream((url, body) => (body.method === "eth_blockNumber" ? undefined : new Error(`timeout calling ${url}`)));
    rs.push(await post(logs(HEAD - 50_000), { fetch: only.fetch, cache: memCache() }, env({ RPC_UPSTREAMS: KEYED })));
    for (const r of rs) {
      assert.match(r.body.error.message, /upstream unavailable/);
      for (const s of SECRETS) assert.ok(!r.text.includes(s), r.text);
    }
    for (const line of logged) for (const s of SECRETS) assert.ok(!line.includes(s), line);
  } finally {
    console.log = log;
  }
});
