// Preseason points with the liquidity reader switched at a block (user, 2026-10-16). PURE.
//
// Holding and liquidations count exactly as engine.ts always has. LIQUIDITY counts by the preseason reader
// (imdUSD deposited x lpBps, lp.ts) only BEFORE `switchBlock`; from `switchBlock` on it counts by Season 1's
// reader (season1.ts rules 2-4): depth inside the peg band, only while the pool price is in the band and in the
// position's range, vested after a one-day hold. Why: on 2026-10-16 ~48k borrowed imdUSD was parked in a range
// above a pushed-down price; "deposited x 3" paid it ~145k points a day for making the peg worse.
//
// The switch block is 26,206,625: where the preseason was first frozen on 2026-10-16, before it resumed with no gap.
import { computePoints, type PointEvent, type Season, type AccountPoints } from "./engine.ts";
import { computeSeason1, type S1Event } from "./season1.ts";

export type LpSwitch = {
  switchBlock: number;
  /** Peg pool events only (price / liquidity / owner), from pool.ts. */
  poolEvents: S1Event[];
  bandLower: number;
  bandUpper: number;
  token1Scale: bigint;
  vestBlocks?: number;
};

export type PreseasonAccount = AccountPoints & { lpPending: bigint };

export function computePreseason(events: PointEvent[], season: Season, sw: LpSwitch) {
  const X = sw.switchBlock;
  // Before X: everything as it was. At X every preseason liquidity balance drops to zero (logIndex -1 sorts it
  // first in its block); preseason lp events at or after X are dropped.
  const before = events.filter((e) => e.kind !== "lp" || e.block < X);
  const owners = new Set(events.filter((e) => e.kind === "lp" && e.block < X).map((e) => (e as { owner: string }).owner.toLowerCase()));
  for (const owner of owners) before.push({ kind: "lp", owner, value: 0n, block: X, logIndex: -1 });
  const pre = computePoints(before, season);

  // From X: Season 1's liquidity reader only (no transfers, so holding is not double counted).
  const lpOnly = sw.poolEvents.filter((e) => e.kind === "price" || e.kind === "liquidity" || e.kind === "owner");
  const s1 = X <= season.endBlock
    ? computeSeason1(lpOnly, {
        startBlock: X,
        endBlock: season.endBlock,
        blocksPerDay: season.blocksPerDay,
        bandLower: sw.bandLower,
        bandUpper: sw.bandUpper,
        token1Scale: sw.token1Scale,
        lpBps: season.lpBps,
        vestBlocks: sw.vestBlocks,
        excluded: season.excluded,
        closed: season.closed,
      })
    : null;

  const rows = new Map<string, PreseasonAccount>();
  for (const a of pre.accounts) rows.set(a.owner, { ...a, lpPending: 0n });
  for (const b of s1?.accounts ?? []) {
    const a = rows.get(b.owner) ?? { owner: b.owner, held: 0n, lp: 0n, holdPoints: 0n, lpPoints: 0n, liquidationPoints: 0n, points: 0n, ratePerBlock: 0n, lpPending: 0n };
    a.lpPoints += b.lpPoints;
    a.points += b.lpPoints;
    a.lpPending = b.lpPending;
    a.ratePerBlock += b.ratePerBlock; // season1 rows here carry only the liquidity rate (no transfers fed in)
    rows.set(b.owner, a);
  }
  const accounts = [...rows.values()].filter((a) => a.points !== 0n || a.ratePerBlock !== 0n || a.lpPending !== 0n);
  accounts.sort((x, y) => (y.points > x.points ? 1 : y.points < x.points ? -1 : x.owner.localeCompare(y.owner)));
  let total = 0n;
  let totalRatePerBlock = 0n;
  for (const a of accounts) (total += a.points), (totalRatePerBlock += a.ratePerBlock);
  return { ...pre, total, totalRatePerBlock, accounts, atPeg: s1?.atPeg ?? null, tick: s1?.tick ?? null };
}
