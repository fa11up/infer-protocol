// infer.imdusd.com/rpc and imdusd.com/rpc: each site's own Ethereum RPC (the INFER pages; the imdUSD terminal). The browser calls this instead of a public RPC; the
// Worker answers from Cloudflare's cache or forwards to a keyed provider, so:
//
// * reads every visitor shares (prices, pool state, supply, staking totals) cost one upstream call per block
//   however many people have the page open: each answer is cached for one 12-second block;
// * the provider keys stay Worker secrets (RPC_UPSTREAMS), never in the page;
// * it is not a free RPC for anyone else: only the methods the pages use, and every eth_call and gas estimate
//   must target a contract the pages read (rpc-allow.json, written by the build from the launch config and the
//   page source), including each call inside a Multicall3 bundle.
// * the terminal also reads its loan book and history from event logs, so imdusd.com's Worker passes
//   `{ logs: true }`: eth_getLogs, only for allowlisted contracts and a numbered range of at most MAX_LOG_SPAN.
//
// Per visitor (Cloudflare's rate limiting bindings, keyed by the connecting IP; see wrangler.infer.jsonc):
// RPC_REQUESTS caps requests to /rpc, and RPC_UPSTREAM caps the calls that miss the cache and reach a provider,
// so a flood of distinct calls cannot drain the keyed providers' quotas. Cache hits never count against
// RPC_UPSTREAM, so any number of visitors behind one address can share the cached reads. A visitor over a limit
// is told so (HTTP 429, or JSON-RPC -32005 for the one call) and nothing goes upstream. Without the bindings
// (tests, local dev) nothing is limited.
//
// Upstreams are tried in order: RPC_UPSTREAMS (comma- or newline-separated full URLs, e.g. Chainstack then
// Blockscout PRO), then the public RPCs below. A revert is an answer and is returned as is; only a provider
// failure (network, HTTP error, rate limit) moves on to the next upstream.
import { decodeFunctionData, parseAbi } from "viem";

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const PUBLIC = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  "https://rpc.mevblocker.io",
  "https://eth-mainnet.public.blastapi.io",
];
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);
const BLOCK_MS = 12_000;
// Logs in a window this many blocks below the head can no longer be reorganised: they are shared for a month, so a
// terminal's history (fixed, aligned windows) is read from a provider once per Cloudflare location, not per visitor.
const FINAL_DEPTH = 64n;
const FINAL_MS = 30 * 86_400_000;
// A provider that just refused a method (no archive, out of credits, range limits) is tried last for that method
// for a while, instead of first on every call; it is still tried if nothing else answers.
const BENCH_MS = 5 * 60_000;
const ARCHIVE_DEPTH = 100n;
// The terminal reads logs in 2,000-block chunks (src/config.ts historyConfig.chunkSize); public RPCs refuse
// spans above 50,000. One request may not ask a provider for more than this.
const MAX_LOG_SPAN = 10_000n;
const MAX_BODY = 64 * 1024;
const MAX_BATCH = 20;
const MAX_INNER = 64;
const AGGREGATE3 = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

// The build's rpc-allow.json as a Set of lowercase addresses, read once per isolate; false when the build has
// none (the whitepaper runs the INFER Worker), which turns /rpc into a 404.
let allow = null;
async function allowlist(env, origin) {
  if (allow !== null) return allow;
  const r = await env.ASSETS.fetch(new Request(`${origin}/rpc-allow.json`));
  allow = r.ok ? new Set((await r.json()).map((a) => a.toLowerCase())) : false;
  return allow;
}
/** Tests reset the cached allowlist between cases. */
export const resetAllowlist = () => (allow = null);

const fail = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const block = (tag) => (typeof tag === "string" && /^0x[0-9a-f]{1,16}$/i.test(tag) ? BigInt(tag) : null);

