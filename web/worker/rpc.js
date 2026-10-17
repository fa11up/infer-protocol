// infer.imdusd.com/rpc and imdusd.com/rpc: each site's own Ethereum RPC (the INFER pages; the imdUSD terminal). The browser calls this instead of a public RPC; the
// Worker answers from Cloudflare's cache or forwards to a keyed provider, so:
//
// * reads every visitor shares (prices, pool state, supply, staking totals) cost one upstream call per block
//   however many people have the page open: each answer is cached for one 12-second block. The key is the
//   question in one canonical form (no JSON-RPC id, hex lowercased, equivalent filters folded), each call of a batch
//   is its own entry, answers this isolate has seen are served from its memory before Cloudflare's cache, and an
//   identical call already on its way upstream is waited for rather than sent again;
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
// is told so (HTTP 429, or JSON-RPC -32005 for the one call) and nothing goes upstream. A call answered by waiting
// for an identical one in flight is, like a cache hit, not counted either. Without the bindings
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

// ----------------------------------------------------------------------------------------------- cache keys
// One answer, one key, whoever asks: the JSON-RPC id never enters it, and params are put in one canonical form, so
// two pages (or two clients) asking the same question in different spellings share the answer. Hex is
// case-insensitive in JSON-RPC (addresses, calldata, topics, hashes), so it is lowercased; block numbers and other
// quantities lose leading zeros (calldata never does: its zeros are bytes); a missing block tag is "latest"; object
// keys are sorted. For a log filter, one address and a list of one are the same filter, the address list is a set,
// an empty topic list is no topic list, trailing null topics match anything, and each OR position is a set.
const HEX = /^0x[0-9a-f]*$/i;
const lowerHex = (x) =>
  typeof x === "string"
    ? HEX.test(x)
      ? x.toLowerCase()
      : x
    : Array.isArray(x)
      ? x.map(lowerHex)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .filter((k) => x[k] !== undefined)
              .map((k) => [k, lowerHex(x[k])]),
          )
        : x;
