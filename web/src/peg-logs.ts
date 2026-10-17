// The imdUSD/USDC peg pool's own logs, read from the PoolManager by pool id in the same aligned windows history.ts
// uses (so imdusd.com/rpc can serve closed windows from its cache). Shared by the points pane and the analytics page.
import { poolEvents, S1_TOPICS, type RawLog } from "../../points/pool.ts";
import { pointsConfig, type Runtime } from "./config";
import { alignedWindows, limited, logClient } from "./history";
import { indexView, tailFrom, type IndexView } from "./history-index";

/** Aligned windows from `from` up to the head (history.ts alignedWindows: closed ones are cache-identical at /rpc). */
const windowsFrom = (from: number, head: number): [number, number][] =>
  alignedWindows(BigInt(from), BigInt(head)).map(([a, b]) => [Number(a), Number(b)]);

async function scan(r: Runtime, windows: [number, number][], address: string, topics: unknown[]): Promise<RawLog[]> {
  const got = await Promise.all(
    windows.map(([a, b]) =>
      limited(
        r,
        () =>
          logClient(r).request({
            method: "eth_getLogs",
            params: [{ address: address as `0x${string}`, topics: topics as never, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
          }) as Promise<RawLog[]>,
      ),
    ),
  );
  // The open window can reach back over the closed one before it: a log read twice is kept once.
  return [...new Map(got.flat().map((l) => [`${l.transactionHash}:${BigInt(l.logIndex)}`, l])).values()];
}

/** Every log of the peg pool (Initialize, Swap, ModifyLiquidity), kept in memory per runtime: a later call reads only
 * from 64 blocks before the last scan (dropping what was kept from there), so a reorganised block is read again.
 * Undefined on a chain with no peg pool. */
const poolScans = new WeakMap<Runtime, { through: number; logs: RawLog[] }>();
const poolReads = new WeakMap<Runtime, { head: number; read: Promise<RawLog[] | undefined> }>();
/** Concurrent callers at the same head (the points pane, the analytics panels) share one scan. */
export function pegPoolScan(r: Runtime, head: number): Promise<RawLog[] | undefined> {
  const old = poolReads.get(r);
  if (old?.head === head) return old.read;
  const read = readPegPool(r, head).finally(() => poolReads.get(r)?.read === read && poolReads.delete(r));
  poolReads.set(r, { head, read });
  return read;
}
/**
 * Logs from the public history index (history-index.ts) for [from, through − 12) that pass `keep`, and the block the
 * chain must be read from after them; or undefined (read it all from the chain) when the index is not usable here,
 * does not hold `address`, or would add nothing.
 */
async function indexed(r: Runtime, head: number, from: number, address: string, keep: (l: RawLog) => boolean): Promise<{ logs: RawLog[]; tail: number; view: IndexView } | undefined> {
  const view = await indexView(r, BigInt(head));
  if (!view || !view.addresses.has(address.toLowerCase())) return undefined;
  const tail = Number(tailFrom(view));
  if (from >= tail) return undefined;
  const a = address.toLowerCase();
  const logs = view.logs.filter((l) => {
    const b = Number(BigInt(l.blockNumber));
    return l.address === a && b >= from && b < tail && keep(l);
  });
  return { logs, tail, view };
}
const POOL_TOPICS = [S1_TOPICS.initialize, S1_TOPICS.swap, S1_TOPICS.modifyLiquidity];

async function readPegPool(r: Runtime, head: number): Promise<RawLog[] | undefined> {
  const pool = pointsConfig.pegPools[r.config.chainId];
  const pm = pointsConfig.poolManagers[r.config.chainId];
  if (!pool || !pm) return undefined;
  const old = poolScans.get(r);
  const from = old ? Math.max(pool.fromBlock, old.through - 63) : pool.fromBlock;
  // The index up to its through − 12 (when usable), the chain after that; the chain alone otherwise.
  const pre = await indexed(r, head, from, pm, (l) => POOL_TOPICS.includes(l.topics[0]?.toLowerCase()) && l.topics[1]?.toLowerCase() === pool.poolId.toLowerCase());
  const chainFrom = pre ? pre.tail : from;
  // Aligned windows can start before `from`: what is older is already kept.
  const fresh = [
    ...(pre?.logs ?? []),
    ...(chainFrom <= head
      ? (await scan(r, windowsFrom(chainFrom, head), pm, [POOL_TOPICS, pool.poolId])).filter((l) => Number(BigInt(l.blockNumber)) >= chainFrom)
      : []),
  ];
  const logs = [...(old?.logs.filter((l) => Number(BigInt(l.blockNumber)) < from) ?? []), ...fresh];
  poolScans.set(r, { through: head, logs });
  if (!logs.some((l) => l.topics[0]?.toLowerCase() === S1_TOPICS.initialize)) throw new Error("the peg pool's Initialize was not read: liquidity cannot be priced");
  return logs;
}

/** The peg pool's logs and its positions' NFT transfers, for Season 1's liquidity reader (points/preseason.ts). */
export async function pegPoolLogs(r: Runtime, head: number): Promise<{ pool: RawLog[]; nft: RawLog[] } | undefined> {
  const pool = pointsConfig.pegPools[r.config.chainId];
  if (!pool?.positionManager) return undefined;
  const logs = await pegPoolScan(r, head);
  if (!logs) return undefined;
  const { tokenIds } = poolEvents(logs, pool.positionManager);
  const ids = tokenIds.map((id) => "0x" + id.toString(16).padStart(64, "0"));
  if (!ids.length) return { pool: logs, nft: [] };
  const wanted = new Set(ids);
  const pre = await indexed(r, head, pool.fromBlock, pool.positionManager, (l) => l.topics[0]?.toLowerCase() === S1_TOPICS.transfer && wanted.has(l.topics[3]?.toLowerCase()));
  const chainFrom = pre ? pre.tail : pool.fromBlock;
  const recent =
    chainFrom <= head
      ? (await scan(r, windowsFrom(chainFrom, head), pool.positionManager, [S1_TOPICS.transfer, null, null, ids])).filter((l) => !pre || Number(BigInt(l.blockNumber)) >= chainFrom)
      : [];
  const nft = [...(pre?.logs ?? []), ...recent];
  return { pool: logs, nft };
}
