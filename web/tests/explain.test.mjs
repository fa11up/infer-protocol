import { test } from "node:test";
import assert from "node:assert/strict";
import { explain, failure } from "../src/explain.ts";
import { setUnit } from "../src/unit.ts";
const WAD = 10n ** 18n;
const s = {
  block: 1n,
  timestamp: 100000n,
  feeds: {
    USD: { value: 10n * WAD, updated: 99990n, stale: false, maxAge: 300n },
    // Plain-IMD collateral: the collateral price is the IMD/USD price.
    Collateral: { value: 10n * WAD, updated: 99990n, stale: false, maxAge: 300n },
    PriceFeed: { value: 1000n, updated: 10000n, stale: true, maxAge: 86400n },
    SpotFeed: { value: 1100n, updated: 99990n, stale: false, maxAge: 3600n },
  },
  v: {
    positions: [300n * WAD, 1000n * WAD],
    debtOf: 1000n * WAD,
    mat: 150n,
    skew: 500n,
    totalDebt: 900n * WAD,
    line: 1000n * WAD,
  },
};
const ctx = (fn, args) => ({ fn, args, s });
test("a refused borrow names the collateral it needs and what is held", () => {
  const text = explain(
    { name: "UnsafeCollateralRatio", args: [] },
    ctx("draw", [1500n * WAD]),
  );
  assert.match(text, /needs 375 IMD/);
  assert.match(text, /holds 300 IMD/);
  assert.match(text, /borrow now is Ɨ\u00a01,000\./);
});
test("a refused withdrawal names the floor and the withdrawable amount", () => {
  const text = explain(
    { name: "UnsafeCollateralRatio", args: [] },
    ctx("free", [200n * WAD]),
  );
  assert.match(text, /at least 150 IMD/);
  assert.match(text, /withdraw now is 150 IMD/);
});
test("ceiling, divergence and staleness carry their figures", () => {
  assert.match(
    explain(
      { name: "DebtCeilingReached", args: [] },
      ctx("draw", [200n * WAD]),
    ),
    /Room left: Ɨ\u00a0100\./,
  );
  assert.match(
    explain({ name: "PriceDivergence", args: [] }, ctx("draw", [1n])),
    /disagree by 10%; the vault allows 5%/,
  );
  assert.match(
    explain({ name: "StaleFeed", args: [] }, ctx("draw", [1n])),
    /primary last updated 25h 0m ago against a 86400s limit/,
  );
});
test("unknown reverts fall through to the dictionary", () => {
  assert.equal(
    explain({ name: "Unauthorized", args: [] }, ctx("draw", [1n])),
    undefined,
  );
  assert.deepEqual(
    failure({ cause: { data: { errorName: "X", args: [1n] } } }),
    { name: "X", args: [1n] },
  );
});
test("figures carry the unit the deployed token reports", () => {
  setUnit("COMP");
  assert.match(
    explain({ name: "DebtCeilingReached", args: [] }, ctx("draw", [200n * WAD])),
    /Room left: 100 COMP/,
  );
  setUnit("imdUSD");
  setUnit("<b>bad</b>"); // not a symbol: ignored
  assert.match(
    explain({ name: "DebtCeilingReached", args: [] }, ctx("draw", [200n * WAD])),
    /Room left: Ɨ\u00a0100\./,
  );
});
