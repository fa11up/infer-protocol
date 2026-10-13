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
  const floor = historyConfig.historyFloor[r.config.launchId];
  if (floor !== undefined && floor <= head) return floor;
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
    // Windows end on multiples of chunkSize, so every visitor asks for the same closed windows and /rpc can serve
    // them from its cache; they are read several at a time, and any one failing fails the range as before. The first
    // runs at least a full chunk (up to two), so a start just before a boundary is not a sliver that holds no logs
    // and fails as unverified.
    const size = historyConfig.chunkSize;
    const windows: [bigint, bigint][] = [];
    for (let start = from; start <= to; ) {
      if (windows.length >= historyConfig.maxChunks)
        throw Error("History range limit");
      const end = ((start + size - 1n) / size + 1n) * size - 1n;
      windows.push([start, end < to ? end : to]);
      start = end + 1n;
    }
    // The newest window is usually a sliver up to the head, often with no logs yet, which would fail as unverified
    // and send the whole range to Blockscout: it reaches back a full chunk instead (never before `from`). It overlaps
    // the window before it; history() drops the repeated logs.
    const last = windows[windows.length - 1];
    if (windows.length > 1 && last[1] - last[0] + 1n < size) last[0] = last[1] - size + 1n > from ? last[1] - size + 1n : from;
    const read = async ([start, end]: [bigint, bigint]) => {
      const batch = await r.client.getLogs({
        address: t.address,
        fromBlock: start,
        toBlock: end,
      });
      // Some providers silently refuse ranges with []. Never treat that as proof of absence.
      if (!batch.length) throw Error("Empty RPC log range is unverified");
      const normalized = batch.map((log) => normalize(log, t.address));
      if (normalized.some((log) => log.blockNumber < start || log.blockNumber > end))
        throw Error("RPC returned logs outside the requested range");
      return normalized;
    };
    const got: ChainLog[][] = new Array(windows.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(historyConfig.parallel, windows.length) }, async () => {
        while (next < windows.length) {
          const i = next++;
          got[i] = await read(windows[i]);
        }
      }),
    );
    const logs = [...new Map(got.flat().map((l) => [key(l), l])).values()];
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
// History kept in the browser between visits, so a returning visitor reads only the blocks since: per deployment and
// contract, with bigints as strings. Storage may be missing or full (private windows, previews): then it is skipped.
const stored = (r: Runtime, address: Address) => `history:${r.config.chainId}:${r.config.launchId}:${address.toLowerCase()}`;
function load(r: Runtime, address: Address): History | undefined {
  try {
    const raw = localStorage.getItem(stored(r, address));
    if (!raw) return undefined;
    const h = JSON.parse(raw);
    return {
      from: BigInt(h.from),
      through: BigInt(h.through),
      source: h.source,
      logs: h.logs.map((l: any) => normalize({ ...l, blockNumber: BigInt(l.blockNumber) }, address)),
    };
  } catch {
    return undefined;
  }
}
function save(r: Runtime, address: Address, h: History) {
  try {
    localStorage.setItem(
      stored(r, address),
      JSON.stringify({ ...h, from: h.from.toString(), through: h.through.toString(), logs: h.logs.map((l) => ({ ...l, blockNumber: l.blockNumber.toString() })) }),
    );
  } catch {
    /* No storage: the next visit reads from the start again. */
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
  if (!map.has(t.address)) {
    const kept = load(r, t.address);
    if (kept) map.set(t.address, kept);
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
  save(r, t.address, result);
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
  // Every owner at once (the client bundles them into multicalls), rejecting the whole result if any cannot be read.
  const list = [...owners].sort();
  const rows = await Promise.all(
    list.map(async (owner) => {
      const [[collateral, debt], cr] = (await Promise.all([
        read(r, t, "positions", [owner], s.block),
        read(r, t, "collateralRatio", [owner], s.block),
      ])) as [[bigint, bigint], bigint];
      return debt ? { owner, collateral, debt, cr } : undefined;
    }),
  );
  const positions = rows.filter((p): p is Loan => !!p);
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
