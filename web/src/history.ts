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
import { indexView, tailFrom } from "./history-index";

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
  source: "RPC" | "Blockscout" | "Index";
  /** When the public index (history-index.ts) served the history up to here: its `through`. */
  index?: bigint;
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
        const code = await archiveClient(r).getCode({
          address: t.address,
          blockNumber: mid,
        });
        if (code && code !== "0x") hi = mid;
        else lo = mid + 1n;
      }
      const code = await archiveClient(r).getCode({
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
/**
 * Aligned windows over [from, head]: every closed window is a whole [k·size, (k+1)·size − 1], so every visitor asks
 * for the same ones and /rpc can serve them from its cache; the open window, [k·size, head], reaches back to at least
 * `tail` blocks when it is shorter (so a window just past a boundary is not a sliver that holds no logs and reads as
 * unverified). Closed windows are only listed down to `from`; the open one may start before it.
 */
export function alignedWindows(from: bigint, head: bigint, size = historyConfig.windowSize, tail = historyConfig.tailSize): [bigint, bigint][] {
  if (head < from) return [];
  const k = head / size;
  const open: [bigint, bigint] = [k * size, head];
  if (head - open[0] + 1n < tail) open[0] = head + 1n >= tail ? head - tail + 1n : 0n;
  const windows: [bigint, bigint][] = [];
  for (let j = from / size; from < open[0] && j < k; j++) {
    if (windows.length >= historyConfig.maxChunks) throw Error("History range limit");
    windows.push([j * size, (j + 1n) * size - 1n]);
  }
  windows.push(open);
  return windows;
}

/**
 * The deployment's history contracts, read together: one eth_getLogs per window names all of them (sorted, lowercase,
 * so the request body, and /rpc's cache key, is the same for every visitor), and the answer is split per contract.
 * Registered from the snapshot (state.ts) once the vault's linked contracts are known. A contract outside the group
 * is read alone, as before.
 */
const groups = new WeakMap<Runtime, string[]>();
export function historyGroup(r: Runtime, addresses: Address[]) {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))].sort();
  const old = groups.get(r);
  if (!old || old.join() !== list.join()) groups.set(r, list);
  // A new snapshot is a new refresh: windows still open at the last one are read again.
  openWindows.get(r)?.clear();
}
const groupOf = (r: Runtime, address: Address) => {
  const g = groups.get(r);
  return g?.includes(address.toLowerCase()) ? g : [address.toLowerCase()];
};
/** The client eth_getLogs goes through (config.ts: /rpc, then providers that serve old ranges), else the main one. */
export const logClient = (r: Runtime) => (r as Partial<Pick<Runtime, "logs">>).logs ?? r.client;
/** The client for state at a past block (config.ts: /rpc, the archive gateways, then the deployment's RPCs). */
export const archiveClient = (r: Runtime) => (r as Partial<Pick<Runtime, "archive">>).archive ?? r.client;

/** At most historyConfig.parallel log reads at once per runtime, whoever asks. */
const slots = new WeakMap<Runtime, { busy: number; queue: (() => void)[] }>();
export async function limited<T>(r: Runtime, fn: () => Promise<T>): Promise<T> {
  let s = slots.get(r);
  if (!s) slots.set(r, (s = { busy: 0, queue: [] }));
  if (s.busy >= historyConfig.parallel) await new Promise<void>((go) => s!.queue.push(go));
  else s.busy++;
  try {
    return await fn();
  } finally {
    const next = s.queue.shift();
    if (next) next();
    else s.busy--;
  }
}