/** Why an eth_getLogs is refused, or null: allowlisted addresses only, over a numbered range of at most MAX_LOG_SPAN. */
function logRefusal(filter, allowed, pages) {
  if (!filter || typeof filter !== "object") return "a log filter is required";
  if (filter.blockHash !== undefined) return "log filters by block hash are not served here";
  const addresses = [filter.address ?? []].flat();
  if (!addresses.length) return "a log filter must name its contracts";
  for (const a of addresses)
    if (typeof a !== "string" || !allowed.has(a.toLowerCase())) return `contract ${a} is not one ${pages} read`;
  const from = block(filter.fromBlock);
  const to = block(filter.toBlock);
  if (from === null || to === null) return "a log filter must give numbered fromBlock and toBlock";
  if (to < from || to - from >= MAX_LOG_SPAN) return `at most ${MAX_LOG_SPAN} blocks per log request`;
  return null;
}

/** Why a call is refused, or null when it may go upstream. */
function refusal(call, allowed, opts) {
  const pages = opts.pages ?? "the INFER pages";
  if (!call || call.jsonrpc !== "2.0" || typeof call.method !== "string") return "not a JSON-RPC request";
  if (call.method === "eth_getLogs" && opts.logs) return logRefusal(call.params?.[0], allowed, pages);
  if (!ALLOWED.has(call.method)) return `method ${call.method} is not served here`;
  if (call.method !== "eth_call" && call.method !== "eth_estimateGas") return null;
  const [tx, , overrides] = call.params ?? [];
  if (overrides !== undefined) return "state overrides are not served here";
  const to = typeof tx?.to === "string" ? tx.to.toLowerCase() : null;
  if (!to) return "a call must name its target contract";
  if (to === MULTICALL3) {
    if (call.method !== "eth_call") return "gas estimates through Multicall3 are not served here";
    let inner;
    try {
      inner = decodeFunctionData({ abi: AGGREGATE3, data: tx.data ?? tx.input }).args[0];
    } catch {
      return "only Multicall3 aggregate3 is served here";
    }
    if (inner.length > MAX_INNER) return `at most ${MAX_INNER} calls per bundle`;
    for (const c of inner) if (!allowed.has(c.target.toLowerCase())) return `contract ${c.target} is not one ${pages} read`;
    return null;
  }
  return allowed.has(to) ? null : `contract ${tx.to} is not one ${pages} read`;
}

/**
 * How long an answer may be shared, in ms, or 0 for never: reads that do not depend on who asks, at the
 * latest block (one block) or at a fixed block (an hour; history does not change).
 */
function shareable(call, head) {
  const p = call.params ?? [];
  const at = (tag) => (tag === undefined || tag === "latest" ? BLOCK_MS : /^0x[0-9a-f]+$/i.test(tag) ? 3_600_000 : 0);
  switch (call.method) {
    case "eth_chainId":
      return 86_400_000;
    case "eth_blockNumber":
      return BLOCK_MS;
    case "eth_call": {
      const from = p[0]?.from?.toLowerCase();
      // A simulation names its sender; its answer is that sender's, so it is never shared.
      return from && from !== "0x0000000000000000000000000000000000000000" ? 0 : at(p[1]);
    }
    case "eth_getBalance":
    case "eth_getCode":
      return at(p[1]);
    case "eth_getBlockByNumber":
      return p[1] === false ? at(p[0]) : 0;
    case "eth_getLogs": {
      // A numbered range near the head can still be reorganised, so logs are shared for one block only; a range
      // wholly below FINAL_DEPTH of the head is final.
      const to = p[0]?.toBlock;
      return head !== undefined && /^0x[0-9a-f]+$/i.test(to ?? "") && BigInt(to) + FINAL_DEPTH <= head ? FINAL_MS : BLOCK_MS;
    }
    default:
      return 0;
  }
}

async function cacheKey(call, ttl, origin) {
  const bytes = new TextEncoder().encode(JSON.stringify([call.method, call.params ?? []]));
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // One key per block window, so an answer is never served past its window even if a cache keeps it longer.
  return new Request(`${origin}/__rpc/${hash}/${Math.floor(Date.now() / ttl)}`);
}

const providerTrouble = (e) =>
  e && (e.code === -32005 || e.code === 429 || /rate|limit|capacity|unavailable|timeout|too many|exceeded|unauthor|forbidden/i.test(e.message ?? ""));

