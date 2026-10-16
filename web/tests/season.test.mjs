// The Points pane's Season 1 helpers (src/season.ts): phases from the SeasonVault's dates, and the INFER estimate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseAt, infer } from "../src/season-math.ts";

test("phases: preseason until opened, scheduled until the start, live for the season, ended after", () => {
  const start = 1_792_432_800, end = start + 7_862_400;
  assert.equal(phaseAt(start - 10, false), "preseason");
  assert.equal(phaseAt(start - 10, true, start, end), "scheduled");
  assert.equal(phaseAt(start, true, start, end), "live", "the start is inclusive");
  assert.equal(phaseAt(end - 1, true, start, end), "live");
  assert.equal(phaseAt(end, true, start, end), "ended", "the end is exclusive");
});

test("the estimate is the share of the pot by points, rounded down (rules section 4)", () => {
  const pot = 93_000_000n * 10n ** 18n;
  // Half the Season 1 points: half of 95% of the pot.
  assert.equal(infer(50n, 100n, pot, 9_500), 44_175_000n * 10n ** 18n);
  // The preseason share: 5%.
  assert.equal(infer(1n, 1n, pot, 500), 4_650_000n * 10n ** 18n);
  assert.equal(infer(0n, 100n, pot, 9_500), 0n);
  assert.equal(infer(5n, 0n, pot, 9_500), 0n, "no points anywhere: nothing");
  assert.equal(infer(1n, 3n, 10n, 10_000), 3n, "rounded down");
});