const quantity = (x) => (typeof x === "string" && /^0x[0-9a-f]+$/i.test(x) ? `0x${BigInt(x).toString(16)}` : x);
const tagOf = (t) => (t === undefined || t === null ? "latest" : quantity(t));
const QUANTITIES = ["gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "value"];

function canonicalTx(tx) {
  if (!tx || typeof tx !== "object") return tx;
  const t = { ...tx };
  // `input` is the newer name for `data`; nodes read either. Only one spelling (or both the same) is folded.
  if (t.input !== undefined && (t.data === undefined || t.data === t.input)) {
    t.data = t.input;
    delete t.input;
  }
  for (const f of QUANTITIES) if (t[f] !== undefined) t[f] = quantity(t[f]);
  return lowerHex(t);
}

function canonicalFilter(f) {
  if (!f || typeof f !== "object") return f;
  const { address, topics, fromBlock, toBlock, ...rest } = lowerHex(f);
  const out = { ...rest };
  if (address !== undefined) out.address = [...new Set([address].flat())].sort();
  if (Array.isArray(topics)) {
    const t = topics.map((x) => (Array.isArray(x) ? [...new Set(x)].sort() : x));
    while (t.length && (t[t.length - 1] === null || t[t.length - 1] === undefined)) t.pop();
    if (t.length) out.topics = t;
  } else if (topics !== undefined && topics !== null) out.topics = topics;
  if (fromBlock !== undefined) out.fromBlock = tagOf(fromBlock);
  if (toBlock !== undefined) out.toBlock = tagOf(toBlock);
  return lowerHex(out);
}

/** The params of `call` in the one form its cache key is made of (exported for the tests). */
export function canonicalParams(call) {
  const p = Array.isArray(call.params) ? call.params : call.params === undefined ? [] : [call.params];
  switch (call.method) {
    case "eth_call":
    case "eth_estimateGas":
      return [canonicalTx(p[0]), tagOf(p[1]), ...lowerHex(p.slice(2))];
    case "eth_getBalance":
    case "eth_getCode":
      return [lowerHex(p[0]), tagOf(p[1])];
    case "eth_getBlockByNumber":
      return [tagOf(lowerHex(p[0])), p[1]];
    case "eth_getLogs":
      return [canonicalFilter(p[0]), ...lowerHex(p.slice(1))];
    default:
      return lowerHex(p);
  }
}

const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The cache key of `call` for answers kept `ttl` ms: a URL, and when an answer under it stops being served. */
async function cacheKey(call, ttl, origin) {
  const hash = await sha256(JSON.stringify([call.method, canonicalParams(call)]));
  // One key per window, so an answer is never served past its window even if a cache keeps it longer.
  const w = Math.floor(Date.now() / ttl);
  const url = `${origin}/__rpc/${hash}/${w}`;
  return { url, request: new Request(url), until: (w + 1) * ttl };
}

// --------------------------------------------------------------------------------------------- isolate memory
// In front of Cloudflare's cache: answers this isolate has already seen, so a repeat costs no cache lookup (a
// subrequest and a few ms). Least recently used out first, bounded in entries and bytes; a large answer (a busy log
// window) is left to the Cloudflare cache alone. An entry is never served past its key's window.
const MEM_ENTRIES = 4000;
const MEM_BYTES = 8 * 1024 * 1024;
const MEM_ENTRY_BYTES = 256 * 1024;
const mem = new Map(); // url -> { text, until }
let memBytes = 0;

function memGet(url) {
  const e = mem.get(url);
  if (!e) return undefined;
  mem.delete(url);
  if (e.until <= Date.now()) {
    memBytes -= e.text.length;
    return undefined;
  }
  mem.set(url, e);
  return e.text;
}

function memSet(url, text, until) {
  const old = mem.get(url);
  if (old) {
    memBytes -= old.text.length;
    mem.delete(url);
  }
  if (text.length > MEM_ENTRY_BYTES || until <= Date.now()) return;
  mem.set(url, { text, until });
  memBytes += text.length;
  for (const [k, e] of mem) {
    if (mem.size <= MEM_ENTRIES && memBytes <= MEM_BYTES) break;
    mem.delete(k);
    memBytes -= e.text.length;
  }
}

/** The first of `keys` with an answer, from memory, else from the Cloudflare cache (then remembered): its JSON text. */
async function lookup(keys, cache) {
  for (const k of keys) {
    const t = memGet(k.url);
    if (t !== undefined) return t;
  }
  for (const k of keys) {
    try {
      const hit = await cache.match(k.request);
      if (hit) {
        const t = await hit.text();
        memSet(k.url, t, k.until);
        return t;
      }
    } catch {
      /* a cache failure is a miss */
    }
  }
  return undefined;
}

/** Keeps an answer under `key` for `ms`, in memory and in the Cloudflare cache. */
async function store(key, ms, got, cache) {
  const text = JSON.stringify({ result: got.result });
  memSet(key.url, text, Math.min(key.until, Date.now() + ms));
  try {
    await cache.put(key.request, new Response(text, { headers: { "cache-control": `max-age=${Math.ceil(ms / 1000)}` } }));
  } catch {
    /* memory still has it */
  }
}

// Identical calls in flight in this isolate (the same read from two visitors, or twice in one batch) share one
// upstream call: the cache key -> the pending answer.
const inflight = new Map();

const providerTrouble = (e) =>
  e && (e.code === -32005 || e.code === 429 || /rate|limit|capacity|unavailable|timeout|too many|exceeded|unauthor|forbidden/i.test(e.message ?? ""));

// ------------------------------------------------------------------------------------------------- the bench
// A provider that refused a kind of call is benched for it: tried last for BENCH_MS. The bench lives in this isolate's
// memory and, so every isolate at a location shares what one learned, in Cloudflare's cache: ONE entry per kind holding
// every provider's standing (keys are hashes: the upstream URLs carry API keys), read at most every BENCH_RECHECK_MS
// per kind, and only when a call goes upstream. A provider likely to refuse (see `probe` in forward) is tried by one
// call at a time, so a batch of twenty does not send twenty requests to a provider that is about to refuse the first.
const BENCH_RECHECK_MS = 30_000;
const benched = new Map(); // "kind url" -> benched until
const answered = new Map(); // "kind url" -> when it last answered
const probes = new Map(); // "kind url" -> the first attempt in flight
const benchRead = new Map(); // kind -> when the shared entry was last read
const urlHashes = new Map();
let headMemo = null; // { w, p }: the chain head for the current block window

/** Tests start a fresh isolate: no bench, no remembered answers, nothing in flight. */
export function resetBench() {
  benched.clear();
  answered.clear();
  probes.clear();
  benchRead.clear();
  mem.clear();
  memBytes = 0;
  inflight.clear();
  headMemo = null;
}

const urlHash = async (url) => urlHashes.get(url) ?? urlHashes.set(url, await sha256(url)).get(url);
const benchKey = async (kind, origin) => new Request(`${origin}/__rpc-bench/${await sha256(`bench ${kind}`)}`);

async function readBench(kind, upstreams, cache, origin) {
  const now = Date.now();
  if (!cache || !origin || now - (benchRead.get(kind) ?? -Infinity) < BENCH_RECHECK_MS) return;
  benchRead.set(kind, now);
  try {
    const hit = await cache.match(await benchKey(kind, origin));
    if (!hit) return;
    const shared = await hit.json();
    for (const url of upstreams) {
      const until = Number(shared[await urlHash(url)]) || 0;
      const k = `${kind} ${url}`;
      if (until > (benched.get(k) ?? 0)) benched.set(k, until);
    }
  } catch {
    /* the shared bench is an optimisation only */
  }
}

async function writeBench(kind, upstreams, cache, origin) {
  if (!cache || !origin) return;
  const now = Date.now();
  const shared = {};
  let last = 0;
  for (const url of upstreams) {
    const until = benched.get(`${kind} ${url}`) ?? 0;
    if (until > now) {
      shared[await urlHash(url)] = until;
      last = Math.max(last, until);
    }
  }
  try {
    const key = await benchKey(kind, origin);
    if (!last && cache.delete) await cache.delete(key);
    else await cache.put(key, new Response(JSON.stringify(shared), { headers: { "cache-control": `max-age=${Math.max(1, Math.ceil((last - now) / 1000))}` } }));
  } catch {
    /* the shared bench is an optimisation only */
  }
}

/** One call upstream: the first provider that answers, revert included. `kind` is what a provider is benched for:
 * the method, or "eth_getLogs:old" for a log range reaching back past what non-archive nodes serve. */
async function forward(call, upstreams, fetcher, cache, origin, kind = call.method) {
  let last = "no upstream answered";
  await readBench(kind, upstreams, cache, origin);
  const tried = new Set();
  while (tried.size < upstreams.length) {
    // Chosen afresh before every attempt, so a refusal another call just met counts at once.
    const now = Date.now();
    const left = upstreams.filter((u) => !tried.has(u));
    const url = left.find((u) => (benched.get(`${kind} ${u}`) ?? 0) <= now) ?? left[0];
    const k = `${kind} ${url}`;
    // Probed one call at a time: a provider this isolate has seen refuse this kind (its bench may have run out), and
    // for old log ranges (which most providers refuse) any provider it has not seen answer one lately. Other calls
    // still go out together, so a cold isolate's first batch is not slowed.
    const probe = now - (answered.get(k) ?? -Infinity) >= BENCH_MS && (benched.has(k) || kind.endsWith(":old"));
    if (probe && probes.has(k)) {
      await probes.get(k);
      continue;
    }
    tried.add(url);
    let done;
    if (probe) probes.set(k, new Promise((r) => (done = r)));
    try {
      const got = await attempt(call, url, fetcher);
      if (got.trouble) {
        last = got.trouble;
        const wasOut = (benched.get(k) ?? 0) > Date.now();
        benched.set(k, Date.now() + BENCH_MS);
        answered.delete(k);
        if (!wasOut) await writeBench(kind, upstreams, cache, origin);
        continue;
      }
      answered.set(k, Date.now());
      if ((benched.get(k) ?? 0) > 0) {
        benched.delete(k);
        await writeBench(kind, upstreams, cache, origin);
      }
      return got.answer;
    } finally {
      if (done) {
        probes.delete(k);
        done();
      }
    }
  }
  return { error: { code: -32603, message: `upstream unavailable: ${last}` } };
}

/** One provider, one call: `{ answer }`, or `{ trouble }` when the provider (not the chain) failed. */
async function attempt(call, url, fetcher) {
  try {
    const r = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: call.method, params: call.params ?? [] }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return { trouble: `HTTP ${r.status}` };
    const d = await r.json();
    if (d.error && providerTrouble(d.error)) return { trouble: d.error.message };
    if (!("result" in d) && !d.error) return { trouble: "empty answer" };
    return { answer: { result: d.result, error: d.error } };
  } catch (e) {
    return { trouble: e instanceof Error ? e.message : String(e) };
  }
}

