// The imdUSD/USDC peg pool's own logs, read from the PoolManager by pool id in the same aligned windows history.ts
// uses (so imdusd.com/rpc can serve closed windows from its cache). Shared by the points pane and the analytics page.
import { poolEvents, S1_TOPICS, type RawLog } from "../../points/pool.ts";
import { historyConfig, pointsConfig, type Runtime } from "./config";

/** Aligned [from, to] windows up to the head, each ending on a multiple of the chunk size. */
function windowsFrom(from: number, head: number): [number, number][] {
  const step = Number(historyConfig.chunkSize);
  const w: [number, number][] = [];
  for (let a = from; a <= head; ) {
    const b = (Math.floor((a + step - 1) / step) + 1) * step - 1;
    w.push([a, Math.min(head, b)]);
    a = b + 1;
  }
  return w;
}

async function scan(r: Runtime, windows: [number, number][], address: string, topics: unknown[]): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(historyConfig.parallel, windows.length) }, async () => {
      while (next < windows.length) {
        const [a, b] = windows[next++];
        const logs = (await r.client.request({
          method: "eth_getLogs",
          params: [{ address: address as `0x${string}`, topics: topics as never, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
        })) as RawLog[];
        out.push(...logs);
      }
    }),
  );
  return out;
}

/** Every log of the peg pool (Initialize, Swap, ModifyLiquidity), kept in memory per runtime: a later call reads only
 * from 64 blocks before the last scan (dropping what was kept from there), so a reorganised block is read again.
 * Undefined on a chain with no peg pool. */
const poolScans = new WeakMap<Runtime, { through: number; logs: RawLog[] }>();
export async function pegPoolScan(r: Runtime, head: number): Promise<RawLog[] | undefined> {
  const pool = pointsConfig.pegPools[r.config.chainId];
  const pm = pointsConfig.poolManagers[r.config.chainId];
  if (!pool || !pm) return undefined;
  const old = poolScans.get(r);
  const from = old ? Math.max(pool.fromBlock, old.through - 63) : pool.fromBlock;
  const fresh = await scan(r, windowsFrom(from, head), pm, [[S1_TOPICS.initialize, S1_TOPICS.swap, S1_TOPICS.modifyLiquidity], pool.poolId]);
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
  const nft = ids.length ? await scan(r, windowsFrom(pool.fromBlock, head), pool.positionManager, [S1_TOPICS.transfer, null, null, ids]) : [];
  return { pool: logs, nft };
}
