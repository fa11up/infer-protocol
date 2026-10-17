// The public history index (imdusd.com/api/v1, worker/history-api.js): the deployment's history contracts' logs, the
// peg pool's and its positions' transfers, from the history floor to `through` (the last block infer-ops' cron indexed,
// always 12 or more below the head it saw). history.ts and peg-logs.ts read [floor, through − 12] here in a few
// requests and only (through − 12, head] from the chain, instead of ~40 eth_getLogs over archive ranges.
//
// It is only ever an accelerator. Off imdusd.com (local dev, previews) it is skipped, unless this browser opted in
// (localStorage "imdusd:history-index" = "same-origin", for a local wrangler dev of the Worker and the browser suite);
// and it is ignored, silently, whenever it fails, reports itself unverified, serves another chain, or its `through` is
// more than indexConfig.maxLag blocks behind the head: the chain path then runs exactly as before.
import type { Runtime } from "./config";

export type IndexLog = {
  address: string;
  blockNumber: string;
  blockHash?: string | null;
  blockTimestamp?: string | null;
  transactionHash: string;
  transactionIndex?: string | null;
  logIndex: string;
  topics: string[];
  data: string;
  removed?: boolean;
};
export type IndexView = {
  through: bigint;
  /** Every address the index holds (lowercase). */
  addresses: Set<string>;
  /** All of its logs from its floor to `through`, in block order. */
  logs: IndexLog[];
};
type Meta = { chainId: number; through: number | null; unverified: boolean; floor: number; addresses: Record<string, string> };

export const indexConfig = {
  /** Hosts whose Worker serves /api/v1 (worker/index.js). */
  hosts: ["imdusd.com"],
  /** Requests are aligned to multiples of this (the API's span cap), so closed ones are cache-identical for everyone. */
  chunk: 50_000n,
  /** The index is used only while `through` is at most this far behind the head (~30 minutes). */
  maxLag: 150n,
  /** Blocks below `through` the chain re-reads: (through − finality, head] always comes from the chain. */
  finality: 12n,
  metaMs: 60_000,
  timeoutMs: 8_000,
};
/** Requests made and whether the last use was the index (for the stats page's source line and tests). */
export const indexStats = { requests: 0, lastThrough: undefined as bigint | undefined };

export function indexBase(): string | undefined {
  try {
    if (typeof location === "undefined") return undefined;
    if (indexConfig.hosts.includes(location.hostname)) return location.origin;
    if (typeof localStorage !== "undefined" && localStorage.getItem("imdusd:history-index") === "same-origin") return location.origin;
  } catch {
    /* no storage: not opted in */
  }
  return undefined;
}

async function getJson(url: string): Promise<any> {
  indexStats.requests++;
  const r = await fetch(url, { signal: AbortSignal.timeout(indexConfig.timeoutMs) });
  if (!r.ok) throw Error(`history index answered ${r.status}`);
  return r.json();
}

const metas = new WeakMap<Runtime, { at: number; p: Promise<Meta> }>();
function meta(r: Runtime, base: string): Promise<Meta> {
  const old = metas.get(r);
  if (old && Date.now() - old.at < indexConfig.metaMs) return old.p;
  const p = getJson(new URL("/api/v1/meta", base).href).then((m) => {
    if (typeof m?.chainId !== "number" || typeof m.unverified !== "boolean" || typeof m.floor !== "number" || !m.addresses || typeof m.addresses !== "object")
      throw Error("malformed index meta");
    if (m.through !== null && !Number.isSafeInteger(m.through)) throw Error("malformed index meta");
    return m as Meta;
  });
  const entry = { at: Date.now(), p };
  metas.set(r, entry);
  p.catch(() => metas.get(r) === entry && metas.delete(r));
  return p;
}

const HEX32 = /^0x[0-9a-f]{64}$/i;
function check(l: any, from: bigint, to: bigint, allowed: Set<string>): IndexLog {
  const ok =
    l &&
    typeof l.address === "string" &&
    allowed.has(l.address.toLowerCase()) &&
    typeof l.blockNumber === "string" &&
    /^0x[0-9a-f]+$/i.test(l.blockNumber) &&
    typeof l.logIndex === "string" &&
    /^0x[0-9a-f]+$/i.test(l.logIndex) &&
    HEX32.test(l.transactionHash) &&
    typeof l.data === "string" &&
    /^0x([0-9a-f]{2})*$/i.test(l.data) &&
    Array.isArray(l.topics) &&
    l.topics.length <= 4 &&
    l.topics.every((t: unknown) => typeof t === "string" && HEX32.test(t)) &&
    l.removed !== true;
  if (!ok) throw Error("malformed index log");
  const b = BigInt(l.blockNumber);
  if (b < from || b > to) throw Error("index log outside the requested range");
  return { ...l, address: l.address.toLowerCase() };
}

