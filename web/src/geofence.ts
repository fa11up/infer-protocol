// The stock-token geofence (planned tokenized-stock collateral), as pure functions: what a visitor may see and do
// with a stock or SGOV type, which types those are, and which transactions the page refuses to send for them.
// The country comes from the Worker (/geo, worker/geo.js), never from the page. Every stock pane goes through
// src/stock-gate.ts, which uses this file; scripts/geofence-check.mjs fails the tests and the launch build otherwise.
import GEO from "./geofence.json" with { type: "json" };
import { decodeFunctionData, hexToString, parseAbi, type Address, type Hex } from "viem";

export { GEO };

/** What /geo answers. */
export type GeoAnswer = { country: string; stocks: boolean; reason: "allowed" | "restricted" | "unknown" };

export type StockAction = "view" | "deposit" | "borrow" | "repay" | "withdraw" | "take" | "claim" | "trade";

/** none = no stock UI at all; unwind = an existing position, read-only, with repay / withdraw / claim;
 *  declare = allowed country, the self-declaration not yet given; full = everything. */
export type StockMode = "none" | "unwind" | "declare" | "full";

export type StockAccess = { mode: StockMode; actions: ReadonlySet<StockAction> };

const UNWIND: StockAction[] = ["view", "repay", "withdraw", "claim"];
const FULL: StockAction[] = ["view", "deposit", "borrow", "repay", "withdraw", "take", "claim", "trade"];

/** The visitor's access to stock types. A missing or malformed answer (not loaded, fetch failed) is a "no". */
export function stockAccess(geo: GeoAnswer | null | undefined, opts: { hasPosition?: boolean; declared?: boolean } = {}): StockAccess {
  const unwind = !!opts.hasPosition && GEO.unwindException;
  if (!geo || geo.stocks !== true) return unwind ? { mode: "unwind", actions: new Set(UNWIND) } : { mode: "none", actions: new Set() };
  if (!opts.declared) return { mode: "declare", actions: new Set(unwind ? UNWIND : []) };
  return { mode: "full", actions: new Set(FULL) };
}

/** The ilk as text ("STOCK-SPY"), or "" if it is not printable. */
export function ilkName(ilk: Hex): string {
  try {
    const s = hexToString(ilk, { size: 32 }).replace(/\0+$/, "");
    return /^[\x20-\x7e]*$/.test(s) ? s : "";
  } catch {
    return "";
  }
}

/** A stock or SGOV type: in the stock debt-cap group on chain, or named like one (so a mislabelled read still hides it). */
export function isStockIlk(ilk: Hex, groupOf: number | bigint | undefined): boolean {
  if (groupOf !== undefined && Number(groupOf) === GEO.stockGroup) return true;
  const name = ilkName(ilk);
  return GEO.stockIlkPrefixes.some((p) => name.startsWith(p));
}

const PARAMS_ABI = parseAbi([
  "function ilkCount() view returns (uint256)",
  "function ilks(uint256) view returns (bytes32)",
  "function groupOf(bytes32) view returns (uint8)",
]);

type Reader = { readContract: (a: { address: Address; abi: typeof PARAMS_ABI; functionName: any; args?: any[] }) => Promise<unknown> };

/** Every stock type registered in Parameters, read from chain, so a type added later is hidden with no site change. */
export async function readStockIlks(client: Reader, params: Address): Promise<Set<Hex>> {
  const n = Number(await client.readContract({ address: params, abi: PARAMS_ABI, functionName: "ilkCount" }));
  const out = new Set<Hex>();
  for (let i = 0; i < n; i++) {
    const ilk = (await client.readContract({ address: params, abi: PARAMS_ABI, functionName: "ilks", args: [BigInt(i)] })) as Hex;
    const group = (await client.readContract({ address: params, abi: PARAMS_ABI, functionName: "groupOf", args: [ilk] })) as number;
    if (isStockIlk(ilk, group)) out.add(ilk.toLowerCase() as Hex);
  }
  return out;
}

const SEND_ABI = parseAbi([
  "function adjust(bytes32 ilk, int256 dCollateral, int256 dDebt, uint64 rate, address prevHint, address nextHint, bool viaAsset)",
  "function repayFor(bytes32 ilk, address owner, uint256 amount)",
  "function take(address owner, uint256 maxPrice)",
  "function claim(address to)",
  "function open(address owner, address marker)",
]);

/** Why the page must not send this transaction, or null. Only stock types are judged: anything else passes.
 *  Unwinding (adjust with dCollateral <= 0 and dDebt <= 0, repayFor, claim) needs "repay"/"withdraw"/"claim";
 *  opening or growing a position, and an auction take or open, need full access. */
export function stockSendRefusal(
  tx: { to: Address; data: Hex },
  where: { ledger: Address; stockJoins: ReadonlySet<string>; stockIlks: ReadonlySet<string> },
  access: StockAccess,
): string | null {
  const to = tx.to.toLowerCase();
  const isLedger = to === where.ledger.toLowerCase();
  const isJoin = where.stockJoins.has(to);
  if (!isLedger && !isJoin) return null;
  let call;
  try {
    call = decodeFunctionData({ abi: SEND_ABI, data: tx.data });
  } catch {
    return isJoin ? "unknown call to a stock auction" : null;
  }
  const can = (a: StockAction) => access.actions.has(a);
  if (isLedger) {
    if (call.functionName !== "adjust" && call.functionName !== "repayFor") return null;
    const ilk = (call.args[0] as Hex).toLowerCase();
    if (!where.stockIlks.has(ilk)) return null;
    if (call.functionName === "repayFor") return can("repay") ? null : "stock types are not offered in your region";
    const [, dCol, dDebt] = call.args as unknown as [Hex, bigint, bigint];
    if (dCol <= 0n && dDebt <= 0n) return can("repay") || can("withdraw") ? null : "stock types are not offered in your region";
    return can("borrow") && can("deposit") ? null : "stock types are not offered in your region";
  }
  if (call.functionName === "claim") return can("claim") ? null : "stock types are not offered in your region";
  return can("take") ? null : "stock auctions are not offered in your region";
}

/** Where a wallet's self-declaration is kept (this browser only). */
export const declarationKey = (wallet: string) => `stock-declaration:${wallet.toLowerCase()}`;
