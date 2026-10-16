// node --test points/preseason.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePoints, display, WAD, type PointEvent, type Season } from "./engine.ts";
import { computePreseason } from "./preseason.ts";
import type { S1Event } from "./season1.ts";
import { amount1Between } from "./tickmath.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const PM = "0x00000000000000000000000000000000000000ee";
const DAY = 7_200;
const LO = -276424, HI = -276224, PEG = -276324, DUMPED = -277388;
const L = 10n ** 17n;
let n = 0;
const tx = (from: string, to: string, whole: number, block: number): PointEvent => ({ kind: "transfer", from, to, value: BigInt(whole) * WAD, block, logIndex: n++ });
const lp = (owner: string, whole: number, block: number): PointEvent => ({ kind: "lp", owner, value: BigInt(whole) * WAD, block, logIndex: n++ });
const price = (tick: number, block: number): S1Event => ({ kind: "price", tick, block, logIndex: n++ });
const liq = (id: string, lo: number, hi: number, delta: bigint, block: number): S1Event => ({ kind: "liquidity", id, tickLower: lo, tickUpper: hi, delta, block, logIndex: n++ });
const own = (id: string, who: string, block: number): S1Event => ({ kind: "owner", id, owner: who, block, logIndex: n++ });
const season = (end: number): Season => ({ startBlock: 0, endBlock: end, blocksPerDay: DAY, excluded: [PM] });
const sw = (X: number, poolEvents: S1Event[]) => ({ switchBlock: X, poolEvents, bandLower: LO, bandUpper: HI, token1Scale: 10n ** 12n });
const row = (r: { accounts: { owner: string; points: bigint }[] }, who: string) => r.accounts.find((a) => a.owner === who);

test("before the switch, everything is exactly the preseason engine", () => {
  const evs = [tx(ZERO, A, 100, 0), tx(A, PM, 100, DAY), lp(A, 100, DAY)];
  const plain = computePoints(evs, season(2 * DAY));
  const hybrid = computePreseason(evs, season(2 * DAY), sw(2 * DAY, []));
  assert.equal(row(hybrid, A)!.points, row(plain, A)!.points);
});

test("from the switch, deposited imdUSD stops earning; only depth at the peg does", () => {
  // A deposited 48k off-peg before the switch: earns 3x on deposits until X, nothing after while off peg.
  const evs = [tx(ZERO, A, 48_000, 0), tx(A, PM, 48_000, 0), lp(A, 48_000, 0)];
  const pool = [price(DUMPED, 0), liq("ab", -277490, -275837, 50n * L, 0), own("ab", A, 0)];
  const r = computePreseason(evs, season(5 * DAY), sw(DAY, pool));
  assert.equal(display(row(r, A)!.points, DAY), "144000.00", "one day at 48k x 3, then nothing");
  assert.equal(row(r, A)!.ratePerBlock, 0n);
});

test("holding keeps counting across the switch, untouched", () => {
  const r = computePreseason([tx(ZERO, B, 100, 0)], season(3 * DAY), sw(DAY, []));
  assert.equal(display(row(r, B)!.points, DAY), "300.00");
});

test("after the switch, real depth at the peg earns and vests", () => {
  const pool = [price(PEG, 0), liq("p", LO, HI, L, DAY), own("p", B, DAY)];
  const r = computePreseason([], season(4 * DAY), sw(DAY, pool));
  const depth = amount1Between(L, LO, HI) * 10n ** 12n;
  assert.equal(row(r, B)!.points, depth * 3n * BigInt(3 * DAY));
});
