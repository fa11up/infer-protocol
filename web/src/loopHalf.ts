// A leverage round that stopped between its transactions: what has landed, and so what is left to do. Without a batch a
// round is several transactions, and each one moves funds to the wallet that the next is meant to use.
import type { Address } from "viem";

export type HalfStep = "swap" | "deposit" | "unstake" | "sell" | "repay";
export type Half = { at: HalfStep; amount: bigint; account: Address };

/** One transaction of a round, and what is left if the run stops right after it. */
export type Leg<C> = { call: C; leaves?: { at: HalfStep; amount: bigint } };

/** Where a round stands once `landed` of its legs have gone through, starting from `from` (a round being finished). */
export function standing<C>(legs: Leg<C>[], landed: number, from?: Leg<C>["leaves"], whenDone?: Leg<C>["leaves"]) {
  if (landed >= legs.length) return whenDone;
  let at = from;
  for (const l of legs.slice(0, landed)) if (l.leaves) at = l.leaves;
  return at;
}

const key = (account: string) => `comp-terminal-loop-half-${account.toLowerCase()}`;

export function loadHalf(account: Address | undefined): Half | undefined {
  if (!account) return undefined;
  try {
    const h = JSON.parse(localStorage.getItem(key(account)) ?? "null");
    return h && { at: h.at, amount: BigInt(h.amount), account };
  } catch {
    return undefined;
  }
}

export function saveHalf(account: Address, at: Leg<unknown>["leaves"]) {
  try {
    if (at) localStorage.setItem(key(account), JSON.stringify({ at: at.at, amount: at.amount.toString() }));
    else localStorage.removeItem(key(account));
  } catch {}
}
