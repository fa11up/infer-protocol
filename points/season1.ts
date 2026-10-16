// Season 1 points. PURE: events in, points out; no network and no clock. Erasable TypeScript only (see engine.ts).
//
// The preseason engine (engine.ts) is left exactly as it was, so the frozen preseason totals keep reproducing.
// Season 1 changes the rules because of what happened on 2026-10-16 (block ~26206000): the pool was pushed to
// $0.899, then ~48k BORROWED imdUSD was parked in a range above the price. Under "imdUSD deposited x 3" that one
// position would have taken ~77% of all points while making the peg worse. The rules below (user, 2026-10-16):
//
// 1. HOLDING (1x) counts only for wallets: EOAs and EIP-7702 accounts, plus any explicitly allowed contract.
//    Pools, vaults, other hooks and every other contract earn nothing (the CLI classifies by code at a pinned
//    block and passes them in `excluded`). imdUSD in any pool other than ours earns nothing.
// 2. LIQUIDITY counts only in OUR hook pool, and only as DEPTH AT THE PEG: a position earns on the token1 value
//    of its liquidity inside the peg band (by default $0.99-$1.01), L * (sqrt(min(upper, bandHi)) -
//    sqrt(max(lower, bandLo))). That is what it costs to push the price through that position inside the band.
//    A wide range earns only for its slice of the band; a range outside the band earns nothing.
// 3. ACTIVE ONLY, AND ONLY AT PEG: a position accrues only while the pool's price is inside the band AND inside
//    the position's own range. Push the peg away and nobody's liquidity earns, the pusher's included.
// 4. MINIMUM HOLD: liquidity points accrue as PENDING for `vestBlocks` (one day) after a position's last addition.
//    Removing any of it inside that window forfeits everything pending; after it, pending vests. Pending that
//    cannot vest yet (the window runs past the data) is reported but not counted.
// 5. NET OF DEBT (OFF; user, 2026-10-16: "reward our earliest supporters, not rug them"). With `netDebt` a wallet's
//    holding would count as max(0, imdUSD held - its own vault principal). Kept as an option, off by default: the
//    liquidity rules (2-4) are what stop the 2026-10-16 pattern, and borrowers who hold what they mint keep earning.
//
// Liquidators keep the flat credit (debt repaid x 3 days), as in the preseason.

import { WAD } from "./engine.ts";

const byChainOrder = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) => a.block - b.block || a.logIndex - b.logIndex;
import { amount1Between } from "./tickmath.ts";

export type S1Transfer = { kind: "transfer"; from: string; to: string; value: bigint; block: number; logIndex: number };
export type S1Bite = { kind: "bite"; liquidator: string; debtRepaid: bigint; block: number; logIndex: number };
/** A wallet's vault principal outstanding from this point on (absolute). */
export type S1Debt = { kind: "debt"; owner: string; value: bigint; block: number; logIndex: number };
/** The pool's current tick from this point on (Initialize or Swap). */
export type S1Price = { kind: "price"; tick: number; block: number; logIndex: number };
/** A position's liquidity changed by `delta` (ModifyLiquidity). `id` is stable per position. */
export type S1Liquidity = { kind: "liquidity"; id: string; tickLower: number; tickUpper: number; delta: bigint; block: number; logIndex: number };
/** Who a position's points go to from this point on (its owner, or the NFT holder for PositionManager positions). */
export type S1Owner = { kind: "owner"; id: string; owner: string; block: number; logIndex: number };
export type S1Event = S1Transfer | S1Bite | S1Debt | S1Price | S1Liquidity | S1Owner;

export type S1Season = {
  startBlock: number;
  endBlock: number;
  blocksPerDay: number;
  /** Peg band in ticks: [bandLower, bandUpper). */
  bandLower: number;
  bandUpper: number;
  /** token1 raw -> imdUSD-equivalent 1e18 units (USDC: 10^12). */
  token1Scale: bigint;
  holdBps?: number;
  lpBps?: number;
  liquidationCreditDays?: number;
  vestBlocks?: number;
  /** Rule 5, off by default: count holdings net of the wallet's own vault principal. */
  netDebt?: boolean;
  /** The last block the events cover (accrual stops there; vesting needs to see a day past an addition). Defaults to endBlock. */
  dataThroughBlock?: number;
  /** Addresses that earn nothing: the vault, Treasury, PoolManager, and every non-wallet contract. */
  excluded?: string[];
  closed?: boolean;
};

