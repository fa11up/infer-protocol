// The leverage window's round sizing, offline: the limits it promises hold for the sizes it suggests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crOf, downRound, leverageAt, maxDown, maxUp, pegSellCap, upRound } from "../src/leverage.ts";

const E18 = 10n ** 18n;
// 100 IMD of sIMD (24 decimals, 1 sIMD = 10 IMD), IMD at $10: $1,000 of collateral.
const RATE = 10n ** 13n; // IMD raw per 1e18 raw sIMD: 1 sIMD (1e24 raw) = 10 IMD (1e19 raw)
const HELD = 10n * 10n ** 24n;
const PRICE = (10n * E18 * RATE) / E18; // USD per 1e18 raw sIMD (1e14: $100 per sIMD)
const IMD_USD = 10n * E18;

test("maxUp keeps the ratio between the halves at the floor and the round at its target", () => {
  for (const [debt, target] of [[0n, 220n], [200n * E18, 220n], [0n, 180n], [300n * E18, 200n]]) {
    const x = maxUp({ held: HELD, debt, price: PRICE, floorBetween: 180n, target, costBps: 200n });
    if (x === 0n) continue;
    const imdOut = (x * 9800n) / 10_000n / 10n; // 2% lost, at $10
    const r = upRound({ borrow: x, imdOut, slippageBps: 0n, held: HELD, debt, price: PRICE, imdUsd: IMD_USD, rate: RATE });
    assert.ok(r.crBetween >= 179n, `between ${r.crBetween}`);
    assert.ok(r.crAfter >= target - 1n, `after ${r.crAfter} for target ${target}`);
    assert.equal(r.costBps, 200n);
  }
});

test("maxUp respects the peg cap and the ceiling", () => {
  const free = maxUp({ held: HELD, debt: 0n, price: PRICE, floorBetween: 180n, target: 220n, costBps: 0n });
  assert.equal(maxUp({ held: HELD, debt: 0n, price: PRICE, floorBetween: 180n, target: 220n, costBps: 0n, pegCap: 10n * E18 }), 10n * E18);
  assert.equal(maxUp({ held: HELD, debt: 0n, price: PRICE, floorBetween: 180n, target: 220n, costBps: 0n, ceilingLeft: 0n }), 0n);
  assert.ok(free > 500n * E18 && free <= 556n * E18, `${free}`); // $1,000 / 1.8
});

test("maxDown never takes the ratio under the floor before the repayment", () => {
  const debt = 500n * E18;
  const w = maxDown({ held: HELD, debt, price: PRICE, floorBetween: 180n, costBps: 500n });
  assert.ok(w > 0n);
  assert.ok(crOf(HELD - w, debt, PRICE) >= 180n);
  const r = downRound({ withdraw: w, imdIn: (w * RATE) / E18, imdusdOut: 0n, slippageBps: 0n, held: HELD, debt, price: PRICE, imdUsd: IMD_USD });
  assert.equal(r.repay, 0n);
});

test("leverage from a ratio", () => {
  assert.equal(leverageAt(undefined), E18);
  assert.equal(leverageAt(200n), 2n * E18);
  assert.equal(leverageAt(100n), undefined);
});

test("the peg cap stops where the last imdUSD sells under the floor", async () => {
  // A pool paying $1.0084 for the first 250 imdUSD and $0.95 after.
  const quote = async (x) => {
    const edge = 250n * E18;
    const usdc = x <= edge ? (x * 10084n) / 10_000n : (edge * 10084n) / 10_000n + ((x - edge) * 9500n) / 10_000n;
    return usdc / 10n ** 12n;
  };
  const cap = await pegSellCap(quote);
  assert.ok(cap > 240n * E18 && cap <= 252n * E18, `${cap}`);
  assert.equal(await pegSellCap(async (x) => (x * 9900n) / 10_000n / 10n ** 12n), 0n);
});
