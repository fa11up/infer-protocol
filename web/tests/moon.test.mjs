import test from "node:test";
import assert from "node:assert/strict";
import { MOON_CYCLE, blocksToTime, moonState } from "../src/infer/moon.ts";

// MXXN's stored window on 2026-10-13 (moonConfig), read from mainnet.
const START = 23_638_478n,
  END = 23_641_358n;

test("a clock 15 moons behind heads for the next full moon and needs 14 burns (the redemption moves the last)", () => {
  const m = moonState(START, END, 26_185_462n);
  assert.equal(m.behind, 15n);
  assert.equal(m.start, 26_187_278n); // the next window PLAN.md worked out on 2026-10-06
  assert.equal(m.end, 26_190_158n);
  assert.equal(m.open, false);
  assert.equal(m.redeemable, false);
  assert.equal(m.needed, 14n);
});

test("inside the full moon, one moon behind is redeemable: the redemption's own transfer moves the clock", () => {
  const m = moonState(START + 14n * MOON_CYCLE, END + 14n * MOON_CYCLE, 26_188_000n);
  assert.equal(m.behind, 1n);
  assert.equal(m.open, true);
  assert.equal(m.redeemable, true);
  assert.equal(m.needed, 0n);
});

test("on time: open inside the window, waiting before it, and the window's last block still counts", () => {
  const s = 26_187_278n,
    e = 26_190_158n;
  assert.deepEqual([moonState(s, e, s - 1n).open, moonState(s, e, s - 1n).behind], [false, 0n]);
  assert.equal(moonState(s, e, s).redeemable, true);
  assert.equal(moonState(s, e, e).redeemable, true);
  // One block past the end the clock is one behind again, heading for next month's moon.
  const after = moonState(s, e, e + 1n);
  assert.deepEqual([after.behind, after.start, after.open, after.needed], [1n, s + MOON_CYCLE, false, 0n]);
});

test("countdowns read in days, hours or minutes", () => {
  assert.equal(blocksToTime(1_816n), "6 h 3 m");
  assert.equal(blocksToTime(MOON_CYCLE), "23 d 14 h");
  assert.equal(blocksToTime(10n), "2 m");
  assert.equal(blocksToTime(1n), "1 m");
  assert.equal(blocksToTime(0n), "0 m");
});

test("with fuel the redeemer moves the clock in one call, capped by its fuel; without, the visitor burns 1 wei", async () => {
  const { advanceWith } = await import("../src/infer/moon.ts");
  assert.deepEqual(advanceWith(15n, 100n), { via: "redeemer", steps: 15n });
  assert.deepEqual(advanceWith(15n, 4n), { via: "redeemer", steps: 4n });
  assert.deepEqual(advanceWith(15n, 0n), { via: "wallet" });
});
