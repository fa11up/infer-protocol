// The Trade tab's swap card, its pure half: the token list, amounts, the fee rule, 0x's answers read into what
// the card shows, and the choice between 0x (Matcha's engine) and the peg pool for imdUSD <-> USDC. No DOM, so
// Node runs it (tests/swap0x.unit.test.mjs). The page asks 0x only through imdusd.com/swap/* (worker/swap.js),
// which holds the API key and sets the fee itself; FEE_BPS here only describes it.
// Every address below is also on imdusd.com/rpc's allowlist (the build collects addresses from src/).
import { formatUnits, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";

/** 0x's (and everyone's) placeholder for native ether. */
export const ETH_ADDRESS: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** 0x's AllowanceHolder on mainnet: the spender of a 0x swap's approval and the contract the swap is sent to. */
export const ALLOWANCE_HOLDER: Address = "0x0000000000001fF3684f28c67538d4D072C22734";
export const TREASURY: Address = "0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc";
export const IMDUSD_ADDRESS: Address = "0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25";
export const USDC_ADDRESS: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
/** 0.1% to the Treasury on swaps with no imdUSD side (set by the Worker, shown here). */
export const FEE_BPS = 10;
export const SLIPPAGES = [10, 50, 100] as const;
export const DEFAULT_SLIPPAGE_BPS = 50;
/** A 0x quote older than this is fetched again before it is sent. */
export const QUOTE_MAX_AGE_MS = 20_000;

export type Token = { address: Address; symbol: string; name: string; decimals: number; custom?: boolean };

export const TOKENS: Token[] = [
  { address: ETH_ADDRESS, symbol: "ETH", name: "Ether", decimals: 18 },
  { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  { address: USDC_ADDRESS, symbol: "USDC", name: "USD Coin", decimals: 6 },
  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", name: "Tether USD", decimals: 6 },
  { address: IMDUSD_ADDRESS, symbol: "imdUSD", name: "imdUSD", decimals: 18 },
  { address: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7", symbol: "IMD", name: "IdentityMD", decimals: 18 },
  { address: "0x9Efa934D9fAd4AE28c998a40195646b965a97247", symbol: "sIMD", name: "Staked IMD", decimals: 24 },
  { address: "0x53d0eA0A685220718Dc6a0a6e4617194C6F37921", symbol: "INFER", name: "INFER", decimals: 18 },
  { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", name: "Wrapped BTC", decimals: 8 },
  { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8 },
];
/** USDT's approve returns nothing, and it refuses to change a nonzero allowance to another nonzero one. */
export const USDT_ADDRESS: Address = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
/** approve without a declared return value: right for USDT and harmless for every other token. */
export const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
export const TOKEN_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);

export const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const isEth = (t: Token) => same(t.address, ETH_ADDRESS);
export const isDefault = (address: string) => TOKENS.some((t) => same(t.address, address));

/** The fee rule the Worker applies: none when either side is imdUSD, else 0.1% to the Treasury. */
export const feeApplies = (sell: string, buy: string) => !same(sell, IMDUSD_ADDRESS) && !same(buy, IMDUSD_ADDRESS);
export const feeLine = (sell: string, buy: string) =>
  feeApplies(sell, buy) ? "0.1% to the imdUSD Treasury" : "No fee on imdUSD trades";
/** imdUSD <-> USDC, the pair the peg pool can fill directly. */
export const isPegPair = (sell: string, buy: string) =>
  (same(sell, IMDUSD_ADDRESS) && same(buy, USDC_ADDRESS)) || (same(sell, USDC_ADDRESS) && same(buy, IMDUSD_ADDRESS));

/** A typed amount in base units, or undefined while it is not a positive amount the token can hold. */
export function parseAmount(text: string, decimals: number): bigint | undefined {
  const t = text.trim();
  if (!new RegExp(`^(?:\\d+(?:\\.\\d{0,${decimals}})?|\\.\\d{1,${decimals}})$`).test(t)) return undefined;
  const n = parseUnits(t.startsWith(".") ? `0${t}` : t.endsWith(".") ? t.slice(0, -1) : t, decimals);
  return n > 0n ? n : undefined;
}

/** An amount for reading: grouped whole part, and enough decimals to show `sig` significant digits of a small one. */
export function formatAmount(n: bigint | undefined, decimals: number, sig = 6): string {
  if (n === undefined) return "—";
  const [whole, frac = ""] = formatUnits(n, decimals).split(".");
  const w = BigInt(whole);
  let places: number;
  if (w >= 1000n) places = 2;
  else if (w > 0n) places = Math.max(2, sig - whole.length);
  else {
    const lead = frac.length - frac.replace(/^0+/, "").length;
    places = Math.min(decimals, lead + sig);
  }
  const shown = frac.slice(0, places).replace(/0+$/, "");
  return w.toLocaleString("en-US") + (shown ? `.${shown}` : "");
}

/** Search the list by symbol, name or address; a pasted address that is not listed is returned as `paste`. */
export function searchTokens(list: Token[], query: string): { matches: Token[]; paste?: Address } {
  const q = query.trim();
  if (!q) return { matches: list };
  if (isAddress(q, { strict: false })) {
    const hit = list.filter((t) => same(t.address, q));
    return hit.length ? { matches: hit } : { matches: [], paste: q as Address };
  }
  const l = q.toLowerCase();
  const rank = (t: Token) => (t.symbol.toLowerCase() === l ? 0 : t.symbol.toLowerCase().startsWith(l) ? 1 : 2);
  return {
    matches: list
      .filter((t) => t.symbol.toLowerCase().includes(l) || t.name.toLowerCase().includes(l))
      .sort((a, b) => rank(a) - rank(b)),
  };
}

/** Custom tokens saved in this browser, checked field by field: anything malformed is dropped, never trusted. */
export function parseCustomTokens(raw: string | null): Token[] {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: Token[] = [];
  for (const t of v) {
    if (!t || typeof t !== "object") continue;
    const { address, symbol, name, decimals } = t as Record<string, unknown>;
    if (typeof address !== "string" || !isAddress(address, { strict: false }) || isDefault(address)) continue;
    if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    if (out.some((o) => same(o.address, address))) continue;
    out.push({
      address: address as Address,
      symbol: cleanText(symbol, 16) || "???",
      name: cleanText(name, 40),
      decimals,
      custom: true,
    });
  }
  return out;
}
/** A token's own symbol or name, as plain short text (it comes from an unverified contract). */
export const cleanText = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[^\p{L}\p{N} ._$+\-]/gu, "").trim().slice(0, max) : "";

// ---- 0x's answers ------------------------------------------------------------------------------------------
export type Fill = { from: string; to: string; source: string; proportionBps: string };
export type ZeroXAnswer = {
  liquidityAvailable?: boolean;
  buyAmount?: string;
  minBuyAmount?: string;
  sellAmount?: string;
  totalNetworkFee?: string | null;
  fees?: { integratorFee?: { amount: string; token: string } | null };
  issues?: { allowance?: { actual: string; spender: string } | null; balance?: { actual: string; expected: string } | null };
  route?: { fills?: Fill[]; tokens?: { address: string; symbol: string }[] };
  transaction?: { to: Address; data: Hex; value?: string; gas?: string | null };
  /** Not in every 0x answer; shown when present. */
  estimatedPriceImpact?: string | null;
};
export type SwapAnswer = { ok: true; body: ZeroXAnswer } | { ok: false; unavailable: boolean; error: string };

/** What /swap/* answered, read into one shape: a usable answer, "unavailable" (no key, or 0x down), or an error. */
export function readSwapAnswer(status: number, body: any): SwapAnswer {
  if (status === 503 || status === 502 || status === 404) return { ok: false, unavailable: true, error: "Swaps are temporarily unavailable." };
  if (status === 429) return { ok: false, unavailable: false, error: "Too many quotes from this connection. Wait a minute." };
  if (status < 200 || status >= 300 || !body || typeof body !== "object")
    return { ok: false, unavailable: false, error: zeroXError(body) };
  if (body.liquidityAvailable === false || !/^\d+$/.test(String(body.buyAmount ?? "")))
    return { ok: false, unavailable: false, error: "No route has enough liquidity for this trade." };
  return { ok: true, body };
}
const zeroXError = (body: any): string => {
  const name = String(body?.name ?? "");
  if (/INSUFFICIENT_BALANCE/i.test(name)) return "The wallet does not hold enough to sell this amount.";
  if (/TOKEN_NOT_SUPPORTED|INPUT_INVALID|TOKEN_BUY_TAX|TOKEN_SELL_TAX/i.test(name)) return "0x does not trade this token.";
  if (/NO_LIQUIDITY|INSUFFICIENT_LIQUIDITY/i.test(name)) return "No route has enough liquidity for this trade.";
  const text = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "";
  return text ? `The quote failed: ${text.slice(0, 160)}` : "The quote failed. Try again.";
};

/** The route as "Uniswap V4 70% · Curve 30%"; multi-hop routes name their hops. */
export function routeSummary(a: ZeroXAnswer): string {
  const fills = a.route?.fills ?? [];
  if (!fills.length) return "—";
  const sym = new Map((a.route?.tokens ?? []).map((t) => [t.address.toLowerCase(), t.symbol]));
  const hops = new Set(fills.map((f) => `${f.from.toLowerCase()}>${f.to.toLowerCase()}`));
  const bySource = new Map<string, number>();
  for (const f of fills) bySource.set(f.source.replace(/_/g, " "), (bySource.get(f.source.replace(/_/g, " ")) ?? 0) + Number(f.proportionBps));
  const sources = [...bySource].sort((x, y) => y[1] - x[1]);
  const parts = sources.map(([s, bps]) => (hops.size === 1 && sources.length > 1 ? `${s} ${Math.round(bps / 100)}%` : s));
  const via =
    hops.size > 1
      ? ` via ${[...new Set(fills.map((f) => f.to.toLowerCase()))].slice(0, -1).map((t) => sym.get(t) ?? t.slice(0, 8)).join(", ")}`
      : "";
  return parts.join(" · ") + via;
}

/** The fewest tokens the 0x route may return: its own minBuyAmount, else the quote less the chosen slippage. */
export const minReceived = (buy: bigint, slippageBps: number, minBuyAmount?: string) =>
  minBuyAmount && /^\d+$/.test(minBuyAmount) ? BigInt(minBuyAmount) : (buy * BigInt(10_000 - slippageBps)) / 10_000n;

export type Route = "0x" | "direct";
/**
 * Which route the card uses: the one that returns more, the peg pool on a tie (no aggregator in the way) or when
 * 0x has nothing. Undefined while neither has an answer.
 */
export function bestRoute(zeroX: bigint | undefined, direct: bigint | undefined): Route | undefined {
  if (direct === undefined) return zeroX === undefined ? undefined : "0x";
  if (zeroX === undefined) return "direct";
  return zeroX > direct ? "0x" : "direct";
}
export const routeName = (r: Route) => (r === "0x" ? "Matcha/0x" : "Direct: imdUSD peg pool");

/** A quote fetched at `at` is stale after QUOTE_MAX_AGE_MS. */
export const quoteStale = (at: number, now = Date.now()) => now - at > QUOTE_MAX_AGE_MS;

/** The approvals a 0x swap needs: none, one exact approve, or (USDT with a leftover allowance) a reset to 0 first. */
export function approvalsFor(
  token: Token,
  sellAmount: bigint,
  allowance: { actual: string; spender: string } | null | undefined,
): { spender: Address; amount: bigint }[] {
  if (!allowance || isEth(token)) return [];
  if (!isAddress(allowance.spender) || !same(allowance.spender, ALLOWANCE_HOLDER))
    throw Error("0x asked for an approval to an unexpected contract. Nothing was sent.");
  const actual = /^\d+$/.test(allowance.actual) ? BigInt(allowance.actual) : 0n;
  if (actual >= sellAmount) return [];
  const spender = allowance.spender as Address;
  return same(token.address, USDT_ADDRESS) && actual > 0n
    ? [{ spender, amount: 0n }, { spender, amount: sellAmount }]
    : [{ spender, amount: sellAmount }];
}

/** The address 0x knows a token by: native ether (address(0) in a v4 pool key) is its 0xEeee… placeholder. */
export const zeroXAddress = (address: Address): Address => (/^0x0{40}$/.test(address) ? ETH_ADDRESS : address);

/** Ask the site's own /swap/* proxy (worker/swap.js); any failure to reach it reads as "unavailable". */
export async function askSwap(kind: "price" | "quote", q: URLSearchParams): Promise<SwapAnswer> {
  const down = { ok: false, unavailable: true, error: "Swaps are temporarily unavailable." } as const;
  try {
    const res = await fetch(`/swap/${kind}?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!/json/.test(res.headers.get("content-type") ?? "")) return down;
    return readSwapAnswer(res.status, await res.json());
  } catch {
    return down;
  }
}

/** The query /swap/price and /swap/quote take. */
export const swapQuery = (sell: Token, buy: Token, sellAmount: bigint, slippageBps: number, taker?: Address) =>
  new URLSearchParams({
    chainId: "1",
    sellToken: sell.address,
    buyToken: buy.address,
    sellAmount: String(sellAmount),
    slippageBps: String(slippageBps),
    ...(taker ? { taker } : {}),
  });
