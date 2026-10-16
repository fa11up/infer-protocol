// node --test points/season1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSeason1, type S1Event, type S1Season } from "./season1.ts";
import { sqrtPriceAtTick, amount1Between } from "./tickmath.ts";
import { display, WAD } from "./engine.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3"; // a contract (pool, vault, hook)
const DAY = 7_200;
const PEG = -276324; // $1.0000 (USDC per imdUSD, imdUSD = token0 at 18 dec, USDC = token1 at 6 dec)
const LO = -276424; // $0.99005
const HI = -276224; // $1.01005
const DUMPED = -277388; // $0.8991, where the pool sat after the 2026-10-16 push
const L = 10n ** 17n; // liquidity units

let n = 0;
const tx = (from: string, to: string, whole: number, block: number): S1Event => ({ kind: "transfer", from, to, value: BigInt(whole) * WAD, block, logIndex: n++ });
const debt = (owner: string, whole: number, block: number): S1Event => ({ kind: "debt", owner, value: BigInt(whole) * WAD, block, logIndex: n++ });
const price = (tick: number, block: number): S1Event => ({ kind: "price", tick, block, logIndex: n++ });
const liq = (id: string, lower: number, upper: number, delta: bigint, block: number): S1Event => ({ kind: "liquidity", id, tickLower: lower, tickUpper: upper, delta, block, logIndex: n++ });
const owner = (id: string, who: string, block: number): S1Event => ({ kind: "owner", id, owner: who, block, logIndex: n++ });
const season = (endBlock: number, extra: Partial<S1Season> = {}): S1Season => ({
  startBlock: 0, endBlock, blocksPerDay: DAY, bandLower: LO, bandUpper: HI, token1Scale: 10n ** 12n, ...extra,
});
const row = (r: ReturnType<typeof computeSeason1>, who: string) => r.accounts.find((a) => a.owner === who);
const pts = (r: ReturnType<typeof computeSeason1>, who: string) => display(row(r, who)?.points ?? 0n, DAY);
/** imdUSD-equivalent depth of L inside the whole band. */
const bandDepth = (l: bigint) => amount1Between(l, LO, HI) * 10n ** 12n;

test("TickMath port matches Uniswap's known values", () => {
  assert.equal(sqrtPriceAtTick(0), 79228162514264337593543950336n);
  assert.equal(sqrtPriceAtTick(-887272), 4295128739n);
  assert.equal(sqrtPriceAtTick(887272), 1461446703485210103287273052203988822378723970342n);
});

test("rule 1: a wallet earns 1x for holding; a contract earns nothing", () => {
  const r = computeSeason1([tx(ZERO, A, 100, 0), tx(ZERO, C, 100, 0)], season(DAY, { excluded: [C] }));
  assert.equal(pts(r, A), "100.00");
  assert.equal(row(r, C), undefined);
});

test("rule 5 is off by default: a borrower earns on what it holds", () => {
  const r = computeSeason1([tx(ZERO, A, 100, 0), debt(A, 60, 0)], season(DAY));
  assert.equal(pts(r, A), "100.00");
});

test("rule 5 (netDebt): holding counts net of the wallet's own vault debt", () => {
  const r = computeSeason1([tx(ZERO, A, 100, 0), debt(A, 60, 0), tx(ZERO, B, 100, 0), debt(B, 150, 0)], season(DAY, { netDebt: true }));
  assert.equal(pts(r, A), "40.00");
  assert.equal(pts(r, B), "0.00");
});

test("rule 5 (netDebt): repaying debt restores the holding from that block", () => {
  const r = computeSeason1([tx(ZERO, A, 100, 0), debt(A, 100, 0), debt(A, 0, DAY)], season(2 * DAY, { netDebt: true }));
  assert.equal(pts(r, A), "100.00");
});

test("rule 2: liquidity at the peg earns 3x its depth inside the band", () => {
  const evs = [price(PEG, 0), liq("p1", LO, HI, L, 0), owner("p1", A, 0)];
  const r = computeSeason1(evs, season(2 * DAY));
  // depth x 3 per block for 2 days; the first day has vested by the data's last block (2 days)
  assert.equal(row(r, A)!.points, (bandDepth(L) * 3n * BigInt(2 * DAY)));
});

test("rule 2: a wide range earns only for its slice of the band", () => {
  const wide = computeSeason1([price(PEG, 0), liq("w", DUMPED - 100, -275837, L, 0), owner("w", A, 0)], season(2 * DAY));
  const tight = computeSeason1([price(PEG, 0), liq("t", LO, HI, L, 0), owner("t", A, 0)], season(2 * DAY));
  assert.equal(wide.total, tight.total, "same L, same depth inside the band");
});

