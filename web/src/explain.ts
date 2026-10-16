import { unit } from "./unit.ts";
import { gemUnit, fmtGem } from "./collateral.ts";
import type { Address } from "viem";
import type { Snapshot } from "./state.ts";
import { ours } from "./names.ts";
import { age, fmt, money, maxDebt, percent, requiredCollateral } from "./math.ts"; // explicit extension: tests import this file directly under node

// A refused simulation names a revert. The reader needs the figure that blocked them, so each
// known revert is restated with the numbers the snapshot already holds. Anything not covered here
// falls through to the plain-language dictionary in math.ts.

export type Failure = { name: string; args: readonly unknown[] };
export function failure(e: unknown): Failure | undefined {
  let x: unknown = e;
  for (let i = 0; i < 8 && x; i++) {
    const c = x as {
      data?: { errorName?: string; args?: readonly unknown[] };
      cause?: unknown;
    };
    if (c.data?.errorName)
      return { name: ours(c.data.errorName), args: c.data.args ?? [] };
    x = c.cause;
  }
  return undefined;
}

export type Context = {
  fn: string;
  args: readonly unknown[];
  s?: Snapshot;
  account?: Address;
};

const feedLabel: Record<string, string> = {
  PriceFeed: "IMD / ETH primary",
  NhiFeed: "network health",
  SpotFeed: "IMD / ETH spot",
  USD: "IMD / USD",
};
const imd = (v: bigint) => `${fmtGem(v)} ${gemUnit()}`;
const comp = (v: bigint) => `${money(v)}`;

export function explain(f: Failure, c: Context): string | undefined {
  const { s } = c;
  const v = s?.v ?? {};
  const amount = c.args.find((a) => typeof a === "bigint") as
    bigint | undefined;
  const price = s?.feeds.Collateral?.value;
  const collateral = v.positions?.[0] as bigint | undefined;
  const debt = v.debtOf as bigint | undefined;
  const minCR = v.mat as bigint | undefined;
  switch (f.name) {
    case "StaleFeed": {
      if (!s) return;
      const now = s.timestamp;
      const stale = Object.entries(s.feeds)
        .filter(([, x]) => x.stale)
        .map(
          ([k, x]) =>
            `${feedLabel[k] ?? k} last updated ${age(x.updated, now)} against a ${x.maxAge}s limit`,
        );
      return stale.length
        ? `A required feed is stale: ${stale.join("; ")}. It reopens when a fresh attestation is relayed.`
        : undefined;
    }
    case "PriceDivergence": {
      const a = s?.feeds.PriceFeed?.value,
        b = s?.feeds.SpotFeed?.value;
      if (!a || b === undefined || v.skew === undefined) return;
      const bps = ((a > b ? a - b : b - a) * 10000n) / a;
      return `Primary and spot disagree by ${percent(bps)}; the vault allows ${percent(v.skew)}. Price-dependent actions reopen when they converge.`;
    }
    case "UnsafeCollateralRatio": {
      if (
        collateral === undefined ||
        debt === undefined ||
        !minCR ||
        !price ||
        !amount
      )
        return;
      if (c.fn === "draw") {
        const need = requiredCollateral(debt + amount, minCR, price);
        const most = maxDebt(collateral, minCR, price);
        return `Borrowing ${comp(amount)} needs ${imd(need)} of collateral at minCR ${minCR}%; this position holds ${imd(collateral)}. The most you can borrow now is ${comp(most > debt ? most - debt : 0n)}.`;
      }
      if (c.fn === "free") {
        const keep = requiredCollateral(debt, minCR, price);
        const left = collateral > amount ? collateral - amount : 0n;
        return `Withdrawing ${imd(amount)} would leave ${imd(left)}; a debt of ${comp(debt)} needs at least ${imd(keep)} at minCR ${minCR}%. The most you can withdraw now is ${imd(collateral > keep ? collateral - keep : 0n)}.`;
      }
      return;
    }
    case "InsufficientCollateral":
      if (c.fn === "free" && collateral !== undefined && amount)
        return `This position holds ${imd(collateral)}; the withdrawal asks for ${imd(amount)}.`;
      return;
    case "DebtCeilingReached": {
      if (!amount || v.totalDebt === undefined || v.line === undefined) return;
      const room: bigint =
        v.line > v.totalDebt
          ? (v.line as bigint) - (v.totalDebt as bigint)
          : 0n;
      return `Total debt would reach ${comp((v.totalDebt as bigint) + amount)} against a ceiling of ${comp(v.line)}. Room left: ${comp(room)}.`;
    }
    case "ExcessRepayment":
      if (c.fn === "wipe" && debt !== undefined && amount)
        return `This position owes ${comp(debt)} including fees; the repayment is ${comp(amount)}.`;
      if (c.fn === "cash" && v.supply !== undefined && amount)
        return `${unit()} supply is ${comp(v.supply)}; the redemption is ${comp(amount)}.`;
      return;
    case "InsufficientRights":
      if (v.rights !== undefined && amount)
        return `This wallet holds ${comp(v.rights)} of work rights; the mint asks for ${comp(amount)}.`;
      return;
    case "WorkCeilingReached": {
      if (!amount || v.earnLine === undefined || v.totalEarned === undefined)
        return;
      const room: bigint =
        v.earnLine > v.totalEarned
          ? (v.earnLine as bigint) - (v.totalEarned as bigint)
          : 0n;
      return `Work issuance would reach ${comp((v.totalEarned as bigint) + amount)} against a backing ceiling of ${comp(v.earnLine)}. Room left: ${comp(room)}.`;
    }
    case "ERC20InsufficientBalance": {
      const [, balance, needed] = f.args as [unknown, bigint, bigint];
      if (typeof balance === "bigint" && typeof needed === "bigint")
        return `This wallet holds ${fmt(balance)}; the action needs ${fmt(needed)}.`;
      return;
    }
    case "ERC20InsufficientAllowance": {
      const [, allowance, needed] = f.args as [unknown, bigint, bigint];
      if (typeof allowance === "bigint" && typeof needed === "bigint")
        return `The vault may spend ${fmt(allowance)}; this needs ${fmt(needed)}. Approve the amount first.`;
      return;
    }
    case "WrongQuestion": {
      const [expected, got] = f.args as [string, string];
      return `The attestation answers question ${String(got).slice(0, 10)}…; this feed pins ${String(expected).slice(0, 10)}….`;
    }
    case "WindowNotAdvancing": {
      const [to, last] = f.args as [bigint, bigint];
      return `The attestation window closes at block ${to}; the feed already accepted one closing at ${last}.`;
    }
  }
  return undefined;
}

/** Restate a refused simulation with its blocking figure, or rethrow it for the dictionary. */
export function explained(
  e: unknown,
  c: Context,
  extra?: (f: Failure) => string | undefined,
): never {
  const f = failure(e);
  const text = f && (extra?.(f) ?? explain(f, c));
  if (text) throw Error(text);
  throw e;
}
