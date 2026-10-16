// node --test points/engine.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePoints, display, WAD, type PointEvent, type Season } from "./engine.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const L = "0x00000000000000000000000000000000000000c3";
const VAULT = "0x00000000000000000000000000000000000000d4";
const DAY = 7_200;
let n = 0;
const tx = (from: string, to: string, whole: number, block: number): PointEvent => ({ kind: "transfer", from, to, value: BigInt(whole) * WAD, block, logIndex: n++ });
const lp = (owner: string, whole: number, block: number): PointEvent => ({ kind: "lp", owner, value: BigInt(whole) * WAD, block, logIndex: n++ });
const bite = (liquidator: string, whole: number, block: number): PointEvent => ({ kind: "bite", liquidator, debtRepaid: BigInt(whole) * WAD, block, logIndex: n++ });
const season = (endBlock: number, extra: Partial<Season> = {}): Season => ({ startBlock: 0, endBlock, blocksPerDay: DAY, ...extra });
const pts = (r: ReturnType<typeof computePoints>, who: string) => display(r.accounts.find((a) => a.owner === who)?.points ?? 0n, DAY);

test("1 imdUSD held for 1 day is 1 point", () => {
  const r = computePoints([tx(ZERO, A, 100, 0)], season(2 * DAY));
  assert.equal(pts(r, A), "200.00");
});

test("a buyer earns from the block it buys; the seller keeps what it earned and stops", () => {
  const r = computePoints([tx(ZERO, A, 100, 0), tx(A, B, 100, DAY)], season(3 * DAY));
  assert.equal(pts(r, A), "100.00");
  assert.equal(pts(r, B), "200.00");
});

test("liquidity earns 3x by default; the multiplier is configurable", () => {
  const r = computePoints([lp(A, 100, 0)], season(DAY));
  assert.equal(pts(r, A), "300.00");
  const r2 = computePoints([lp(A, 100, 0)], season(DAY, { lpBps: 50_000 }));
  assert.equal(pts(r2, A), "500.00");
});

test("moving from wallet to pool switches the rate at that block", () => {
  // Hold 100 for a day, then the 100 goes into the pool (out of the wallet, into LP value).
  const r = computePoints([tx(ZERO, A, 100, 0), tx(A, VAULT, 100, DAY), lp(A, 100, DAY)], season(2 * DAY, { excluded: [VAULT] }));
  assert.equal(pts(r, A), "400.00"); // 100 x 1 day x 1 + 100 x 1 day x 3
});

test("splitting across wallets earns exactly the same", () => {
  const one = computePoints([tx(ZERO, A, 100, 0)], season(10 * DAY));
  const split = computePoints([tx(ZERO, A, 50, 0), tx(ZERO, B, 50, 0)], season(10 * DAY));
  assert.equal(one.total, split.total);
});

test("a flash hold inside one block earns nothing", () => {
  const r = computePoints([tx(ZERO, A, 1_000_000, 5), tx(A, ZERO, 1_000_000, 5)], season(DAY));
  assert.equal(pts(r, A), "0.00");
});

test("excluded contracts (vault, treasury, pool manager) earn nothing", () => {
  const r = computePoints([tx(ZERO, VAULT, 100, 0)], season(DAY, { excluded: [VAULT] }));
  assert.equal(r.total, 0n);
});

test("liquidators earn debt repaid x 3 days, inside the season only", () => {
  const r = computePoints([bite(L, 40, 10), bite(L, 10, 20 * DAY)], season(10 * DAY));
  assert.equal(pts(r, L), "120.00");
});

test("only blocks inside the season earn, but earlier transfers still set the balance", () => {
  const r = computePoints([tx(ZERO, A, 100, 0)], { startBlock: 2 * DAY, endBlock: 3 * DAY, blocksPerDay: DAY });
  assert.equal(pts(r, A), "100.00");
});

test("a missing log is refused rather than turned into wrong points", () => {
  assert.throws(() => computePoints([tx(A, B, 1, 1)], season(DAY)), /incomplete/);
});

test("the current rate is reported for live counters", () => {
  const r = computePoints([tx(ZERO, A, 100, 0), lp(B, 10, 0)], season(DAY));
  const a = r.accounts.find((x) => x.owner === A)!;
  assert.equal(a.ratePerBlock, 100n * WAD);
  assert.equal(r.totalRatePerBlock, 130n * WAD);
});

test("event order does not matter; chain order is restored", () => {
  const evs = [tx(ZERO, A, 100, 0), tx(A, B, 40, DAY)];
  assert.equal(computePoints(evs, season(2 * DAY)).total, computePoints([...evs].reverse(), season(2 * DAY)).total);
});

test("a closed season keeps every total as of its end and reports no rate", () => {
  // A holds 100 through the season and keeps holding after it; B buys after the end; a liquidation after the end.
  const evs: PointEvent[] = [
    tx(ZERO, A, 100, 0),
    tx(ZERO, B, 50, 2 * DAY),
    { kind: "bite", liquidator: B, debtRepaid: 10n * WAD, block: 2 * DAY, logIndex: 1 },
  ];
  const open = computePoints(evs.slice(0, 1), season(DAY));
  const closed = computePoints(evs, { ...season(DAY), closed: true });
  assert.equal(pts(closed, A), pts(open, A));
  assert.equal(closed.accounts.find((x) => x.owner === B), undefined, "nothing after the end counts");
  assert.equal(closed.totalRatePerBlock, 0n);
  assert.ok(closed.accounts.every((x) => x.ratePerBlock === 0n));
});
