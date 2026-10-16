// Liquidity in the imdUSD/USDC peg pool, from the viewer's wallet: the arithmetic and the PositionManager calldata.
// Pure, no DOM, so Node can run it against a mainnet fork (tests/lp.fork.test.mjs) and the LP window imports the same.
//
// Every position covers the band the first deposit used (infer-token script/AddPegLiquidity.s.sol): 488 ticks either
// side of the hook's $1 peg tick, $0.9524-$1.05. One band keeps every deposit's liquidity where the peg needs it.
// Add:    MINT_POSITION + SETTLE_PAIR, the tokens pulled through Permit2 (token -> Permit2 -> PositionManager).
// Remove: DECREASE_LIQUIDITY (or BURN_POSITION for all of it) + TAKE_PAIR; collecting fees is a decrease of zero.
import { encodeAbiParameters, encodePacked, parseAbi, type Address, type Hex } from "viem";
import { PEG_KEY, PEG_POOL_ID, IMDUSD, USDC } from "./leverage.ts";

export const POSITION_MANAGER: Address = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
/** The hook's pegSqrtPriceX96 ($1) lies in this tick; the first position (#451683) is PEG_TICK ± 488. */
export const PEG_TICK = -276325;
export const BAND_TICKS = 488;
export const TICK_LOWER = PEG_TICK - BAND_TICKS;
export const TICK_UPPER = PEG_TICK + BAND_TICKS;
/** Amounts may move this far from the quote between review and inclusion. */
export const LP_SLIPPAGE_BPS = 50n;

export const POSITION_MANAGER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)",
  "function ownerOf(uint256 id) view returns (address)",
  "function nextTokenId() view returns (uint256)",
]);
export const STATE_VIEW_LP = parseAbi([
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
]);

// ---- TickMath (v4-core), exact ------------------------------------------------------------------------------
const MAX_TICK = 887272;
const Q32 = 1n << 32n;
export const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const U256 = 1n << 256n;
const MAGIC: readonly [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];
export function sqrtAtTick(tick: number): bigint {
  const abs = Math.abs(tick);
  if (!Number.isInteger(tick) || abs > MAX_TICK) throw Error("Tick out of range.");
  let price = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, m] of MAGIC) if (abs & bit) price = (price * m) >> 128n;
  if (tick > 0) price = (U256 - 1n) / price;
  return (price >> 32n) + (price % Q32 === 0n ? 0n : 1n);
}

// ---- LiquidityAmounts (v4-periphery) -------------------------------------------------------------------------
const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;
/** Liquidity `amount0` buys between two sqrt prices (imdUSD is currency0). */
function liquidity0(a: bigint, b: bigint, amount0: bigint) {
  return mulDiv(amount0, mulDiv(a, b, Q96), b - a);
}
function liquidity1(a: bigint, b: bigint, amount1: bigint) {
  return mulDiv(amount1, Q96, b - a);
}
/** The most liquidity both amounts allow at `sqrtP` over [sqrtA, sqrtB]. */
export function liquidityForAmounts(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, amount0: bigint, amount1: bigint) {
  if (sqrtP <= sqrtA) return liquidity0(sqrtA, sqrtB, amount0);
  if (sqrtP >= sqrtB) return liquidity1(sqrtA, sqrtB, amount1);
  const l0 = liquidity0(sqrtP, sqrtB, amount0);
  const l1 = liquidity1(sqrtA, sqrtP, amount1);
  return l0 < l1 ? l0 : l1;
}
/** What `liquidity` holds at `sqrtP`. `up` rounds as the pool does when it is paid (a mint), else as when it pays. */
export function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint, up = false) {
  const f = up ? mulDivUp : mulDiv;
  const a0 = (lo: bigint, hi: bigint) => {
    const n = f(liquidity << 96n, hi - lo, hi);
    return up ? (n + lo - 1n) / lo : n / lo;
  };
  const a1 = (lo: bigint, hi: bigint) => f(liquidity, hi - lo, Q96);
  if (sqrtP <= sqrtA) return { amount0: a0(sqrtA, sqrtB), amount1: 0n };
  if (sqrtP >= sqrtB) return { amount0: 0n, amount1: a1(sqrtA, sqrtB) };
  return { amount0: a0(sqrtP, sqrtB), amount1: a1(sqrtA, sqrtP) };
}

export const BAND = () => ({ sqrtA: sqrtAtTick(TICK_LOWER), sqrtB: sqrtAtTick(TICK_UPPER) });

export type AddPlan = {
  liquidity: bigint;
  /** What the mint takes at the current price. */
  imdusd: bigint;
  usdc: bigint;
  /** The most it may take (LP_SLIPPAGE_BPS over), which Permit2 is approved for. */
  imdusdMax: bigint;
  usdcMax: bigint;
};
/**
 * A deposit sized from one side: the typed `side` amount, and the other side the band needs at the current price.
 * With imdUSD under $0.9524 (below the band) only imdUSD is taken, over $1.05 only USDC; a typed amount of the side
 * not taken gives nothing.
 */