// The bench is kept in this isolate's memory and in Cloudflare's cache, so every isolate at a location shares what one
// learned instead of each walking the refusing providers again. An isolate reads the shared entry at most every
// BENCH_RECHECK_MS per provider and method. Keys are hashes: the upstream URLs carry API keys.
const BENCH_RECHECK_MS = 30_000;
const benched = new Map(); // "method url" -> { until, checked }
/** Tests reset the providers' standing between cases. */
export const resetBench = () => benched.clear();

async function benchKey(method, url, origin) {
  const bytes = new TextEncoder().encode(`${method} ${url}`);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`${origin}/__rpc-bench/${hash}`);
}

/** Whether each upstream is benched for this method: memory first, the shared cache when memory is old. */
async function benchedNow(method, upstreams, cache, origin) {
  const now = Date.now();
  return Promise.all(
    upstreams.map(async (url) => {
      const k = `${method} ${url}`;
      const m = benched.get(k);
      if (m && (m.until > now || now - m.checked < BENCH_RECHECK_MS)) return m.until > now;
      let until = m?.until ?? 0;
      if (cache && origin)
        try {
          const hit = await cache.match(await benchKey(method, url, origin));
          if (hit) until = Math.max(until, Number(await hit.text()) || 0);
        } catch {
          /* the shared bench is an optimisation only */
        }
      benched.set(k, { until, checked: now });
      return until > now;
    }),
  );
}

/** One call upstream: the first provider that answers, revert included. `kind` is what a provider is benched for:
 * the method, or "eth_getLogs:old" for a log range reaching back past what non-archive nodes serve. */
async function forward(call, upstreams, fetcher, cache, origin, kind = call.method) {
  let last = "no upstream answered";
  const isOut = await benchedNow(kind, upstreams, cache, origin);
  const out = (url) => isOut[upstreams.indexOf(url)];
  const bench = async (url) => {
    const until = Date.now() + BENCH_MS;
    benched.set(`${kind} ${url}`, { until, checked: Date.now() });
    if (cache && origin)
      await benchKey(kind, url, origin)
        .then((k) => cache.put(k, new Response(String(until), { headers: { "cache-control": `max-age=${BENCH_MS / 1000}` } })))
        .catch(() => undefined);
  };
  const clear = async (url) => {
    const k = `${kind} ${url}`;
    if ((benched.get(k)?.until ?? 0) === 0) return;
    benched.set(k, { until: 0, checked: Date.now() });
    if (cache && origin && cache.delete) await benchKey(kind, url, origin).then((key) => cache.delete(key)).catch(() => undefined);
  };
  for (const url of [...upstreams.filter((u) => !out(u)), ...upstreams.filter(out)]) {
    try {
      const r = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params ?? [] }),
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) {
        last = `HTTP ${r.status}`;
        await bench(url);
        continue;
      }
      const d = await r.json();
      if (d.error && providerTrouble(d.error)) {
        last = d.error.message;
        await bench(url);
        continue;
      }
      if (!("result" in d) && !d.error) {
        last = "empty answer";
        await bench(url);
        continue;
      }
      await clear(url);
      return { result: d.result, error: d.error };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      await bench(url);
    }
  }
  return { error: { code: -32603, message: `upstream unavailable: ${last}` } };
}

/** The chain head for deciding what is final: from the cache within a block, else from a provider; undefined if
 * nobody answers (then nothing is treated as final). Not counted against the visitor's upstream limit. */
async function latest(upstreams, fetcher, cache, origin) {
  const call = { jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] };
  const key = cache ? await cacheKey(call, BLOCK_MS, origin) : null;
  try {
    const hit = key && (await cache.match(key));
    if (hit) return BigInt((await hit.json()).result);
  } catch {
    /* fall through to a provider */
  }
  const got = await forward(call, upstreams, fetcher, cache, origin);
  if (got.error || typeof got.result !== "string") return undefined;
  if (key) await cache.put(key, new Response(JSON.stringify({ result: got.result }), { headers: { "cache-control": `max-age=${BLOCK_MS / 1000}` } }));
  return BigInt(got.result);
}