type Split = Map<string, ChainLog[]>;
// A window wholly FINAL_DEPTH below the head when read cannot be reorganised: kept for the runtime's life, as /rpc
// keeps it for a month. A window nearer the head is shared only by the readers of one refresh (cleared by the next
// snapshot, historyGroup); a failure is never kept, so a retry reads again.
const FINAL_DEPTH = 64n;
const closedWindows = new WeakMap<Runtime, Map<string, Promise<Split>>>();
const openWindows = new WeakMap<Runtime, Map<string, Promise<Split>>>();
function memo(m: WeakMap<Runtime, Map<string, Promise<Split>>>, r: Runtime) {
  let x = m.get(r);
  if (!x) m.set(r, (x = new Map()));
  return x;
}
function readWindow(r: Runtime, addresses: string[], [start, end]: [bigint, bigint], head: bigint): Promise<Split> {
  const closed = end + FINAL_DEPTH <= head;
  const map = memo(closed ? closedWindows : openWindows, r);
  const id = `${addresses.join(",")}:${start}-${end}`;
  const old = map.get(id);
  if (old) return old;
  const wanted = new Set(addresses);
  const pending = limited(r, () =>
    logClient(r).getLogs({
      address: (addresses.length === 1 ? addresses[0] : addresses) as Address | Address[],
      fromBlock: start,
      toBlock: end,
    }),
  ).then((batch) => {
    // Some providers silently refuse ranges with []. Never treat that as proof of absence: with several contracts in
    // one window an empty answer is just as unverified, and every contract in it falls back to Blockscout.
    if (!batch.length) throw Error("Empty RPC log range is unverified");
    const split: Split = new Map(addresses.map((a) => [a, []]));
    for (const raw of batch) {
      const a = String((raw as { address?: unknown }).address ?? "").toLowerCase();
      if (!wanted.has(a)) throw Error("Log address mismatch");
      const log = normalize(raw, a as Address);
      if (log.blockNumber < start || log.blockNumber > end) throw Error("RPC returned logs outside the requested range");
      split.get(a)!.push(log);
    }
    return split;
  });
  map.set(id, pending);
  pending.catch(() => map.get(id) === pending && map.delete(id));
  return pending;
}

export async function rangeLogs(
  r: Runtime,
  t: Target,
  from: bigint,
  to: bigint,
): Promise<{ logs: ChainLog[]; source: History["source"] }> {
  try {
    return await rpcRange(r, t, from, to);
  } catch {
    return fromExplorer(r, t, from, to);
  }
}
/** The range from the RPC, or a throw when any window is refused or unverified. */
async function rpcRange(
  r: Runtime,
  t: Target,
  from: bigint,
  to: bigint,
): Promise<{ logs: ChainLog[]; source: History["source"] }> {
  // Every window at once (limited() keeps a runtime to historyConfig.parallel reads), any one failing fails the
  // range as before. Windows the other contracts' readers asked for are shared, not read again.
  const addresses = groupOf(r, t.address);
  const own = t.address.toLowerCase();
  const got = await Promise.all(alignedWindows(from, to).map((w) => readWindow(r, addresses, w, to)));
  const logs = [
    ...new Map(
      got
        .flatMap((split) => split.get(own) ?? [])
        .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
        .map((l) => [key(l), l]),
    ).values(),
  ];
  // A contract read alone must show a log to be verified. In a group the windows were verified by the answer as a
  // whole, so a contract with nothing in this range is believed, except when the range is its whole history
  // (history() checks that), the same unknown-versus-empty rule as before.
  if (!logs.length && addresses.length === 1) throw Error("No verifiable logs");
  return { logs, source: "RPC" };
}
/**
 * The range from the public history index up to its `through` − 12 and the chain after that, or undefined when the
 * index is not usable here (history-index.ts) or would add nothing (a refresh inside the chain's tail). Only for the
 * deployment's history group, and only when the index holds every contract in it.
 */
