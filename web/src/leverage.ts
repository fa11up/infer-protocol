// The leverage loop's arithmetic and calldata. Pure, no DOM, so Node can run it against a mainnet fork
// (tests/loop.fork.test.mjs) and the terminal's Leverage window imports the same.
//
// One round up: Borrow (`draw`) imdUSD, swap it for IMD, Deposit (`lockIMD`, the vault stakes it as sIMD).
// One round down: Withdraw (`free`) sIMD, unstake it to IMD, swap that for imdUSD, Repay (`wipe`).
// There is no imdUSD/IMD pool, so a swap crosses three Uniswap v4 pools in one Universal Router call:
//   imdUSD/USDC (the peg pool, PegFeeHook) -> USDC/ETH (0.05%) -> ETH/IMD (1%, the pool the feeds read).
// Mainnet only: every address below is chain 1, and the peg pool is keyed to the deployed imdUSD.
import {
  encodeAbiParameters,
  encodePacked,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { NATIVE, QUOTER, poolId, type PoolKey } from "./infer/swap.ts";

export const LOOP_CHAIN_ID = 1;
export const IMDUSD: Address = "0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25";
export const IMD: Address = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
export const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const PEG_HOOK: Address = "0x33cA5c16208EC08aC97d4f6315aaFA792A916044";
/** Uniswap's mainnet contracts: Universal Router, V4 Quoter, Permit2 and the v4 StateView. */
export const UNISWAP = {
  universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af" as Address,
  quoter: "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
  stateView: "0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227" as Address,
};

/** imdUSD/USDC: static 0.01% LP fee, tick spacing 1, the PegFeeHook's surcharge beyond ±0.25%. */
export const PEG_KEY: PoolKey = { currency0: IMDUSD, currency1: USDC, fee: 100, tickSpacing: 1, hooks: PEG_HOOK };
export const PEG_POOL_ID: Hex = "0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035";
/** ETH/USDC 0.05%, the deepest v4 USDC pool. */
export const ETH_USDC_KEY: PoolKey = { currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE };
/** ETH/IMD 1%: the pool the price feeds read (DeploymentConfig IMD_POOL_ID). */
export const ETH_IMD_KEY: PoolKey = { currency0: NATIVE, currency1: IMD, fee: 10_000, tickSpacing: 200, hooks: NATIVE };

type PathKey = { intermediateCurrency: Address; fee: number; tickSpacing: number; hooks: Address; hookData: Hex };
const hop = (to: Address, k: PoolKey): PathKey => ({
  intermediateCurrency: to,
  fee: k.fee,
  tickSpacing: k.tickSpacing,
  hooks: k.hooks,
  hookData: "0x",
});
/** imdUSD -> USDC -> ETH -> IMD. */
export const UP_PATH: readonly PathKey[] = [hop(USDC, PEG_KEY), hop(NATIVE, ETH_USDC_KEY), hop(IMD, ETH_IMD_KEY)];
/** IMD -> ETH -> USDC -> imdUSD. */
export const DOWN_PATH: readonly PathKey[] = [hop(NATIVE, ETH_IMD_KEY), hop(USDC, ETH_USDC_KEY), hop(IMDUSD, PEG_KEY)];

const PATH_COMPONENTS = [
  { name: "intermediateCurrency", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
  { name: "hookData", type: "bytes" },
] as const;
const EXACT_IN_ABI = [
  {
    type: "tuple",
    components: [
      { name: "currencyIn", type: "address" },
      { name: "path", type: "tuple[]", components: PATH_COMPONENTS },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
    ],
  },
] as const;

export const QUOTER_PATH = parseAbi([
  // Not a view on chain (it reverts with its answer and catches it), but it is read with eth_call.
  "struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }",
  "struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }",
  "function quoteExactInput(QuoteExactParams params) view returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const STATE_VIEW = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
export const ERC20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
export const SHARE = parseAbi([
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

const U128 = (1n << 128n) - 1n;
/** The calldata pieces for an exact-input multi-pool swap: `execute(commands, inputs, deadline)`. One V4_SWAP
 * (0x10) with SWAP_EXACT_IN (0x07), SETTLE_ALL (0x0c) for what is paid, TAKE_ALL (0x0f) for what is received. */
export function encodePathSwap(args: {
  currencyIn: Address;
  path: readonly PathKey[];
  amountIn: bigint;
  minOut: bigint;
}): { commands: Hex; inputs: Hex[] } {
  const { currencyIn, path, amountIn, minOut } = args;
  if (amountIn <= 0n || amountIn > U128 || minOut > U128) throw Error("Amount does not fit uint128.");
  if (currencyIn === NATIVE) throw Error("The loop never pays in ETH.");
  const currencyOut = path[path.length - 1].intermediateCurrency;
  const actions = encodePacked(["uint8", "uint8", "uint8"], [0x07, 0x0c, 0x0f]);
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_ABI, [{ currencyIn, path: [...path], amountIn, amountOutMinimum: minOut }]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyIn, amountIn]),
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currencyOut, minOut]),
  ];
  return {
    commands: "0x10",
    inputs: [encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params])],
  };
}

