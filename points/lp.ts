// Liquidity points: imdUSD provided to the imdUSD/USDC peg pool, as LpValue events for the engine. PURE.
//
// Uniswap v4 keeps every pool's tokens in the PoolManager, so a deposit is an imdUSD Transfer from the provider
// to the PoolManager and a withdrawal one from the PoolManager to the recipient, in a transaction that also
// emits the pool's ModifyLiquidity. Swaps move imdUSD to and from the PoolManager too, so only transactions
// carrying a peg-pool ModifyLiquidity count.
//
// THE MEASURE: imdUSD put in, less imdUSD taken out, per wallet, never below zero. Credited to the wallet that
// paid it in (the position NFT's owner at deposit, in the normal flow) and reduced for whoever receives it on
// withdrawal. It is the amount deposited, not the position's value at each block: price moves inside the range
// change a position's imdUSD, but reading that needs pool state at every block, and this needs only logs, so
// anyone reproduces it from the same two event sets.

import type { LpValue } from "./engine.ts";

export type TxTransfer = { from: string; to: string; value: bigint; block: number; logIndex: number; tx: string };

export function lpEvents(transfers: TxTransfer[], lpTxs: Set<string>, poolManager: string): LpValue[] {
  const pm = poolManager.toLowerCase();
  const txs = new Set([...lpTxs].map((t) => t.toLowerCase()));
  const provided = new Map<string, bigint>();
  const out: LpValue[] = [];
  const sorted = [...transfers].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const t of sorted) {
    if (!txs.has(t.tx.toLowerCase())) continue;
    const from = t.from.toLowerCase(),
      to = t.to.toLowerCase();
    let owner: string, next: bigint;
    if (to === pm && from !== pm) {
      owner = from;
      next = (provided.get(owner) ?? 0n) + t.value;
    } else if (from === pm && to !== pm) {
      owner = to;
      const before = provided.get(owner) ?? 0n;
      next = before > t.value ? before - t.value : 0n;
    } else continue;
    provided.set(owner, next);
    out.push({ kind: "lp", owner, value: next, block: t.block, logIndex: t.logIndex });
  }
  return out;
}
