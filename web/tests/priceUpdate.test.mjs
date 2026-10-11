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