// ---- The peg pool -----------------------------------------------------------------------------------------
/** USD per imdUSD (1e18-scaled) from sqrtPriceX96: imdUSD is currency0 (18 decimals), USDC currency1 (6). */
export const usdAtSqrt = (sqrt: bigint) => (sqrt * sqrt * 10n ** 30n) >> 192n;

/** The fee-free band's lower edge: a round never sells imdUSD below $0.9975. */
export const PEG_FLOOR_USD = 9975n * 10n ** 14n;
/** Its upper edge: a round down that buys imdUSD past $1.0025 pays the hook's surcharge, and is warned about. */
export const PEG_CEILING_USD = 10025n * 10n ** 14n;

/** What `amount` of imdUSD (or USDC) buys on the peg pool alone, from the V4 Quoter; undefined if the pool cannot fill it. */
export type PegQuote = (amount: bigint) => Promise<bigint | undefined>;
/**
 * The price the last imdUSD of a sale of `amount` gets (USD per imdUSD, 1e18): the quoted proceeds of a slice just
 * below `amount` subtracted from those of `amount`, over the slice. This is the pool's real depth, ticks, positions,
 * LP fee and hook surcharge included, which a constant-liquidity formula is not: most of the pool's liquidity can sit
 * in a narrow band at the current price, and a sale past it lands on far less.
 */
export async function pegMarginalSell(quote: PegQuote, amount: bigint): Promise<bigint | undefined> {
  const slice = amount / 100n > 10n ** 18n ? amount / 100n : 10n ** 18n;
  const lower = amount > slice ? amount - slice : 0n;
  const [a, b] = await Promise.all([quote(amount), lower > 0n ? quote(lower) : Promise.resolve(0n)]);
  if (a === undefined || b === undefined) return undefined;
  // USDC has 6 decimals: (a - b) * 1e12 is 1e18-scaled USDC; over the slice of imdUSD, 1e18-scaled USD per imdUSD.
  return a > b ? ((a - b) * 10n ** 12n * 10n ** 18n) / (amount - lower) : 0n;
}
/**
 * The most imdUSD one round may sell into the peg pool before its last unit sells under `floorUsd`. One grid of
 * amounts from 1 to `ceiling`, quoted together (the terminal's client bundles them into one Multicall3 eth_call),
 * brackets it; `steps` bisections inside the bracket refine it. Zero when even the first imdUSD sells under it.
 */