/** The chain head for deciding what is final: from memory or the cache within a block, else from a provider;
 * undefined if nobody answers (then nothing is treated as final). Asked once per block window per isolate, however
 * many calls in a batch need it. Not counted against the visitor's upstream limit. */
function latest(upstreams, fetcher, cache, origin) {
  const w = Math.floor(Date.now() / BLOCK_MS);
  if (headMemo?.w === w) return headMemo.p;
  const p = (async () => {
    const call = { jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] };
    const key = await cacheKey(call, BLOCK_MS, origin);
    const hit = await lookup([key], cache);
    if (hit !== undefined)
      try {
        return BigInt(JSON.parse(hit).result);
      } catch {
        /* fall through to a provider */
      }
    const got = await forward(call, upstreams, fetcher, cache, origin);
    if (got.error || typeof got.result !== "string") return undefined;
    await store(key, BLOCK_MS, got, cache);
    return BigInt(got.result);
  })();
  const memo = { w, p };
  headMemo = memo;
  // A failed read is not remembered: the next call asks again.
  const forget = () => headMemo === memo && (headMemo = null);
  p.then((v) => v === undefined && forget(), forget);
  return p;
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
  const limited = () => ({ body: fail(call.id, -32005, "rate limited: too many uncached calls from this address, retry in a minute"), source: "limited" });
  const head = call?.method === "eth_getLogs" && cache ? await latest(upstreams, fetcher, cache, origin) : undefined;
  const ttl = shareable(call, head);
  // Non-archive providers serve only the last ~100 blocks of logs: an older range is its own kind for the bench, so a
  // provider refusing it is not cleared by the recent ranges it does serve.
  const from = call?.params?.[0]?.fromBlock;
  const kind = head !== undefined && /^0x[0-9a-f]+$/i.test(from ?? "") && BigInt(from) + ARCHIVE_DEPTH < head ? "eth_getLogs:old" : call?.method;
  if (!ttl || !cache) {
    if (!(await under(env.RPC_UPSTREAM, who))) return limited();
    const got = await forward(call, upstreams, fetcher, cache, origin, kind);
    return { body: { jsonrpc: "2.0", id: call.id, ...got }, source: "upstream" };
  }
  const key = await cacheKey(call, ttl, origin);
  // An empty log list is never kept past one block (some providers answer [] for ranges they will not serve, and a
  // month of that would hide real logs), so a final window's empty answer lives under its own one-block key.
  const short = ttl > BLOCK_MS && call.method === "eth_getLogs" ? await cacheKey(call, BLOCK_MS, origin) : null;
  const hit = await lookup(short ? [key, short] : [key], cache);
  if (hit !== undefined) return { body: { jsonrpc: "2.0", id: call.id, ...JSON.parse(hit) }, source: "cache" };
  // The same call already on its way upstream in this isolate: wait for that answer instead of asking again. Like a
  // cache hit, it does not count against this visitor's upstream limit.
  const pending = inflight.get(key.url);
  if (pending) {
    const got = await pending;
    if (!got.limited) return { body: { jsonrpc: "2.0", id: call.id, ...got }, source: "coalesced" };
  }
  const mine = (async () => {
    if (!(await under(env.RPC_UPSTREAM, who))) return { limited: true };
    const got = await forward(call, upstreams, fetcher, cache, origin, kind);
    if (!got.error && got.result !== null && got.result !== undefined) {
      const empty = Array.isArray(got.result) && got.result.length === 0;
      await store(empty && short ? short : key, empty ? Math.min(ttl, BLOCK_MS) : ttl, got, cache);
    }
    return got;
  })();
  inflight.set(key.url, mine);
  const got = await mine.finally(() => inflight.get(key.url) === mine && inflight.delete(key.url));
  if (got.limited) return limited();
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
