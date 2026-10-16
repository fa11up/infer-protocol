// Reads the peg pool for Season 1's liquidity reader: Blockscout first, Etherscan then the RPC when it refuses
// (archive.ts), and every result checked so a silently-empty source cannot pass:
// exactly one Initialize, at least one ModifyLiquidity, a mint for every position, and the replay must end at the
// pool's live tick (StateView.getSlot0 at `through`).
import { fetchFilteredLogs } from "./logs.ts";
import { poolEvents, nftOwnerEvents, S1_TOPICS, type RawLog } from "./pool.ts";
import type { S1Event } from "./season1.ts";
import type { PegPool } from "./chains.ts";
import { archiveLogs, type Rpc } from "./archive.ts";

const STATE_VIEW = "0x7ffe42c4a5deea5b0feC41c94c136cf115597227";

export { rpcLogs, type Rpc } from "./archive.ts";

export async function readPegPool(o: { blockscout: string; poolManager: string; peg: PegPool; through: number; rpc: Rpc }): Promise<S1Event[]> {
  const { blockscout, poolManager, peg, through, rpc } = o;
  const q = async (topic0: string, from = peg.fromBlock, to = through): Promise<RawLog[]> => {
    try {
      return await fetchFilteredLogs(blockscout, { address: poolManager, topic0, topic1: peg.id, fromBlock: from, toBlock: to });
    } catch (err) {
      console.error(`  pool ${topic0.slice(0, 10)}: ${(err as Error).message}; reading from Etherscan instead`);
      return archiveLogs(rpc, poolManager, [topic0, peg.id], from, to);
    }
  };
  const init = await q(S1_TOPICS.initialize, peg.fromBlock, peg.fromBlock);
  const swaps = await q(S1_TOPICS.swap);
  const mods = await q(S1_TOPICS.modifyLiquidity);
  if (init.length !== 1) throw Error(`expected exactly one Initialize for the peg pool, got ${init.length}: refusing to guess the price`);
  if (!mods.length) throw Error("no liquidity logs for the peg pool: refusing to report that nobody provided any");
  const pool = poolEvents([...init, ...swaps, ...mods], peg.positionManager);
  const events: S1Event[] = [...pool.events];
  for (const id of pool.tokenIds) {
    const topic3 = "0x" + id.toString(16).padStart(64, "0");
    let t: RawLog[];
    try {
      t = await fetchFilteredLogs(blockscout, { address: peg.positionManager, topic0: S1_TOPICS.transfer, topic3, fromBlock: peg.fromBlock, toBlock: through });
    } catch (err) {
      console.error(`  position #${id}: ${(err as Error).message}; reading its transfers from Etherscan instead`);
      t = await archiveLogs(rpc, peg.positionManager, [S1_TOPICS.transfer, null, null, topic3], peg.fromBlock, through);
    }
    if (!t.length) throw Error(`no mint/transfer logs for position #${id}: refusing to guess its owner`);
    events.push(...nftOwnerEvents(t));
    await new Promise((r) => setTimeout(r, 400));
  }
  const last = pool.events.filter((e) => e.kind === "price").sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).pop() as { tick: number } | undefined;
  const slot0 = (await rpc("eth_call", [{ to: STATE_VIEW, data: "0xc815641c" + peg.id.slice(2) }, "0x" + through.toString(16)])) as string;
  const tickNow = Number(BigInt.asIntN(24, BigInt("0x" + slot0.slice(2 + 64, 2 + 128))));
  if (!last || last.tick !== tickNow) throw Error(`pool replay ends at tick ${last?.tick}, the chain says ${tickNow}: swap logs are incomplete`);
  return events;
}