/** One aligned chunk, every page of it (the API caps rows per answer and links the next page). */
async function chunk(base: string, addresses: string[], from: bigint, to: bigint, allowed: Set<string>): Promise<IndexLog[]> {
  const out: IndexLog[] = [];
  let path: string | null = `/api/v1/logs?address=${addresses.join(",")}&fromBlock=${from}&toBlock=${to}`;
  for (let page = 0; path; page++) {
    if (page > 200) throw Error("history index pagination did not end");
    const body: any = await getJson(new URL(path, base).href);
    if (!Array.isArray(body?.logs) || typeof body.through !== "number" || body.unverified !== false) throw Error("history index answer unusable");
    if (BigInt(body.through) < to) throw Error("history index is behind the range asked for");
    out.push(...body.logs.map((l: unknown) => check(l, from, to, allowed)));
    if (body.next !== null && (typeof body.next !== "string" || !body.next.startsWith("/api/v1/logs?"))) throw Error("malformed next");
    path = body.next;
  }
  return out;
}

const closedChunks = new WeakMap<Runtime, Map<string, Promise<IndexLog[]>>>();
const views = new WeakMap<Runtime, { through: bigint; p: Promise<IndexView> }>();

async function readAll(r: Runtime, base: string, m: Meta, through: bigint): Promise<IndexView> {
  const addresses = [...new Set(Object.values(m.addresses).map((a) => a.toLowerCase()))].sort();
  const allowed = new Set(addresses);
  const size = indexConfig.chunk;
  let memo = closedChunks.get(r);
  if (!memo) closedChunks.set(r, (memo = new Map()));
  const parts: Promise<IndexLog[]>[] = [];
  for (let k = BigInt(m.floor) / size; k * size <= through; k++) {
    const a = k * size;
    const end = a + size - 1n;
    if (end < through) {
      // Closed: the same request for every visitor, kept for this page's life (and a day at the edge).
      const id = `${addresses.join(",")}:${a}`;
      let p = memo.get(id);
      if (!p) {
        p = chunk(base, addresses, a, end, allowed);
        memo.set(id, p);
        const mine = p;
        p.catch(() => memo!.get(id) === mine && memo!.delete(id));
      }
      parts.push(p);
    } else parts.push(chunk(base, addresses, a, through, allowed));
  }
  const logs = (await Promise.all(parts)).flat();
  logs.sort((x, y) => {
    const d = BigInt(x.blockNumber) - BigInt(y.blockNumber);
    return d !== 0n ? (d < 0n ? -1 : 1) : Number(BigInt(x.logIndex) - BigInt(y.logIndex));
  });
  return { through, addresses: allowed, logs };
}

/**
 * The index's logs from its floor to `through`, or undefined when it should not be used here and now (see the top
 * of this file). Never throws: every failure is the chain path.
 */
export async function indexView(r: Runtime, head: bigint): Promise<IndexView | undefined> {
  const base = indexBase();
  if (!base) return undefined;
  try {
    const m = await meta(r, base);
    if (m.chainId !== r.config.chainId || m.unverified || m.through === null) return undefined;
    const through = BigInt(m.through);
    if (through < BigInt(m.floor) || head > through + indexConfig.maxLag || through > head + indexConfig.maxLag) return undefined;
    let v = views.get(r);
    if (!v || v.through !== through) {
      const entry = { through, p: readAll(r, base, m, through) };
      views.set(r, entry);
      entry.p.catch(() => views.get(r) === entry && views.delete(r));
      v = entry;
    }
    const view = await v.p;
    indexStats.lastThrough = through;
    return view;
  } catch {
    return undefined;
  }
}

/** The first block the chain must still be read from when the index is used: through − finality + 1. */
export const tailFrom = (v: IndexView) => v.through - indexConfig.finality + 1n;