export async function pegSellCap(quote: PegQuote, floorUsd = PEG_FLOOR_USD, ceiling = 5_000n * 10n ** 18n, steps = 5): Promise<bigint> {
  const ok = async (x: bigint) => ((await pegMarginalSell(quote, x)) ?? 0n) >= floorUsd;
  // 1, 1.6, 2.5, ... imdUSD up to the ceiling: about 20 points, each about 1.6x the one before.
  const grid: bigint[] = [];
  for (let x = 10n ** 18n; x < ceiling; x = (x * 16n) / 10n) grid.push(x);
  grid.push(ceiling);
  const passes = await Promise.all(grid.map(ok));
  const last = passes.findIndex((p) => !p);
  if (last === 0) return 0n;
  if (last === -1) return ceiling;
  let lo = grid[last - 1];
  let hi = grid[last];
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2n;
    if (await ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
/**
 * The price the last imdUSD of a purchase paid for with `usdcIn` USDC costs (USD per imdUSD, 1e18), from quotes of
 * the peg pool's buy side (`pegQuoter(client, "buy")`), surcharge included.
 */
export async function pegMarginalBuy(quote: PegQuote, usdcIn: bigint): Promise<bigint | undefined> {
  const slice = usdcIn / 100n > 10n ** 6n ? usdcIn / 100n : 10n ** 6n;
  const lower = usdcIn > slice ? usdcIn - slice : 0n;
  const [a, b] = await Promise.all([quote(usdcIn), lower > 0n ? quote(lower) : Promise.resolve(0n)]);
  if (a === undefined || b === undefined || a <= b) return undefined;
  return ((usdcIn - lower) * 10n ** 12n * 10n ** 18n) / (a - b);
}
/** IMD -> ETH -> USDC: the first two hops of DOWN_PATH, to price what reaches the peg pool on a round down. */
export const DOWN_TO_USDC: readonly PathKey[] = [hop(NATIVE, ETH_IMD_KEY), hop(USDC, ETH_USDC_KEY)];
/** A PegQuote over a viem client: imdUSD in (`sell`) or USDC in (`buy`), through the Quoter's single-pool quote. */
export function pegQuoter(
  client: { readContract: (args: any) => Promise<any> },
  side: "sell" | "buy" = "sell",
): PegQuote {
  return (amount) =>
    client
      .readContract({
        address: UNISWAP.quoter,
        abi: QUOTER,
        functionName: "quoteExactInputSingle",
        args: [{ poolKey: PEG_KEY, zeroForOne: side === "sell", exactAmount: amount, hookData: "0x" }],
      })
      .then((r: readonly [bigint, bigint]) => r[0])
      // A revert means the pool cannot fill the amount; anything else (a timeout, a refused read) is not an answer
      // about the pool, and is thrown so the window says "could not be read" rather than "the peg is at its edge".
      .catch((e: any) => {
        if (e?.name === "ContractFunctionExecutionError" && e?.cause?.name === "ContractFunctionRevertedError") return undefined;
        throw e;
      });
}
export const PEG_POOL_CHECK = () => poolId(PEG_KEY) === PEG_POOL_ID;

// ---- Position arithmetic (mirrors math.ts: CR% = collateral * price / (debt * 1e16)) ----------------------
const CR = 10n ** 16n;
export const WAD = 10n ** 18n;
/** Whole-percent ratio, or undefined with no debt. `price` is USD per 1e18 raw collateral units. */
export const crOf = (collateral: bigint, debt: bigint, price: bigint) =>
  debt > 0n ? (collateral * price) / (debt * CR) : undefined;
/** Leverage (1e18-scaled) of a position at `cr` percent: cr / (cr - 100). Undefined at or under 100%. */
export const leverageAt = (cr: bigint | undefined) => (cr === undefined ? WAD : cr > 100n ? (cr * WAD) / (cr - 100n) : undefined);

/** Ratios the window offers as the round's stopping point. The first is the recommendation. */
export const RECOMMENDED_CR = 220n;
/** Under this the warning is stronger: a 10% fall in IMD takes the position near the minimum. */
export const CAUTION_CR = 190n;

export type UpRound = {
  borrow: bigint;
  imdOut: bigint;
  minImd: bigint;
  sharesIn: bigint;
  /** Ratio straight after the borrow, before the deposit: the vault requires it at or above minCR. */
  crBetween?: bigint;
  crAfter?: bigint;
  /** Value lost in the swap against the vault's own IMD price, in basis points (fees, price impact, surcharge). */
  costBps: bigint;
  pegAfter?: bigint;
};
/**
 * One round up, from a quote. `imdUsd` is the vault's USD per IMD (1e18), `price` its USD per 1e18 raw sIMD,
 * `rate` IMD raw per 1e18 raw sIMD; held/debt the position now.
 */
export function upRound(a: {
  borrow: bigint;
  imdOut: bigint;
  slippageBps: bigint;
  held: bigint;
  debt: bigint;
  price: bigint;
  imdUsd: bigint;
  rate: bigint;
  /** The marginal peg price at this sale (pegMarginalSell), when known. */
  pegAfter?: bigint;
}): UpRound {
  const minImd = (a.imdOut * (10_000n - a.slippageBps)) / 10_000n;
  // The deposit is the swap's guaranteed minimum, so it can never exceed what arrived; any surplus stays in the wallet.
  const sharesIn = a.rate > 0n ? (minImd * WAD) / a.rate : 0n;
  const debtAfter = a.debt + a.borrow;
  const valueOut = (a.imdOut * a.imdUsd) / WAD;
  const costBps = a.borrow > 0n && valueOut < a.borrow ? ((a.borrow - valueOut) * 10_000n) / a.borrow : 0n;
  return {
    borrow: a.borrow,
    imdOut: a.imdOut,
    minImd,
    sharesIn,
    crBetween: crOf(a.held, debtAfter, a.price),
    crAfter: crOf(a.held + sharesIn, debtAfter, a.price),
    costBps,
    pegAfter: a.pegAfter,
  };
}
/**
 * The largest borrow for one round up: no lower than `floorBetween` straight after the borrow (the vault checks the
 * ratio before the deposit lands), no lower than `target` once the deposit lands (estimated from `costBps`), no more
 * than the peg cap or the vault's ceiling room.
 */
export function maxUp(a: {
  held: bigint;
  debt: bigint;
  price: bigint;
  floorBetween: bigint;
  target: bigint;
  costBps: bigint;
  pegCap?: bigint;
  ceilingLeft?: bigint;
}): bigint {
  const value = (a.held * a.price) / WAD; // USD, 1e18
  const debt = a.debt;
  // Between: value / (debt + x) >= floor/100  ->  x <= value*100/floor - debt
  const between = (value * 100n) / a.floorBetween;
  let x = between > debt ? between - debt : 0n;
  // After: (value + x*(1-c)) / (debt + x) >= t/100  ->  x <= (100*value - t*debt) / (t - 100*(1-c))
  const keep = 10_000n - a.costBps; // bps of x that arrives as collateral value
  const num = 100n * value - a.target * debt;
  const den = a.target * 10_000n - 100n * keep; // scaled by 1e4
  const after = num <= 0n ? 0n : den <= 0n ? x : (num * 10_000n) / den;
  if (after < x) x = after;
  if (a.pegCap !== undefined && a.pegCap < x) x = a.pegCap;
  if (a.ceilingLeft !== undefined && a.ceilingLeft < x) x = a.ceilingLeft;
  return x;
}

export type DownRound = {
  withdraw: bigint;
  imdIn: bigint;
  imdusdOut: bigint;
  minImdusd: bigint;
  repay: bigint;
  crBetween?: bigint;
  crAfter?: bigint;
  costBps: bigint;
  pegAfter?: bigint;
};
/** One round down: withdraw `withdraw` sIMD worth `imdIn` IMD, sell it, repay with the guaranteed minimum (no more than the debt). */
export function downRound(a: {
  withdraw: bigint;
  imdIn: bigint;
  imdusdOut: bigint;
  slippageBps: bigint;
  held: bigint;
  debt: bigint;
  price: bigint;
  imdUsd: bigint;
  /** The marginal peg price this round's purchase pays (pegMarginalBuy), when known. */
  pegAfter?: bigint;
}): DownRound {
  const minImdusd = (a.imdusdOut * (10_000n - a.slippageBps)) / 10_000n;
  const repay = minImdusd < a.debt ? minImdusd : a.debt;
  const left = a.held > a.withdraw ? a.held - a.withdraw : 0n;
  const valueIn = (a.imdIn * a.imdUsd) / WAD;
  const costBps = valueIn > 0n && a.imdusdOut < valueIn ? ((valueIn - a.imdusdOut) * 10_000n) / valueIn : 0n;
  return {
    withdraw: a.withdraw,
    imdIn: a.imdIn,
    imdusdOut: a.imdusdOut,
    minImdusd,
    repay,
    crBetween: crOf(left, a.debt, a.price),
    crAfter: a.debt > repay ? crOf(left, a.debt - repay, a.price) : undefined,
    costBps,
    pegAfter: a.pegAfter,
  };
}
/**
 * The largest withdrawal for one round down: the ratio straight after it no lower than `floorBetween` (the vault's
 * `free` requires minCR before the repayment lands), and no more sIMD than it takes to clear the debt (with `costBps`
 * and 2% to spare).
 */
export function maxDown(a: { held: bigint; debt: bigint; price: bigint; floorBetween: bigint; costBps: bigint }): bigint {
  if (a.debt === 0n || a.price === 0n) return 0n;
  // Keep: held' * price / 1e18 >= debt * floor / 100
  const keep = (a.debt * a.floorBetween * WAD + 100n * a.price - 1n) / (100n * a.price);
  const byRatio = a.held > keep ? a.held - keep : 0n;
  // Enough to clear: shares worth debt / (1 - c) * 1.02
  const need = (a.debt * WAD * 10_000n * 102n) / (a.price * (10_000n - a.costBps) * 100n);
  return byRatio < need ? byRatio : need;
}

// ---- Planning to a target ---------------------------------------------------------------------------------
/** A target ratio (whole percent) for a leverage multiple (1e18-scaled): cr = 100·L / (L − 1). Undefined at 1× (no debt). */
export const crForLeverage = (l: bigint) => (l > WAD ? (100n * l + (l - WAD) - 1n) / (l - WAD) : undefined);
export type TargetPlan = {
  /** Rounds it takes, each limited by the ratio the vault checks between its two halves. */
  rounds: number;
  /** imdUSD borrowed (up) or repaid (down) over all rounds. */
  stable: bigint;
  /** Collateral value moved, USD 1e18: deposited (up) or withdrawn (down). */
  value: bigint;
  /** Position value and debt (USD 1e18) once done. */
  valueAfter: bigint;
  debtAfter: bigint;
  crAfter?: bigint;
};
const MAX_ROUNDS = 12;
const DUST = 10n ** 18n;
/**
 * Rounds from a position (collateral `value` and `debt`, USD 1e18) to `target` percent, each swap losing `costBps`
 * (negative: gaining). Up borrows; down withdraws and repays, to no debt when `target` is undefined. Every round keeps
 * the ratio between its halves at or over `floorBetween`, as the vault requires.
 */
export function planToTarget(a: {
  value: bigint;
  debt: bigint;
  target?: bigint;
  floorBetween: bigint;
  costBps: bigint;
  /** Plan at most this many rounds (1: the next round only). */
  limit?: number;
}): TargetPlan {
  let v = a.value;
  let d = a.debt;
  let stable = 0n;
  let moved = 0n;
  let rounds = 0;
  const keep = 10_000n - a.costBps; // bps of what is swapped that arrives
  const t = a.target;
  const up = t !== undefined && (d === 0n || v * 100n > t * d);
  for (; rounds < (a.limit ?? MAX_ROUNDS); rounds++) {
    if (up) {
      const between = (v * 100n) / a.floorBetween;
      let x = between > d ? between - d : 0n;
      const num = 100n * v - t! * d;
      // Never plan a gain on the way up: each round would compound it.
      const den = t! * 10_000n - 100n * (keep > 10_000n ? 10_000n : keep);
      const after = num <= 0n ? 0n : den <= 0n ? x : (num * 10_000n) / den;
      if (after < x) x = after;
      if (x < DUST) break;
      const arrives = (x * (keep > 10_000n ? 10_000n : keep)) / 10_000n;
      d += x;
      v += arrives;
      stable += x;
      moved += arrives;
    } else {
      if (d < DUST) break;
      const free = v * 100n > a.floorBetween * d ? v - (a.floorBetween * d) / 100n : 0n;
      // To no debt: enough to clear it with 2% to spare. To a ratio t: (v − w)/(d − w·k) = t/100.
      let w = (d * 10_000n * 102n) / (keep * 100n);
      if (t !== undefined) {
        const den = t * keep - 1_000_000n; // t·k − 100·1e4
        if (den > 0n && t * d > 100n * v) w = ((t * d - 100n * v) * 10_000n) / den;
        else if (t * d <= 100n * v) w = 0n;
      }
      if (w > free) w = free;
      if (w < DUST / 100n) break;
      const r0 = (w * keep) / 10_000n;
      const r = r0 < d ? r0 : d;
      v -= w;
      d -= r;
      stable += r;
      moved += w;
    }
  }
  return { rounds, stable, value: moved, valueAfter: v, debtAfter: d, crAfter: d > 0n ? (v * 100n) / d : undefined };
}