export const S1_DEFAULTS = { holdBps: 10_000, lpBps: 30_000, liquidationCreditDays: 3 };

export type S1Account = {
  owner: string;
  held: bigint;
  debt: bigint;
  holdPoints: bigint;
  lpPoints: bigint;
  lpPending: bigint;
  liquidationPoints: bigint;
  points: bigint;
  ratePerBlock: bigint;
};

type Wallet = { held: bigint; debt: bigint; since: number; holdPoints: bigint; lpPoints: bigint; liquidationPoints: bigint };
type Pending = { owner: string; raw: bigint };
type Position = {
  id: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  owner: string;
  lastAdd: number;
  pending: Pending[];
  depth: bigint; // imdUSD-equivalent depth inside the band, 1e18 units (constant while liquidity is)
};

export function computeSeason1(events: S1Event[], season: S1Season) {
  const holdBps = BigInt(season.holdBps ?? S1_DEFAULTS.holdBps);
  const lpBps = BigInt(season.lpBps ?? S1_DEFAULTS.lpBps);
  const vest = season.vestBlocks ?? season.blocksPerDay;
  const creditBlocks = BigInt(Math.round((season.liquidationCreditDays ?? S1_DEFAULTS.liquidationCreditDays) * season.blocksPerDay));
  const { startBlock: start, endBlock: end, bandLower, bandUpper } = season;
  if (end < start) throw Error("season ends before it starts");
  if (bandUpper <= bandLower) throw Error("empty peg band");
  const sorted = [...events].sort(byChainOrder);
  // How far the data reaches. The CLI passes the block it read through; by default the data is taken as complete
  // through the season's end (as the preseason engine assumes).
  const through = season.dataThroughBlock ?? end;
  const excluded = new Set(["0x0000000000000000000000000000000000000000", ...(season.excluded ?? [])].map((a) => a.toLowerCase()));
  const clamp = (b: number) => (b < start ? start : b > end ? end : b);

  const wallets = new Map<string, Wallet>();
  const wallet = (a: string) => {
    const k = a.toLowerCase();
    let w = wallets.get(k);
    if (!w) wallets.set(k, (w = { held: 0n, debt: 0n, since: start, holdPoints: 0n, lpPoints: 0n, liquidationPoints: 0n }));
    return w;
  };
  const netHeld = (w: Wallet) => (!season.netDebt ? w.held : w.held > w.debt ? w.held - w.debt : 0n);
  const settleWallet = (w: Wallet, block: number) => {
    w.holdPoints += (netHeld(w) * BigInt(clamp(block) - clamp(w.since)) * holdBps) / 10_000n;
    w.since = block;
  };

  const positions = new Map<string, Position>();
  let tick: number | null = null;
  let lpSince = start;
  const atPeg = () => tick !== null && tick >= bandLower && tick < bandUpper;
  const earning = (p: Position) =>
    atPeg() && tick! >= p.tickLower && tick! < p.tickUpper && p.depth > 0n && p.owner !== "" && !excluded.has(p.owner);
  // Accrue every earning position from lpSince to `block` as pending, then vest whatever has passed its window.
  const settleLp = (block: number) => {
    const blocks = BigInt(clamp(block) - clamp(lpSince));
    if (blocks > 0n) {
      for (const p of positions.values()) {
        if (!earning(p)) continue;
        const raw = (p.depth * blocks * lpBps) / 10_000n;
        const last = p.pending[p.pending.length - 1];
        if (last && last.owner === p.owner) last.raw += raw;
        else p.pending.push({ owner: p.owner, raw });
      }
    }
    lpSince = block;
    for (const p of positions.values()) if (p.pending.length && block >= p.lastAdd + vest) vestPending(p);
  };
  const vestPending = (p: Position) => {
    for (const x of p.pending) wallet(x.owner).lpPoints += x.raw;
    p.pending = [];
  };
  const depthOf = (p: Position) => {
    const lo = Math.max(p.tickLower, bandLower);
    const hi = Math.min(p.tickUpper, bandUpper);
    return amount1Between(p.liquidity, lo, hi) * season.token1Scale;
  };

  for (const e of sorted) {
    settleLp(e.block);
    if (e.kind === "transfer") {
      for (const [who, delta] of [[e.from, -e.value], [e.to, e.value]] as const) {
        if (excluded.has(who.toLowerCase())) continue;
        const w = wallet(who);
        settleWallet(w, e.block);
        w.held += delta;
        if (w.held < 0n) throw Error(`imdUSD history is incomplete: ${who} would hold a negative balance at block ${e.block}`);
      }
    } else if (e.kind === "debt") {
      if (e.value < 0n) throw Error("debt cannot be negative");
      const w = wallet(e.owner);
      settleWallet(w, e.block);
      w.debt = e.value;
    } else if (e.kind === "bite") {
      if (e.block > start && e.block <= end && !excluded.has(e.liquidator.toLowerCase())) {
        wallet(e.liquidator).liquidationPoints += e.debtRepaid * creditBlocks;
      }
    } else if (e.kind === "price") {
      tick = e.tick;
    } else if (e.kind === "owner") {
      let p = positions.get(e.id);
      if (!p) positions.set(e.id, (p = { id: e.id, tickLower: 0, tickUpper: 0, liquidity: 0n, owner: e.owner.toLowerCase(), lastAdd: -Infinity, pending: [], depth: 0n }));
      p.owner = e.owner.toLowerCase();
    } else if (e.kind === "liquidity") {
      let p = positions.get(e.id);
      if (!p) positions.set(e.id, (p = { id: e.id, tickLower: e.tickLower, tickUpper: e.tickUpper, liquidity: 0n, owner: "", lastAdd: -Infinity, pending: [], depth: 0n }));
      p.tickLower = e.tickLower;
      p.tickUpper = e.tickUpper;
      p.liquidity += e.delta;
      if (p.liquidity < 0n) throw Error(`position ${e.id} would hold negative liquidity at block ${e.block}: a log is missing`);
      if (e.delta > 0n) {
        // An addition restarts the hold window. What is pending stays pending under the new window.
        p.lastAdd = e.block;
      } else if (e.delta < 0n && e.block < p.lastAdd + vest) {
        p.pending = []; // removed inside the hold window: everything pending is forfeited
      }
      p.depth = depthOf(p);
    }
  }

  // Close out at the season end, or at the last block the data covers if the season is still running: nothing
  // accrues past what the data has seen. Then vest what the data proves was held long enough.
  const stop = Math.min(end, through);
  settleLp(stop);
  for (const p of positions.values()) if (p.pending.length && through >= p.lastAdd + vest) vestPending(p);

  let total = 0n;
  let totalRatePerBlock = 0n;
  const rows: S1Account[] = [];
  const pendingBy = new Map<string, bigint>();
  const lpRateBy = new Map<string, bigint>();
  for (const p of positions.values()) {
    for (const x of p.pending) pendingBy.set(x.owner, (pendingBy.get(x.owner) ?? 0n) + x.raw);
    if (!season.closed && earning(p)) lpRateBy.set(p.owner, (lpRateBy.get(p.owner) ?? 0n) + (p.depth * lpBps) / 10_000n);
  }
  for (const k of new Set([...wallets.keys(), ...pendingBy.keys(), ...lpRateBy.keys()])) {
    if (excluded.has(k)) continue;
    const w = wallet(k);
    settleWallet(w, stop);
    const points = w.holdPoints + w.lpPoints + w.liquidationPoints;
    const ratePerBlock = season.closed ? 0n : (netHeld(w) * holdBps) / 10_000n + (lpRateBy.get(k) ?? 0n);
    const lpPending = pendingBy.get(k) ?? 0n;
    if (points === 0n && ratePerBlock === 0n && lpPending === 0n) continue;
    total += points;
    totalRatePerBlock += ratePerBlock;
    rows.push({ owner: k, held: w.held, debt: w.debt, holdPoints: w.holdPoints, lpPoints: w.lpPoints, lpPending, liquidationPoints: w.liquidationPoints, points, ratePerBlock });
  }
  rows.sort((x, y) => (y.points > x.points ? 1 : y.points < x.points ? -1 : x.owner.localeCompare(y.owner)));
  return { startBlock: start, endBlock: end, blocksPerDay: season.blocksPerDay, atPeg: atPeg(), tick, total, totalRatePerBlock, accounts: rows };
}

export { WAD };