/** Whether `binding` lets `key` through; a missing binding, or one that fails, never blocks. */
async function under(binding, key) {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

async function answer(call, env, allowed, upstreams, fetcher, cache, who, opts, origin) {
  const no = refusal(call, allowed, opts);
  if (no) {
    // Logged so a contract the page reads but the allowlist lacks shows up in the Worker's logs.
    console.log(`rpc refused: ${no}`);
    return { body: fail(call?.id, -32601, no), source: "refused" };
  }
  const head = call?.method === "eth_getLogs" && cache ? await latest(upstreams, fetcher, cache, origin) : undefined;
  const ttl = shareable(call, head);
  // Non-archive providers serve only the last ~100 blocks of logs: an older range is its own kind for the bench, so a
  // provider refusing it is not cleared by the recent ranges it does serve.
  const from = call?.params?.[0]?.fromBlock;
  const kind = head !== undefined && /^0x[0-9a-f]+$/i.test(from ?? "") && BigInt(from) + ARCHIVE_DEPTH < head ? "eth_getLogs:old" : call?.method;
  const key = ttl && cache ? await cacheKey(call, ttl, origin) : null;
  if (key) {
    const hit = await cache.match(key);
    if (hit) return { body: { jsonrpc: "2.0", id: call.id, ...(await hit.json()) }, source: "cache" };
  }
  if (!(await under(env.RPC_UPSTREAM, who)))
    return { body: fail(call.id, -32005, "rate limited: too many uncached calls from this address, retry in a minute"), source: "limited" };
  const got = await forward(call, upstreams, fetcher, cache, origin, kind);
  // An empty log list is never kept past one block: some providers answer [] for ranges they will not serve, and a
  // month of that would hide real logs.
  const keep = Array.isArray(got.result) && got.result.length === 0 ? Math.min(ttl, BLOCK_MS) : ttl;
  const storeKey = key && keep !== ttl ? await cacheKey(call, keep, origin) : key;
  if (storeKey && !got.error && got.result !== null && got.result !== undefined)
    await cache.put(storeKey, new Response(JSON.stringify({ result: got.result }), { headers: { "cache-control": `max-age=${Math.ceil(keep / 1000)}` } }));
  return { body: { jsonrpc: "2.0", id: call.id, ...got }, source: "upstream" };
}

/**
 * POST /rpc. `deps` lets tests pass a fetch and a cache. `opts`: `logs` serves eth_getLogs (imdusd.com's
 * terminal), `pages` names the site in refusals.
 */
export async function handleRpc(request, env, deps = {}, opts = {}) {
  const origin = new URL(request.url).origin;
  const fetcher = deps.fetch ?? fetch;
  const cache = deps.cache === undefined ? (typeof caches !== "undefined" ? caches.default : null) : deps.cache;
  const json = (body, status = 200, source = "") =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", ...(source ? { "x-rpc": source } : {}) },
    });
  const allowed = await allowlist(env, origin);
  if (!allowed) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return json(fail(null, -32600, "POST a JSON-RPC request"), 405);
  const who = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await under(env.RPC_REQUESTS, who)))
    return new Response(JSON.stringify(fail(null, -32005, "rate limited: too many requests from this address, retry in a minute")), {
      status: 429,
      headers: { "content-type": "application/json", "cache-control": "no-store", "retry-after": "60" },
    });
  const text = await request.text();
  if (text.length > MAX_BODY) return json(fail(null, -32600, "request too large"), 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(fail(null, -32700, "not JSON"), 400);
  }
  const upstreams = [
    ...String(env.RPC_UPSTREAMS ?? "")
      .split(/[\s,]+/)
      .filter((u) => u.startsWith("https://")),
    ...PUBLIC,
  ];
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_BATCH) return json(fail(null, -32600, `send 1 to ${MAX_BATCH} calls`), 400);
    const out = await Promise.all(body.map((c) => answer(c, env, allowed, upstreams, fetcher, cache, who, opts, origin)));
    return json(out.map((o) => o.body), 200, out.map((o) => o.source).join(","));
  }
  const o = await answer(body, env, allowed, upstreams, fetcher, cache, who, opts, origin);
  return json(o.body, 200, o.source);
}