export function planAdd(sqrtP: bigint, side: "imdusd" | "usdc", typed: bigint): AddPlan | undefined {
  const { sqrtA, sqrtB } = BAND();
  if (typed <= 0n) return undefined;
  const big = (1n << 255n) - 1n;
  const liquidity =
    side === "imdusd" ? liquidityForAmounts(sqrtP, sqrtA, sqrtB, typed, big) : liquidityForAmounts(sqrtP, sqrtA, sqrtB, big, typed);
  if (liquidity <= 0n || liquidity >= Q128) return undefined;
  const { amount0, amount1 } = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity, true);
  const over = (x: bigint) => (x * (10_000n + LP_SLIPPAGE_BPS) + 9_999n) / 10_000n;
  return { liquidity, imdusd: amount0, usdc: amount1, imdusdMax: over(amount0), usdcMax: over(amount1) };
}
/** The biggest deposit two balances allow: the mint's maximums (slippage included) fit inside both. */
export function planMax(sqrtP: bigint, imdusdBalance: bigint, usdcBalance: bigint): AddPlan | undefined {
  const under = (x: bigint) => (x * 10_000n) / (10_000n + LP_SLIPPAGE_BPS);
  const { sqrtA, sqrtB } = BAND();
  const liquidity = liquidityForAmounts(sqrtP, sqrtA, sqrtB, under(imdusdBalance), under(usdcBalance));
  if (liquidity <= 0n) return undefined;
  const { amount0, amount1 } = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity, true);
  const over = (x: bigint) => (x * (10_000n + LP_SLIPPAGE_BPS) + 9_999n) / 10_000n;
  return { liquidity, imdusd: amount0, usdc: amount1, imdusdMax: over(amount0), usdcMax: over(amount1) };
}

// ---- PositionManager calldata -------------------------------------------------------------------------------
const MINT_POSITION = 0x02;
const DECREASE_LIQUIDITY = 0x01;
const BURN_POSITION = 0x03;
const SETTLE_PAIR = 0x0d;
const TAKE_PAIR = 0x11;
const U128 = Q128 - 1n;
const KEY_ABI = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;
const unlock = (actions: number[], params: Hex[]): Hex =>
  encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [encodePacked(actions.map(() => "uint8"), actions), params],
  );
const pair = encodeAbiParameters([{ type: "address" }, { type: "address" }], [IMDUSD, USDC]);

/** `modifyLiquidities` data for a new position over the band, owned by `owner`. */
export function encodeMint(plan: AddPlan, owner: Address): Hex {
  if (plan.imdusdMax > U128 || plan.usdcMax > U128) throw Error("Amount does not fit uint128.");
  const mint = encodeAbiParameters(
    [KEY_ABI, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [{ ...PEG_KEY }, TICK_LOWER, TICK_UPPER, plan.liquidity, plan.imdusdMax, plan.usdcMax, owner, "0x"],
  );
  return unlock([MINT_POSITION, SETTLE_PAIR], [mint, pair]);
}
/**
 * `modifyLiquidities` data taking `liquidity` out of position `id` (with its fees) to `to`. All of it burns the
 * position; zero only collects the fees. Mins are what the position holds now, LP_SLIPPAGE_BPS under.
 */
export function encodeRemove(args: {
  id: bigint;
  liquidity: bigint;
  all: boolean;
  min0: bigint;
  min1: bigint;
  to: Address;
}): Hex {
  const { id, liquidity, all, to } = args;
  const under = (x: bigint) => (x * (10_000n - LP_SLIPPAGE_BPS)) / 10_000n;
  const min0 = under(args.min0);
  const min1 = under(args.min1);
  const take = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [IMDUSD, USDC, to]);
  if (all) {
    const burn = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      [id, min0, min1, "0x"],
    );
    return unlock([BURN_POSITION, TAKE_PAIR], [burn, take]);
  }
  const decrease = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [id, liquidity, min0, min1, "0x"],
  );
  return unlock([DECREASE_LIQUIDITY, TAKE_PAIR], [decrease, take]);
}

// ---- Reading positions --------------------------------------------------------------------------------------
/** PositionInfo packs poolId (top 25 bytes) | tickUpper | tickLower | hasSubscriber (low byte). */
export function decodeInfo(info: bigint) {
  const s24 = (v: bigint) => Number(v >= 1n << 23n ? v - (1n << 24n) : v);
  return {
    poolIdPrefix: `0x${(info >> 56n).toString(16).padStart(50, "0")}`,
    tickLower: s24((info >> 8n) & 0xffffffn),
    tickUpper: s24((info >> 32n) & 0xffffffn),
  };
}
export const inPegPool = (info: bigint) => decodeInfo(info).poolIdPrefix === PEG_POOL_ID.slice(0, 52).toLowerCase();
/** Fees a position has earned and not collected: (growth inside now - at last touch) x liquidity, mod 2^256. */
export function feesOwed(liquidity: bigint, inside: readonly [bigint, bigint], last: readonly [bigint, bigint]) {
  const owed = (now: bigint, then: bigint) => (((now - then) % U256) + U256) % U256 * liquidity / Q128;
  return { imdusd: owed(inside[0], last[0]), usdc: owed(inside[1], last[1]) };
}
/** PositionManager stores each position under salt = bytes32(tokenId). */
export const saltOf = (id: bigint): Hex => `0x${id.toString(16).padStart(64, "0")}`;
