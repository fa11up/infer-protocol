// imdusd.com/api/v1: the PUBLIC history index, read-only. Raw on-chain logs of imdUSD's public contracts, written by
// infer-ops' cron into their own D1 database (imdusd-public, binding PUBLIC_DB: the only database this Worker is bound
// to) and shaped like eth_getLogs results, so the terminal keeps its decoders and anyone can check a log against the
// chain by its transaction hash.
//
//   GET /api/v1/meta
//   GET /api/v1/logs?address=<addr[,addr]>&fromBlock=<n>&toBlock=<n>[&topic0=<t[,t]>][&topic1=<t[,t]>][&after=<block>:<logIndex>]
//
// Rules: two fixed prepared SELECTs (values only ever as bound parameters; lists go in as one JSON array read with
// json_each), addresses from the public allowlist (public-logs.json, a byte-identical copy of infer-ops'), at most
// MAX_SPAN blocks and MAX_ROWS logs per response (more continue from `next`), CORS *, Cloudflare's cache (a range wholly
// below `through` for a day, anything reaching `through` for a minute), and a per-visitor rate limit on cache misses
// (HISTORY_REQUESTS). The answer carries `through` (the last block indexed) and `unverified` (a reconciliation found a
// mismatch and it is not yet cleared): readers should not trust the index while it is set.
import SPEC from "../public-logs.json" with { type: "json" };

export const MAX_SPAN = 50_000;
export const MAX_ROWS = 10_000;
const MAX_ADDRESSES = 10;
const MAX_TOPICS = 4;
const CLOSED_TTL = 86_400;
const OPEN_TTL = 60;

const NAMED = {
  ...SPEC.history,
  poolManager: SPEC.pegPool.poolManager,
  positionManager: SPEC.pegPool.positionManager,
};
export const ALLOWED = new Set(Object.values(NAMED).map((a) => a.toLowerCase()));

export const META_SQL = "SELECT key, value FROM meta WHERE key IN ('through', 'unverified', 'updated_at', 'verified_at')";
export const LOGS_SQL = `SELECT address, block_number, log_index, tx_hash, tx_index, block_hash, block_time, topic0, topic1, topic2, topic3, data
  FROM logs
  WHERE address IN (SELECT value FROM json_each(?1))
    AND block_number BETWEEN ?2 AND ?3
    AND (block_number > ?4 OR (block_number = ?4 AND log_index > ?5))
    AND (?6 IS NULL OR topic0 IN (SELECT value FROM json_each(?6)))
    AND (?7 IS NULL OR topic1 IN (SELECT value FROM json_each(?7)))
  ORDER BY block_number, log_index
  LIMIT ?8`;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
const json = (body, status = 200, cache = "no-store", extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", ...CORS, ...extra },
  });
const bad = (error) => json({ error }, 400);
const hex = (n) => `0x${n.toString(16)}`;

