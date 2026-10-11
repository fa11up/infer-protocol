import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseUpdate, stepsTo, pct, dollars } from "../src/priceUpdate.ts";
const WAD = 10n ** 18n;
const feed = (value, stale = false) => ({ value, updated: stale ? 1000n : 9000n, stale, maxAge: 3600n });
const base = {
  now: 10000n,
  price: feed(4n * 10n ** 15n),
  spot: feed(4n * 10n ** 15n),
  nhi: feed(9n * 10n ** 17n),
  usd: feed(10n * WAD),
  capBps: 2000n,
  staleMultiple: 2n,
  mat: 170n,
  cost: WAD / 2n,
  unit: "imdUSD",
};

test("in line with the market and fresh: nothing to buy", () => {
  const a = adviseUpdate({ ...base, market: { imdEth: 4n * 10n ** 15n, imdUsd: 10n * WAD } });
  assert.deepEqual(a.buy, []);
  assert.equal(a.health, false);
  assert.match(a.lines[0], /in line with the market/);
});

test("stale: says price actions are paused, an update reopens them, and buys price and spot", () => {
  const a = adviseUpdate({
    ...base,
    price: feed(4n * 10n ** 15n, true),
    spot: feed(4n * 10n ** 15n, true),
    market: { imdEth: 4n * 10n ** 15n, imdUsd: 10n * WAD },
  });
  assert.match(a.lines[0], /paused/);
  assert.match(a.lines[0], /reopens them for 1 hour/);
  assert.deepEqual(a.buy, ["PriceFeed", "SpotFeed"]);
  assert.match(a.lines.at(-1), /two answers in one transaction/);
  assert.match(a.lines.at(-1), /1 IMD \(about \$10\.00\)/);
});

test("market above: the borrower's ratio and borrowing room rise, in plain numbers", () => {
  const a = adviseUpdate({
    ...base,
    market: { imdEth: 44n * 10n ** 14n, imdUsd: 11n * WAD }, // +10%
    position: { cr: 200n, debt: 1000n * WAD, maxDebt: 1176n * WAD },
  });
  assert.match(a.lines[0], /10% above/);
  assert.match(a.lines[1], /from 200% to 220%/);
  assert.match(a.lines[1], /borrow up to 293\.6 imdUSD \(176 today\)/);
  assert.equal(a.warning, false);
  assert.deepEqual(a.buy, ["PriceFeed", "SpotFeed"]);
});

test("market below: warns when the update would put the position under the minimum", () => {
  const a = adviseUpdate({
    ...base,
    market: { imdEth: 36n * 10n ** 14n, imdUsd: 9n * WAD }, // -10%
    position: { cr: 180n, debt: 1000n * WAD, maxDebt: 1058n * WAD },
  });
  assert.match(a.lines[0], /10% below/);
  assert.match(a.lines[1], /from 180% to 162%/);
  assert.match(a.lines[2], /below the 170% minimum/);
  assert.equal(a.warning, true);
  assert.ok(a.lines.some((l) => /Treasury pays/.test(l)));
});

test("a move bigger than one update can carry says how many it takes", () => {
  const a = adviseUpdate({
    ...base,
    price: feed(4n * 10n ** 15n, true),
    spot: feed(4n * 10n ** 15n, true),
    market: { imdEth: 8n * 10n ** 15n, imdUsd: 20n * WAD }, // +100%
  });
  assert.ok(a.lines.some((l) => /at most 40%, then 20%\), so it takes 3 updates/.test(l)));
});

test("unreadable market still offers the stale update", () => {
  const a = adviseUpdate({ ...base, price: feed(1n, true), spot: feed(1n, true) });
  assert.match(a.lines.join(" "), /could not be read/);
  assert.deepEqual(a.buy, ["PriceFeed", "SpotFeed"]);
});

test("only the spot behind: offers the spot alone, and says why actions are paused", () => {
  const inLine = { imdEth: 4n * 10n ** 15n, imdUsd: 10n * WAD };
  const stale = adviseUpdate({ ...base, spot: feed(4n * 10n ** 15n, true), market: inLine });
  assert.deepEqual(stale.buy, ["SpotFeed"]);
  assert.match(stale.lines[0], /spot check is out of date/);
  assert.match(stale.lines.at(-1), /Only the spot check needs updating: 0\.5 IMD/);
  const breached = adviseUpdate({ ...base, spot: feed(43n * 10n ** 14n), skewBps: 500n, market: inLine });
  assert.deepEqual(breached.buy, ["SpotFeed"]);
  assert.match(breached.lines[0], /is 7\.5% off the primary \(5% allowed\)/);
});

test("only what is needed: the primary alone when the spot already agrees with the market", () => {
  // The launch-night rally: primary behind, spot fresh and at the market, vault paused on the gap.
  const a = adviseUpdate({
    ...base,
    price: feed(3146n * 10n ** 12n),
    spot: feed(3346n * 10n ** 12n),
    skewBps: 500n,
    market: { imdEth: 3360n * 10n ** 12n, imdUsd: 84n * WAD / 10n },
  });
  assert.deepEqual(a.buy, ["PriceFeed"]);
  assert.match(a.lines[0], /primary is the one behind the market/);
  assert.match(a.lines.at(-1), /Only the primary needs updating .*0\.5 IMD/);
});