test("rule 2: a range entirely outside the band earns nothing, even when the price is in it", () => {
  const r = computeSeason1([price(-276124, 0), liq("p", -276200, -275837, L, 0), owner("p", A, 0)], season(2 * DAY));
  assert.equal(r.total, 0n);
});

test("rule 3: nobody's liquidity earns while the price is off the peg", () => {
  const r = computeSeason1(
    [price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", A, 0), price(DUMPED, DAY), price(PEG, 2 * DAY)],
    season(3 * DAY),
  );
  assert.equal(row(r, A)!.points, bandDepth(L) * 3n * BigInt(2 * DAY), "day 1 and day 3 only");
});

test("rule 3: liquidity in the band but not at the current price is not active and earns nothing", () => {
  const r = computeSeason1([price(PEG - 50, 0), liq("p", PEG, HI, L, 0), owner("p", A, 0)], season(2 * DAY));
  assert.equal(r.total, 0n);
});

test("the 2026-10-16 pattern: push the peg to $0.899, park borrowed imdUSD in $0.89-$1.05: earns nothing", () => {
  const evs = [
    price(PEG, 0),
    price(DUMPED, 100), // the push
    tx(ZERO, A, 52_000, 200), // borrowed
    debt(A, 52_000, 200),
    tx(A, C, 48_471, 300), // into the pool (C = PoolManager, excluded)
    liq("ab", -277490, -275837, 50n * L, 300),
    owner("ab", A, 300),
  ];
  const r = computeSeason1(evs, season(5 * DAY, { excluded: [C] }));
  assert.equal(r.atPeg, false);
  // The parked liquidity earns nothing. With rule 5 off, the 3,529 borrowed imdUSD left in the wallet earns 1x as
  // a holding, as any borrower's would; with rule 5 on, nothing at all.
  assert.equal(row(r, A)!.lpPoints, 0n);
  assert.equal(row(r, A)!.holdPoints, 52_000n * WAD * 100n + 3_529n * WAD * BigInt(5 * DAY - 300));
  assert.equal(computeSeason1(evs, season(5 * DAY, { excluded: [C], netDebt: true })).total, 0n);
});

test("...and if the peg is restored, that position earns only on its slice of the band", () => {
  const evs = [price(DUMPED, 0), liq("ab", -277490, -275837, 50n * L, 0), owner("ab", A, 0), price(PEG, DAY)];
  const r = computeSeason1(evs, season(3 * DAY));
  assert.equal(row(r, A)!.points, bandDepth(50n * L) * 3n * BigInt(2 * DAY));
});

test("rule 4: removing inside a day of adding forfeits what was pending", () => {
  const r = computeSeason1([price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", A, 0), liq("p", LO, HI, -L, DAY / 2)], season(2 * DAY));
  assert.equal(r.total, 0n);
});

test("rule 4: after a day, points vest and a later removal keeps them", () => {
  const r = computeSeason1([price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", A, 0), liq("p", LO, HI, -L, 2 * DAY)], season(3 * DAY));
  assert.equal(row(r, A)!.points, bandDepth(L) * 3n * BigInt(2 * DAY));
});

test("rule 4: pending that the data cannot vest yet is reported, not counted", () => {
  const r = computeSeason1([price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", A, 0)], season(10 * DAY, { dataThroughBlock: DAY / 2 }));
  assert.equal(row(r, A)!.points, 0n);
  assert.equal(row(r, A)!.lpPending, bandDepth(L) * 3n * BigInt(DAY / 2));
});

test("rule 4: adding more restarts the window for what is pending", () => {
  const evs = [price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", A, 0), liq("p", LO, HI, L, DAY - 1), liq("p", LO, HI, -L, DAY + 10)];
  const r = computeSeason1(evs, season(3 * DAY));
  // everything accrued before the removal at DAY+10 was still pending (window restarted at DAY-1) and is lost;
  // afterwards L remains and vests from DAY+10's pending only once a day passes from the last ADD (DAY-1)
  const after = bandDepth(L) * 3n * BigInt(3 * DAY - (DAY + 10));
  assert.equal(row(r, A)!.points, after);
});

test("a position's points follow its NFT to a new owner", () => {
  const evs = [price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", A, 0), owner("p", B, 2 * DAY)];
  const r = computeSeason1(evs, season(4 * DAY));
  assert.equal(row(r, A)!.points, bandDepth(L) * 3n * BigInt(2 * DAY));
  assert.equal(row(r, B)!.points, bandDepth(L) * 3n * BigInt(2 * DAY));
});

test("a position owned by an excluded contract earns nothing", () => {
  const r = computeSeason1([price(PEG, 0), liq("p", LO, HI, L, 0), owner("p", C, 0)], season(2 * DAY, { excluded: [C] }));
  assert.equal(r.total, 0n);
});

test("a missing liquidity log is refused", () => {
  assert.throws(() => computeSeason1([liq("p", LO, HI, -L, 0)], season(DAY)), /missing/);
});
