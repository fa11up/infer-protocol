// The LP window's arithmetic and calldata, offline: TickMath against v4-core's known values, the band against the
// first peg position (#451683) as read from chain, and the mint/remove calldata decoded back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters } from "viem";
import {
  BAND_TICKS,
  PEG_TICK,
  TICK_LOWER,
  TICK_UPPER,
  Q96,
  amountsForLiquidity,
  BAND,
  decodeInfo,
  encodeMint,
  encodeRemove,
  feesOwed,
  inPegPool,
  liquidityForAmounts,
  planAdd,
  planMax,
  sqrtAtTick,
} from "../src/lp.ts";

test("sqrtAtTick matches v4-core at the ends and the middle", () => {
  assert.equal(sqrtAtTick(0), Q96);
  assert.equal(sqrtAtTick(-887272), 4295128739n);
  assert.equal(sqrtAtTick(887272), 1461446703485210103287273052203988822378723970342n);
});

test("the hook's $1 peg lies in PEG_TICK, and the band is the first position's", () => {
  // PegFeeHook.pegSqrtPriceX96() and PositionManager.positionInfo(451683), read 2026-10-16.
  const peg = 79228162514264337593543n;
  assert.ok(sqrtAtTick(PEG_TICK) <= peg && peg < sqrtAtTick(PEG_TICK + 1));
  const info = 27465282940604210083899370778864238590779597844563993535828496453627372024576n;
  assert.deepEqual(
    { lower: decodeInfo(info).tickLower, upper: decodeInfo(info).tickUpper },
    { lower: TICK_LOWER, upper: TICK_UPPER },
  );
  assert.equal(TICK_UPPER - TICK_LOWER, 2 * BAND_TICKS);
  assert.ok(inPegPool(info));
  assert.ok(!inPegPool(info ^ (1n << 255n)));
});

test("a deposit sized from either side takes what the other side's liquidity needs", () => {
  const { sqrtA, sqrtB } = BAND();
  const sqrtP = 79286811246372521971401n; // the pool at ~$1.0015, 2026-10-16
  const a = planAdd(sqrtP, "imdusd", 100n * 10n ** 18n);
  assert.ok(a && a.imdusd <= 100n * 10n ** 18n + 1n && a.imdusd >= 100n * 10n ** 18n - 10n ** 6n);
  // Slightly above $1: more than half the value is USDC.
  assert.ok(a.usdc > 100n * 10n ** 6n);
  const b = planAdd(sqrtP, "usdc", a.usdc);
  assert.ok(b && (b.liquidity - a.liquidity) ** 2n <= (a.liquidity / 10n ** 6n) ** 2n);
  // Maximums are 0.5% over.
  assert.equal(a.imdusdMax, (a.imdusd * 10_050n + 9_999n) / 10_000n);
  // imdUSD under the band: the position is all imdUSD, and USDC typed alone gives nothing.
  assert.equal(planAdd(sqrtA - 1n, "usdc", 10n ** 6n), undefined);
  const below = planAdd(sqrtA - 1n, "imdusd", 10n ** 18n);
  assert.ok(below && below.usdc === 0n && below.imdusd > 0n);
  // Over it, all USDC.
  assert.equal(planAdd(sqrtB + 1n, "imdusd", 10n ** 18n), undefined);
  const above = planAdd(sqrtB + 1n, "usdc", 10n ** 6n);
  assert.ok(above && above.imdusd === 0n && above.usdc > 0n);
});

test("Max fits the maximums inside both balances", () => {
  const sqrtP = 79286811246372521971401n;
  const m = planMax(sqrtP, 50n * 10n ** 18n, 1_000n * 10n ** 6n);
  assert.ok(m && m.imdusdMax <= 50n * 10n ** 18n && m.usdcMax <= 1_000n * 10n ** 6n);
  const n = planMax(sqrtP, 1_000n * 10n ** 18n, 20n * 10n ** 6n);
  assert.ok(n && n.usdcMax <= 20n * 10n ** 6n);
});

test("liquidity and amounts invert (rounded in the pool's favour)", () => {
  const { sqrtA, sqrtB } = BAND();
  const sqrtP = sqrtAtTick(PEG_TICK);
  const L = liquidityForAmounts(sqrtP, sqrtA, sqrtB, 10n ** 21n, 10n ** 9n);
  const up = amountsForLiquidity(sqrtP, sqrtA, sqrtB, L, true);
  const down = amountsForLiquidity(sqrtP, sqrtA, sqrtB, L, false);
  assert.ok(up.amount0 <= 10n ** 21n + 1n && up.amount1 <= 10n ** 9n + 1n);
  assert.ok(up.amount0 >= down.amount0 && up.amount1 >= down.amount1);
});

test("mint and remove calldata decode to the intended actions", () => {
  const owner = "0x5167D014a056E43883e1BBEa5530c3c0dC993281";
  const plan = planAdd(sqrtAtTick(PEG_TICK), "imdusd", 10n ** 18n);
  const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], encodeMint(plan, owner));
  assert.equal(actions, "0x020d");
  assert.equal(params.length, 2);
  const [rm] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], encodeRemove({ id: 7n, liquidity: 5n, all: false, min0: 10_000n, min1: 10_000n, to: owner }));
  assert.equal(rm, "0x0111");
  const [burn, bp] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], encodeRemove({ id: 7n, liquidity: 5n, all: true, min0: 10_000n, min1: 10_000n, to: owner }));
  assert.equal(burn, "0x0311");
  const [id, min0, min1] = decodeAbiParameters([{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], bp[0]);
  assert.deepEqual([id, min0, min1], [7n, 9_950n, 9_950n]);
});

test("fees owed wrap like the pool's unchecked growth counters", () => {
  const Q128 = 1n << 128n;
  const U256 = 1n << 256n;
  assert.deepEqual(feesOwed(Q128, [5n, 7n], [2n, 7n]), { imdusd: 3n, usdc: 0n });
  // The counter wrapped past 2^256 since the last touch.
  assert.deepEqual(feesOwed(Q128, [1n, 0n], [U256 - 1n, 0n]), { imdusd: 2n, usdc: 0n });
});