test("the spot joins the primary when it is far from the market or would expire long before it", () => {
  const market = { imdEth: 44n * 10n ** 14n, imdUsd: 11n * WAD };
  const far = adviseUpdate({ ...base, skewBps: 500n, market });
  assert.deepEqual(far.buy, ["PriceFeed", "SpotFeed"]);
  const old = { value: 44n * 10n ** 14n, updated: 10000n - 3000n, stale: false, maxAge: 3600n }; // 10 minutes left
  const ageing = adviseUpdate({ ...base, spot: old, skewBps: 500n, market });
  assert.deepEqual(ageing.buy, ["PriceFeed", "SpotFeed"]);
  const young = adviseUpdate({ ...base, spot: feed(44n * 10n ** 14n), skewBps: 500n, market });
  assert.deepEqual(young.buy, ["PriceFeed"]);
});

test("after a fast move: holds the purchase while the two-hour median would still breach, and says how long", () => {
  // Live at 07:03Z on launch day: primary 3.176e15, spot 3.382e15, market 3.442e15, the window's 13 samples.
  const samples = [3131930148117727n, 3124863421768617n, 3144194454130257n, 3146616819404886n, 3146819993308866n, 3202801260795796n, 3162021725278561n, 3214285841209328n, 3230466764168853n, 3320138776540740n, 3359470635798236n, 3360906314931220n, 3440845137599674n];
  const a = adviseUpdate({
    ...base,
    price: feed(3176230146409988n),
    spot: feed(3381643414674661n),
    usd: feed(8n * WAD),
    skewBps: 500n,
    market: { imdEth: 3441947689663575n, imdUsd: 86n * WAD / 10n },
    projected: { median: 3202801260795796n, samples, spacingBlocks: 50n },
  });
  assert.ok(a.wait, "a purchase now is held");
  assert.match(a.wait, /Not yet/);
  assert.match(a.wait, /about 30 minutes/);
  assert.equal(a.waitShort, "Wait about 30 minutes");
  assert.match(a.wait, /land at about \$8\.\d\d, still/);
  assert.equal(a.lines[0], a.wait);
  assert.ok(!a.lines.some((l) => /from your wallet/.test(l)), "no price quoted for a held purchase");
});

test("primary behind and its median not moving yet: the spot alone is held as well", () => {
  // Live at 07:15Z: the median (3.1799e15) is within 0.5% of the primary, so only the breached spot was offered.
  const flat = Array(13).fill(3179891121836197n);
  const a = adviseUpdate({
    ...base,
    price: feed(3176230146409988n),
    spot: feed(3381643414674661n),
    skewBps: 500n,
    market: { imdEth: 3408494784660689n, imdUsd: 85n * WAD / 10n },
    projected: { median: 3179891121836197n, samples: flat, spacingBlocks: 50n },
  });
  assert.deepEqual(a.buy, ["SpotFeed"]);
  assert.match(a.wait ?? "", /A fresh spot check would land at the market/);
});

test("once the median has caught up, the same rally buys the primary alone", () => {
  const caught = 3330000000000000n;
  const a = adviseUpdate({
    ...base,
    price: feed(3176230146409988n),
    spot: feed(3381643414674661n),
    skewBps: 500n,
    market: { imdEth: 3441947689663575n, imdUsd: 86n * WAD / 10n },
    projected: { median: caught, samples: Array(13).fill(caught), spacingBlocks: 50n },
  });
  assert.equal(a.wait, undefined);
  assert.deepEqual(a.buy, ["PriceFeed"]);
});

test("fresh and off the market but the median has not moved: nothing to buy", () => {
  const a = adviseUpdate({
    ...base,
    skewBps: 500n,
    market: { imdEth: 41n * 10n ** 14n, imdUsd: 10n * WAD },
    projected: { median: 4001n * 10n ** 12n, samples: [], spacingBlocks: 50n },
  });
  assert.deepEqual(a.buy, []);
});

test("impact: the viewer's own sentence, only when an update is worth buying, at the median it would land at", () => {
  const market = { imdEth: 44n * 10n ** 14n, imdUsd: 11n * WAD }; // +10%
  const position = { cr: 200n, debt: 1000n * WAD, maxDebt: 1176n * WAD };
  const a = adviseUpdate({ ...base, market, position });
  assert.match(a.impact ?? "", /^Your collateral ratio would go from 200% to 220%, and you could borrow up to 293\.6 imdUSD \(176 today\)\.$/);
  // The window's median is only 5% up: the sentence uses it, not the market.
  const b = adviseUpdate({ ...base, spot: feed(42n * 10n ** 14n), market, position, skewBps: 500n, projected: { median: 42n * 10n ** 14n, samples: [], spacingBlocks: 50n } });
  assert.match(b.impact ?? "", /from 200% to 210%/);
  // No position: the equivalent for everyone.
  const c = adviseUpdate({ ...base, market });
  assert.equal(c.impact, "After an update, collateral counts for 10% more.");
  // In line with the market: nothing worth buying, no sentence.
  const d = adviseUpdate({ ...base, market: { imdEth: 4n * 10n ** 15n, imdUsd: 10n * WAD }, position });
  assert.equal(d.impact, undefined);
});

test("network health is a separate daily update, never folded into the price", () => {
  const a = adviseUpdate({ ...base, nhi: feed(9n * 10n ** 17n, true), market: { imdEth: 4n * 10n ** 15n, imdUsd: 10n * WAD } });
  assert.deepEqual(a.buy, []);
  assert.equal(a.health, true);
  assert.ok(a.lines.some((l) => /separate update, once a day/.test(l)));
});

test("helpers", () => {
  assert.equal(stepsTo(2n * WAD, 2000n, 4000n), 3); // 1.4, 1.68, 2.016
  assert.equal(stepsTo(WAD / 2n, 2000n, 4000n), 2); // 0.6, 0.48
  assert.equal(pct(1050n), "10.5%");
  assert.equal(dollars(1234567n * 10n ** 16n), "$12,345.67");
});
