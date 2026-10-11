import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amount,
  payout,
  address,
  message,
  WAD,
  ratio,
  liquidationPrice,
  cushion,
  requiredCollateral,
  maxDebt,
  ratioPercent,
  BORROW_BUFFER,
  CR_SCALE,
  nextStep,
} from "../src/math.ts";
import { maxUint256 } from "viem";
test("amount input rejects lossy, signed, exponent, zero and out of range values", () => {
  for (const input of [
    "0",
    "-1",
    "1e2",
    "NaN",
    "1.0000000000000000001",
    (maxUint256 + 1n).toString(),
  ])
    assert.throws(() => amount(input));
  assert.equal(amount(" 12.345 "), 12345n * 10n ** 15n);
  assert.equal(amount("0", 18, true), 0n);
});
test("reserve first, position only, mixed payout and debt rounding", () => {
  const reserve = payout(100n * WAD, 50n, 2n * WAD, 100n * WAD);
  assert.equal(reserve.out, 4975n * 10n ** 16n);
  assert.equal(reserve.source, "Reserve");
  assert.equal(reserve.debtCancelled, 0n);
  const mixed = payout(100n * WAD, 50n, 2n * WAD, 10n * WAD);
  assert.equal(mixed.source, "Reserve + position");
  assert.equal(mixed.reserveOut, 10n * WAD);
  assert.equal(mixed.positionOut, 3975n * 10n ** 16n);
  assert.equal(
    mixed.debtCancelled,
    100n * WAD - (10n * WAD * 2n * WAD) / (9950n * 10n ** 14n),
  );
  assert.equal(payout(100n * WAD, 500n, 2n * WAD, 0n).source, "Position");
});
test("fee increase lowers output, supply-independent quote conservation over varied sizes", () => {
  for (let i = 1n; i <= 200n; i++) {
    const n = i * WAD + 17n,
      price = ((i % 13n) + 1n) * WAD + 7n,
      reserve = (i % 7n) * WAD;
    const low = payout(n, 50n, price, reserve),
      high = payout(n, 500n, price, reserve);
    assert.ok(low.out >= high.out);
    assert.equal(low.out, low.reserveOut + low.positionOut);
    assert.ok(low.reserveOut <= reserve);
    assert.ok(low.out * price <= n * 9950n * 10n ** 14n);
    assert.ok(low.debtCancelled >= 0n && low.debtCancelled <= n);
  }
  assert.throws(() => payout(1n, 500n, 100n * WAD, 0n));
  assert.throws(() => payout(WAD, 50n, 0n, 0n));
});
test("address normalization, debt-free label and actionable custom errors", () => {
  assert.throws(() => address("alice.eth"));
  assert.equal(
    address(" 0x0000000000000000000000000000000000000001 "),
    "0x0000000000000000000000000000000000000001",
  );
  assert.equal(ratio(maxUint256), "Debt-free");
  assert.match(message({ code: 4001 }), /rejected/);
  assert.match(
    message({ cause: { data: { errorName: "RedemptionWorsensRatio" } } }),
    /collateral ratio would fall/,
  );
  // Retired when the payout cap replaced the halt; it must not be explained as current behaviour.
  assert.doesNotMatch(
    message({ cause: { data: { errorName: "RedemptionWorsensBacking" } } }),
    /reduce backing/,
  );
});
test("redemption pays the lesser of par and backing per COMP, as the vault does", () => {
  const par = payout(100n * WAD, 50n, 2n * WAD, 0n);
  const atPar = payout(100n * WAD, 50n, 2n * WAD, 0n, 2n * WAD);
  assert.equal(atPar.out, par.out); // backing above par never pays a premium
  assert.equal(atPar.capped, false);
  const capped = payout(100n * WAD, 50n, 2n * WAD, 0n, 8n * 10n ** 17n);
  assert.equal(capped.capped, true);
  // payoutScale = mulDiv(0.8e18, 9950, 10000); out = mulDiv(100e18, scale, 2e18)
  const scale = (8n * 10n ** 17n * 9950n) / 10000n;
  assert.equal(capped.out, (100n * WAD * scale) / (2n * WAD));
  assert.ok(capped.out < par.out);
  const mixed = payout(100n * WAD, 50n, 2n * WAD, 10n * WAD, 8n * 10n ** 17n);
  assert.equal(
    mixed.debtCancelled,
    100n * WAD - (10n * WAD * 2n * WAD) / scale,
  );
});
test("position arithmetic agrees with the vault's ratio check", () => {
  const price = 10n * WAD; // $10 per IMD
  const collateral = 300n * WAD,
    debt = 1000n * WAD,
    minCR = 150n;
  // CR = 300 * 10 / 1000 = 300%
  assert.equal((collateral * price) / (debt * CR_SCALE), 300n);
  const liq = liquidationPrice(collateral, debt, minCR);
  assert.equal(liq, 5n * WAD); // halves to $5 before minCR
  assert.equal(cushion(price, liq), "50% above it");
  assert.equal(requiredCollateral(debt, minCR, price), 150n * WAD);
  assert.equal(maxDebt(collateral, minCR, price), 2000n * WAD);
  assert.equal(liquidationPrice(collateral, 0n, minCR), undefined);
  assert.equal(cushion(4n * WAD, liq), "25% below it");
});
test("the keeper's Act button names the next step for the position's state", () => {
  const at = (cr, mark) =>
    nextStep({ cr, mark }, 150n, 10_000n, 3_600n, "keeper.eth");
  assert.equal(at(180n, [0n, 0n, false]), "View actions →");
  assert.equal(at(140n, [0n, 0n, false]), "Mark keeper.eth →");
  assert.equal(at(140n, [10_000n, 8_040n, true]), "Grace 2h 14m · View →");
  assert.equal(at(140n, [1_000n, 6_000n, true]), "Liquidate keeper.eth →");
  assert.equal(at(140n, [0n, 1_000n, true]), "Mark keeper.eth again →");
  assert.equal(at(160n, [1_000n, 6_000n, true]), "View actions →");
});

test("ratioPercent matches the vault, and the offered borrow stays BORROW_BUFFER above mat", () => {
  // Live mainnet, block 26166985: 0x72cF…EF78, which the vault's collateralRatio() read as 223.
  const collateral = 16727031346025263568135964n;
  const debt = 464803677577311193648n;
  const price = 61972783490591n; // collateralPriceFeed: USD per 1e18 raw sIMD
  assert.equal(ratioPercent(collateral, debt, price), 223n);
  assert.equal(ratioPercent(collateral, 0n, price), undefined);
  const mat = 170n;
  const offered = maxDebt(collateral, mat + BORROW_BUFFER, price);
  assert.ok(ratioPercent(collateral, offered, price) >= mat + BORROW_BUFFER);
  assert.ok(offered < maxDebt(collateral, mat, price));
});
