import {
  decodeEventLog,
  getAddress,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import { ours } from "./names";
import { historyConfig, type Runtime, type Target } from "./config";
import { read, type Snapshot } from "./state";

export type ChainLog = {
  address: Address;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  data: Hex;
  topics: [Hex, ...Hex[]];
};
export type History = {
  logs: ChainLog[];
  from: bigint;
  through: bigint;
  source: "RPC" | "Blockscout";
};
export type Loan = {
  owner: Address;
  collateral: bigint;
  debt: bigint;
  cr: bigint;
};
export type AcceptedPoint = {
  id: string;
  value: bigint;
  time: number;
  block: bigint;
};
export type Result<T> = { data?: T; error?: string };
export type Book = { positions: Loan[]; history: History };
export type Cadence = { points: AcceptedPoint[]; history: History };
const caches = new WeakMap<Runtime, Map<string, History>>();
const starts = new WeakMap<Runtime, Map<string, Promise<bigint>>>();
const key = (log: ChainLog) => `${log.transactionHash}:${log.logIndex}`;
function normalize(log: any, target: Address): ChainLog {
  if (log.removed === true) throw Error("Removed log cannot certify history");
  const address = log.address?.hash ?? log.address;
  if (
    typeof address !== "string" ||
    address.toLowerCase() !== target.toLowerCase()
  )
    throw Error("Log address mismatch");
  const topics = log.topics?.filter((t: unknown) => t !== null);
  const blockNumber = BigInt(log.blockNumber ?? log.block_number);
  const logIndex = Number(log.logIndex ?? log.index);
  const transactionHash = log.transactionHash ?? log.transaction_hash;
  if (
    !Number.isSafeInteger(logIndex) ||
    logIndex < 0 ||
    blockNumber < 0n ||
    !/^0x[\da-f]{64}$/i.test(transactionHash) ||
    !/^0x([\da-f]{2})*$/i.test(log.data) ||
    !Array.isArray(topics) ||
    !topics.length ||
    !topics.every((t) => /^0x[\da-f]{64}$/i.test(t))
  )
    throw Error("Malformed history log");
  return {
    address: getAddress(address),
    blockNumber,
    transactionHash,
    logIndex,
    topics: topics as [Hex, ...Hex[]],
    data: log.data,
  };
}
async function explorer(r: Runtime, path: string) {
  const api = historyConfig.blockscoutApis[r.config.chainId];
  if (!api) throw Error("No history fallback configured for this chain");
  const response = await fetch(new URL(path, api), {
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error(`Blockscout returned ${response.status}`);
  return response.json();
}
// Discover the actual first code block, not a guessed height or handoff extension.
// The binary search works for these non-proxy, non-self-destructing deployments.
async function deploymentBlock(
  r: Runtime,
  t: Target,
  head: bigint,
): Promise<bigint> {
  let map = starts.get(r);
  if (!map) {
    map = new Map();
    starts.set(r, map);
  }
  const old = map.get(t.address);
  if (old) return old;
  const pending = (async () => {
    try {
      let lo = 0n,
        hi = head;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const code = await r.client.getCode({
          address: t.address,
          blockNumber: mid,
        });
        if (code && code !== "0x") hi = mid;
        else lo = mid + 1n;
      }
      const code = await r.client.getCode({
        address: t.address,
        blockNumber: lo,
      });
      if (!code || code === "0x") throw Error("Deployment code unavailable");
      return lo;
    } catch {
      const info = await explorer(r, `addresses/${t.address}`);
      if (!/^0x[\da-f]{64}$/i.test(info.creation_transaction_hash))
        throw Error("Deployment transaction unavailable");
      const tx = await explorer(
        r,
        `transactions/${info.creation_transaction_hash}`,
      );
      const height = BigInt(tx.block_number);
      if (height < 0n || height > head)
        throw Error("Deployment block unavailable");
      return height;
    }
  })();
  map.set(t.address, pending);
  try {
    return await pending;
  } catch (e) {
    map.delete(t.address);
    throw e;
  }
}
export async function explorerLogs(
  r: Runtime,
  t: Target,
  from: bigint,
  to: bigint,
): Promise<ChainLog[]> {
  const logs: ChainLog[] = [];
  let query = "";
  const seen = new Set<string>();
  for (let page = 0; page < historyConfig.maxPages; page++) {
    const body = await explorer(r, `addresses/${t.address}/logs${query}`);
    if (!Array.isArray(body.items) || !("next_page_params" in body))
      throw Error("Incomplete Blockscout response");
    const batch = body.items.map((item: unknown) => normalize(item, t.address));
    logs.push(
      ...batch.filter(
        (l: ChainLog) => l.blockNumber >= from && l.blockNumber <= to,
      ),
    );
    // API pages run newest to oldest. Keep traversing until the range is complete.
    if (body.next_page_params === null) return logs;
    if (!batch.length) throw Error("Empty paginated history response");
    const next = new URLSearchParams(body.next_page_params).toString();
    if (!next || seen.has(next))
      throw Error("History pagination did not advance");
    seen.add(next);
    query = `?${next}`;
  }
  throw Error("History exceeds the browser page limit; coverage is incomplete");
}
export async function rangeLogs(
  r: Runtime,
  t: Target,
  from: bigint,
  to: bigint,
): Promise<{ logs: ChainLog[]; source: History["source"] }> {
  try {
    const logs: ChainLog[] = [];
    let chunks = 0;
    for (let start = from; start <= to; start += historyConfig.chunkSize) {
      if (++chunks > historyConfig.maxChunks)
        throw Error("History range limit");
      const end = start + historyConfig.chunkSize - 1n;
      const batch = await r.client.getLogs({
        address: t.address,
        fromBlock: start,
        toBlock: end < to ? end : to,
      });
      // Some providers silently refuse ranges with []. Never treat that as proof of absence.
      if (!batch.length) throw Error("Empty RPC log range is unverified");
      const normalized = batch.map((log) => normalize(log, t.address));
      if (
        normalized.some(
          (log) =>
            log.blockNumber < start || log.blockNumber > (end < to ? end : to),
        )
      )
        throw Error("RPC returned logs outside the requested range");
      logs.push(...normalized);
    }
    if (!logs.length) throw Error("No verifiable logs");
    return { logs, source: "RPC" };
  } catch {
    const logs = await explorerLogs(r, t, from, to);
    if (!logs.length)
      throw Error(
        "Could not read history: RPC and Blockscout returned no verifiable logs. Retry history.",
      );
    return { logs, source: "Blockscout" };
  }
}
export async function history(
  r: Runtime,
  t: Target,
  head: bigint,
): Promise<History> {
  let map = caches.get(r);
  if (!map) {
    map = new Map();
    caches.set(r, map);
  }
  const old = map.get(t.address);
  const from = old?.from ?? (await deploymentBlock(r, t, head));
  // Retain an anchor log in every refresh, and re-read the reorg overlap.
  const anchor = old?.logs.at(-1)?.blockNumber ?? from;
  const overlap =
    anchor > historyConfig.overlap ? anchor - historyConfig.overlap : from;
  const start =
    old && head >= old.through ? (overlap > from ? overlap : from) : from;
  const next = await rangeLogs(r, t, start, head);
  const combined = [
    ...(old?.logs.filter((l) => l.blockNumber < start) ?? []),
    ...next.logs,
  ];
  const logs = [...new Map(combined.map((l) => [key(l), l])).values()].sort(
    (a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
  );
  const result = { logs, from, through: head, source: next.source };
  map.set(t.address, result);
  return result;
}
function decode(t: Target, log: ChainLog) {
  try {
    return decodeEventLog({ abi: t.abi, data: log.data, topics: log.topics });
  } catch {
    if (
      t.abi.some(
        (item) =>
          item.type === "event" && toEventSelector(item) === log.topics[0],
      )
    )
      throw Error("Could not decode a contract history event. Retry history.");
    return undefined; // Unknown topics are not chart data; malformed known events fail closed.
  }
}
export async function loanBook(r: Runtime, s: Snapshot): Promise<Book> {
  const t = s.targets.ParameterizedVault;
  const h = await history(r, t, s.block);
  const owners = new Set<Address>();
  for (const log of h.logs) {
    const event = decode(t, log);
    if (event?.eventName && ours(event.eventName) === "Lock")
      owners.add(
        getAddress((event.args as unknown as { account: Address }).account),
      );
  }
  // history() already refused an unverified empty read (rangeLogs throws on [] from both sources), so
  // these logs are real; no Lock among them is an empty book (a fresh vault), not missing data.
  if (!owners.size) return { positions: [], history: h };
  const positions: Loan[] = [];
  // Bound concurrent calls, and reject the whole result if any owner cannot be read.
  const list = [...owners].sort();
  for (let i = 0; i < list.length; i += 6) {
    const batch = await Promise.all(
      list.slice(i, i + 6).map(async (owner) => {
        const [collateral, debt] = (await read(
          r,
          t,
          "positions",
          [owner],
          s.block,
        )) as [bigint, bigint];
        if (!debt) return undefined;
        const cr = (await read(
          r,
          t,
          "collateralRatio",
          [owner],
          s.block,
        )) as bigint;
        return { owner, collateral, debt, cr };
      }),
    );
    positions.push(...batch.filter((p): p is Loan => !!p));
  }
  return { positions, history: h };
}
export function acceptedPoints(t: Target, logs: ChainLog[]): AcceptedPoint[] {
  const preceding = new Map<string, { value: bigint; updatedAt: bigint }>();
  const points: AcceptedPoint[] = [];
  for (const log of logs) {
    const event = decode(t, log);
    if (event?.eventName === "ValueUpdated")
      preceding.set(
        log.transactionHash,
        event.args as unknown as { value: bigint; updatedAt: bigint },
      );
    if (event?.eventName === "AttestationAccepted") {
      const update = preceding.get(log.transactionHash);
      if (!update)
        throw Error("An accepted attestation is missing its value log");
      points.push({
        id: key(log),
        value: update.value,
        time: Number(update.updatedAt),
        block: log.blockNumber,
      });
      preceding.delete(log.transactionHash);
    }
  }
  return points;
}
export async function cadence(
  r: Runtime,
  t: Target,
  head: bigint,
): Promise<Cadence> {
  const h = await history(r, t, head);
  const points = acceptedPoints(t, h.logs);
  if (!points.length)
    throw Error(
      "Could not read accepted attestation history. Reporter-only values are not plotted.",
    );
  return { points, history: h };
}

// Readability labels: a fixed, versioned vocabulary and full-address FNV-1a hash.
// Public deterministic labels are not identities and can collide.
const plates = [
  "Copper",
  "Silver",
  "Golden",
  "Intaglio",
  "Engraved",
  "Milled",
  "Reeded",
  "Etched",
  "Laurel",
  "Burled",
  "Gilt",
  "Woven",
  "Stamped",
  "Chased",
  "Watermarked",
  "Embossed",
];
const denominations = [
  "Crown",
  "Florin",
  "Ducat",
  "Taler",
  "Sovereign",
  "Guinea",
  "Ledger",
  "Note",
  "Plate",
  "Seal",
  "Die",
  "Mint",
  "Shilling",
  "Obol",
  "Mark",
  "Penny",
];
export function positionName(address: string) {
  let hash = 2166136261;
  for (const char of address.toLowerCase())
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${plates[hash & 15]} ${denominations[(hash >>> 8) & 15]}`;
}