/** A block number, decimal or 0x hex, within the safe range; anything else is undefined. */
function blockParam(v) {
  if (typeof v !== "string") return undefined;
  if (!/^(0x[0-9a-fA-F]{1,12}|[0-9]{1,15})$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
function list(v, re, max, what) {
  if (v === null) return { value: null };
  const items = [...new Set(v.split(",").map((x) => x.trim().toLowerCase()))];
  if (!items.length || items.length > max) return { error: `${what}: 1 to ${max} values` };
  if (!items.every((x) => re.test(x))) return { error: `${what}: malformed value` };
  return { value: items.sort() };
}

async function readMeta(db) {
  const { results } = await db.prepare(META_SQL).all();
  const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
  let unverified = null;
  if (m.unverified !== undefined) {
    try {
      unverified = JSON.parse(m.unverified);
    } catch {
      unverified = { detail: String(m.unverified) };
    }
  }
  return {
    through: m.through === undefined ? null : Number(m.through),
    unverified,
    updatedAt: m.updated_at ?? null,
    verifiedAt: m.verified_at ?? null,
  };
}

const PARAMS = new Set(["address", "fromBlock", "toBlock", "topic0", "topic1", "after"]);

/** Validate a /api/v1/logs query: the parsed request, or { error }. Exported for tests. */
export function parseLogsQuery(search) {
  for (const k of new Set(search.keys())) {
    if (!PARAMS.has(k)) return { error: `unknown parameter ${k.slice(0, 32)}` };
    if (search.getAll(k).length > 1) return { error: `${k} given twice` };
  }
  const addresses = list(search.get("address"), /^0x[0-9a-f]{40}$/, MAX_ADDRESSES, "address");
  if (addresses.error) return addresses;
  if (!addresses.value) return { error: "address is required" };
  const outside = addresses.value.find((a) => !ALLOWED.has(a));
  if (outside) return { error: `address ${outside} is not in the public index` };
  const fromBlock = blockParam(search.get("fromBlock"));
  const toBlock = blockParam(search.get("toBlock"));
  if (fromBlock === undefined || toBlock === undefined) return { error: "fromBlock and toBlock are required block numbers" };
  if (fromBlock > toBlock) return { error: "fromBlock is after toBlock" };
  if (toBlock - fromBlock + 1 > MAX_SPAN) return { error: `a request spans at most ${MAX_SPAN} blocks` };
  const topic0 = list(search.get("topic0"), /^0x[0-9a-f]{64}$/, MAX_TOPICS, "topic0");
  if (topic0.error) return topic0;
  const topic1 = list(search.get("topic1"), /^0x[0-9a-f]{64}$/, MAX_TOPICS, "topic1");
  if (topic1.error) return topic1;
  let after = [fromBlock - 1, -1];
  const a = search.get("after");
  if (a !== null) {
    const m = /^([0-9]{1,15}):([0-9]{1,6})$/.exec(a);
    if (!m) return { error: "after is <block>:<logIndex>" };
    after = [Number(m[1]), Number(m[2])];
    if (after[0] < fromBlock || after[0] > toBlock) return { error: "after is outside the range" };
  }
  return { addresses: addresses.value, fromBlock, toBlock, topic0: topic0.value, topic1: topic1.value, after };
}

/** One canonical path per question, so equivalent requests share a cache entry. Every value is validated hex or digits,
 * so it is written as is (commas and colons readable). */
function canonical(q) {
  const parts = [`address=${q.addresses.join(",")}`, `fromBlock=${q.fromBlock}`, `toBlock=${q.toBlock}`];
  if (q.topic0) parts.push(`topic0=${q.topic0.join(",")}`);
  if (q.topic1) parts.push(`topic1=${q.topic1.join(",")}`);
  if (q.after[0] >= q.fromBlock) parts.push(`after=${q.after[0]}:${q.after[1]}`);
  return `/api/v1/logs?${parts.join("&")}`;
}

const asLog = (r) => ({
  address: r.address,
  blockNumber: hex(r.block_number),
  blockHash: r.block_hash,
  blockTimestamp: r.block_time === null ? null : hex(r.block_time),
  transactionHash: r.tx_hash,
  transactionIndex: r.tx_index === null ? null : hex(r.tx_index),
  logIndex: hex(r.log_index),
  topics: [r.topic0, r.topic1, r.topic2, r.topic3].filter((t) => t !== null),
  data: r.data,
  removed: false,
});

async function under(binding, key) {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

/** GET /api/v1/*. `deps.cache` lets tests pass a cache (null = none). */
export async function handleHistoryApi(request, env, deps = {}) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "GET only" }, 405, "no-store", { allow: "GET, HEAD, OPTIONS" });
  const db = env.PUBLIC_DB;
  if (!db) return json({ error: "the history index is not configured here" }, 503);
  const cache = deps.cache === undefined ? (typeof caches !== "undefined" ? caches.default : null) : deps.cache;
  const route = url.pathname.replace(/\/+$/, "");
  if (route !== "/api/v1/meta" && route !== "/api/v1/logs") return json({ error: "not found", routes: ["/api/v1/meta", "/api/v1/logs"] }, 404);

  let q, key;
  if (route === "/api/v1/logs") {
    q = parseLogsQuery(url.searchParams);
    if (q.error) return bad(q.error);
    key = new Request(new URL(canonical(q), url.origin).toString());
  } else {
    if ([...url.searchParams.keys()].length) return bad("meta takes no parameters");
    key = new Request(new URL("/api/v1/meta", url.origin).toString());
  }
  const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
  if (hit) {
    const out = new Response(hit.body, hit);
    out.headers.set("x-history-cache", "hit");
    return out;
  }
  const who = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await under(env.HISTORY_REQUESTS, who))) return json({ error: "rate limited: retry in a minute" }, 429, "no-store", { "retry-after": "60" });

  let res;
  try {
    const meta = await readMeta(db);
    const base = {
      chainId: SPEC.chainId,
      launchId: SPEC.launchId,
      through: meta.through,
      unverified: meta.unverified !== null,
    };
    if (route === "/api/v1/meta") {
      res = json(
        {
          ...base,
          unverifiedWindows: meta.unverified?.windows ?? [],
          floor: SPEC.floor,
          finality: SPEC.finality,
          updatedAt: meta.updatedAt,
          verifiedAt: meta.verifiedAt,
          addresses: NAMED,
          pegPool: { poolId: SPEC.pegPool.poolId, fromBlock: SPEC.pegPool.fromBlock, topics: SPEC.pegPool.topics, transfer: SPEC.pegPool.transfer },
          limits: { maxSpan: MAX_SPAN, maxRows: MAX_ROWS, maxAddresses: MAX_ADDRESSES },
        },
        200,
        `public, max-age=${OPEN_TTL}`,
      );
    } else {
      const through = meta.through ?? SPEC.floor - 1;
      const to = Math.min(q.toBlock, through);
      let rows = [];
      if (q.fromBlock <= to) {
        const got = await db
          .prepare(LOGS_SQL)
          .bind(
            JSON.stringify(q.addresses),
            q.fromBlock,
            to,
            q.after[0],
            q.after[1],
            q.topic0 ? JSON.stringify(q.topic0) : null,
            q.topic1 ? JSON.stringify(q.topic1) : null,
            MAX_ROWS + 1,
          )
          .all();
        rows = got.results;
      }
      const more = rows.length > MAX_ROWS;
      if (more) rows = rows.slice(0, MAX_ROWS);
      const last = rows.at(-1);
      const next = more ? canonical({ ...q, after: [last.block_number, last.log_index] }) : null;
      // A range wholly below `through` cannot change (blocks are written 12 below the head) unless a reconciliation
      // repairs it, which marks the index unverified first: closed and verified is kept for a day, the rest a minute.
      const closed = q.toBlock < through && !base.unverified;
      res = json(
        { ...base, fromBlock: q.fromBlock, toBlock: to, complete: !more, next, logs: rows.map(asLog) },
        200,
        `public, max-age=${closed ? CLOSED_TTL : OPEN_TTL}`,
      );
    }
  } catch (e) {
    console.log(`history api: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "the history index could not be read" }, 503);
  }
  if (cache) {
    const stored = res.clone();
    stored.headers.set("x-history-cache", "stored");
    await cache.put(key, stored).catch(() => undefined);
  }
  res.headers.set("x-history-cache", "miss");
  return res;
}