async function fromIndex(
  r: Runtime,
  t: Target,
  from: bigint,
  to: bigint,
): Promise<{ logs: ChainLog[]; source: History["source"]; index: bigint } | undefined> {
  const addresses = groupOf(r, t.address);
  if (addresses.length < 2) return undefined;
  const view = await indexView(r, to);
  if (!view || !addresses.every((a) => view.addresses.has(a))) return undefined;
  const tail = tailFrom(view);
  if (from >= tail) return undefined;
  const own = t.address.toLowerCase();
  const indexed = view.logs
    .filter((l) => l.address === own)
    .map((l) => normalize(l, t.address))
    .filter((l) => l.blockNumber >= from && l.blockNumber < tail);
  const recent = to >= tail ? (await rpcRange(r, t, tail, to)).logs : [];
  return { logs: [...indexed, ...recent], source: "Index", index: view.through };
}
async function fromExplorer(r: Runtime, t: Target, from: bigint, to: bigint): Promise<{ logs: ChainLog[]; source: History["source"] }> {
  const logs = await explorerLogs(r, t, from, to);
  if (!logs.length)
    throw Error(
      "Could not read history: RPC and Blockscout returned no verifiable logs. Retry history.",
    );
  return { logs, source: "Blockscout" };
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
      ...(h.index !== undefined ? { index: BigInt(h.index) } : {}),
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
      JSON.stringify({ ...h, from: h.from.toString(), through: h.through.toString(), index: h.index?.toString(), logs: h.logs.map((l) => ({ ...l, blockNumber: l.blockNumber.toString() })) }),
    );
  } catch {
    /* No storage: the next visit reads from the start again. */
  }
}
const inFlight = new WeakMap<Runtime, Map<string, Promise<History>>>();
/** A contract's history from its first block to `head`. Concurrent calls for the same contract and head share one read. */
export function history(
  r: Runtime,
  t: Target,
  head: bigint,
): Promise<History> {
  let m = inFlight.get(r);
  if (!m) inFlight.set(r, (m = new Map()));
  const id = `${t.address.toLowerCase()}@${head}`;
  const old = m.get(id);
  if (old) return old;
  const pending = readHistory(r, t, head).finally(() => m!.delete(id));
  m.set(id, pending);
  return pending;
}
async function readHistory(
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
  // Re-read the reorg overlap. A contract read alone also retains an anchor log in every refresh (its own logs are
  // what verify the read); in a group the window is verified by every contract's logs, so it starts at the overlap.
  const alone = groupOf(r, t.address).length === 1;
  const anchor = alone ? (old?.logs.at(-1)?.blockNumber ?? from) : (old?.through ?? from);
  const overlap =
    anchor > historyConfig.overlap ? anchor - historyConfig.overlap : from;
  const start =
    old && head >= old.through ? (overlap > from ? overlap : from) : from;
  let next: Awaited<ReturnType<typeof rangeLogs>> & { index?: bigint };
  let kept = old?.logs.filter((l) => l.blockNumber < start) ?? [];
  try {
    // The public index first (verified by infer-ops against the chain; an empty contract there is believed), then the
    // chain as before: any failure of the index path is silent and the chain path runs whole.
    const viaIndex = await fromIndex(r, t, start, head).catch(() => undefined);
    if (viaIndex) next = viaIndex;
    else {
      next = await rpcRange(r, t, start, head);
      // No log in the contract's whole history is unknown, not empty: Blockscout must confirm it (below).
      if (!kept.length && !next.logs.length) throw Error("No verifiable logs");
    }
  } catch {
    // Blockscout pages the contract's whole history whatever the range, so the fallback takes all of it: a refresh
    // range with no log of this contract (normal in a group) is then not mistaken for a refused read, and an empty
    // whole history still fails as unknown.
    next = await fromExplorer(r, t, from, head);
    kept = [];
  }
  const combined = [...kept, ...next.logs];
  const logs = [...new Map(combined.map((l) => [key(l), l])).values()].sort(
    (a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
  );
  // A refresh that read only the chain's tail on top of indexed history still says where its history came from.
  const viaIndex = next.source === "Index" || (next.source === "RPC" && old?.source === "Index");
  const result: History = viaIndex
    ? { logs, from, through: head, source: "Index", index: next.index ?? old?.index }
    : { logs, from, through: head, source: next.source };
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
