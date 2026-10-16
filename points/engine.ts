// Genesis points. PURE: events in, points out; no network and no clock.
//
// One source for both consumers: the terminal imports this file through Vite, and the CLI runs it
// directly under Node's type stripping. Keep it to erasable TypeScript (types only: no enums,
// namespaces or parameter properties) so both can.
//
// THE RULE (user decisions, 2026-10-05):
//   1 point = 1 imdUSD held for 1 day.
//   - imdUSD in a wallet earns 1x.
//   - imdUSD provided as liquidity (imdUSD/USDC) earns a boosted rate: the launch has to solve
//     initial liquidity, so LPs earn more. Default 3x.
//   - Liquidators earn the debt they repay x a flat credit of 3 days.
//   - Borrowing and redeeming earn nothing by themselves: a borrower earns by holding or providing
//     liquidity with what they mint, and if they sell it the buyer earns instead.
//
// Points belong to an ADDRESS, not to the token. Whoever holds imdUSD earns from the block it
// arrives; the previous holder keeps what they earned and stops. Nothing transfers with the token.
//
// TIME IS MEASURED IN BLOCKS (a day is `blocksPerDay`, 7,200 on Ethereum at 12s). Every holder sees
// the same block count, so each share is exact; only the absolute figure moves with a missed slot.
// It needs no timestamps, so any RPC or explorer reproduces the same numbers. Within a block, only
// the balance at the end of the block counts: a flash loan earns nothing.

export type Transfer = { kind: "transfer"; from: string; to: string; value: bigint; block: number; logIndex: number };
export type Bite = { kind: "bite"; liquidator: string; debtRepaid: bigint; block: number; logIndex: number };
/** An owner's TOTAL liquidity-provided imdUSD-equivalent from this point on (absolute, not a delta). */
export type LpValue = { kind: "lp"; owner: string; value: bigint; block: number; logIndex: number };
export type PointEvent = Transfer | Bite | LpValue;

export type Season = {
  /** Points accrue over (startBlock, endBlock]. Balances are tracked from the first event regardless. */
  startBlock: number;
  endBlock: number;
  blocksPerDay: number;
  /** Multipliers in basis points: 10_000 = 1x. */
  holdBps?: number;
  lpBps?: number;
  liquidationCreditDays?: number;
  /** Contracts whose imdUSD is not anyone's holding: the vault, the Treasury, pool managers. */
  excluded?: string[];
  /** The season is over (the chain is past endBlock): nothing accrues any more, so every rate reads zero. */
  closed?: boolean;
};

export type AccountPoints = {
  owner: string;
  held: bigint;
  lp: bigint;
  holdPoints: bigint;
  lpPoints: bigint;
  liquidationPoints: bigint;
  points: bigint;
  /** Raw points earned per block at the current holdings. */
  ratePerBlock: bigint;
};

export const DEFAULTS = { holdBps: 10_000, lpBps: 30_000, liquidationCreditDays: 3, blocksPerDay: 7_200 };
export const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";

export function byChainOrder(a: PointEvent, b: PointEvent): number {
  return a.block - b.block || a.logIndex - b.logIndex;
}

type State = { held: bigint; lp: bigint; since: number; holdPoints: bigint; lpPoints: bigint; liquidationPoints: bigint };

/** Raw points are wei x blocks x multiplier / 10_000. `display` turns them into points. */
export function computePoints(events: PointEvent[], season: Season) {
  const holdBps = BigInt(season.holdBps ?? DEFAULTS.holdBps);
  const lpBps = BigInt(season.lpBps ?? DEFAULTS.lpBps);
  const creditBlocks = BigInt(Math.round((season.liquidationCreditDays ?? DEFAULTS.liquidationCreditDays) * season.blocksPerDay));
  const { startBlock: start, endBlock: end } = season;
  if (end < start) throw Error("season ends before it starts");
  const excluded = new Set([ZERO, ...(season.excluded ?? [])].map((a) => a.toLowerCase()));
  const clamp = (b: number) => (b < start ? start : b > end ? end : b);

  const accounts = new Map<string, State>();
  const at = (address: string) => {
    const key = address.toLowerCase();
    let s = accounts.get(key);
    if (!s) accounts.set(key, (s = { held: 0n, lp: 0n, since: start, holdPoints: 0n, lpPoints: 0n, liquidationPoints: 0n }));
    return s;
  };
  // Settle an account's accrual up to `block`, before its holdings change.
  const settle = (s: State, block: number) => {
    const blocks = BigInt(clamp(block) - clamp(s.since));
    s.holdPoints += (s.held * blocks * holdBps) / 10_000n;
    s.lpPoints += (s.lp * blocks * lpBps) / 10_000n;
    s.since = block;
  };

  for (const e of [...events].sort(byChainOrder)) {
    if (e.kind === "transfer") {
      for (const [who, delta] of [[e.from, -e.value], [e.to, e.value]] as const) {
        if (excluded.has(who.toLowerCase())) continue;
        const s = at(who);
        settle(s, e.block);
        s.held += delta;
        // A negative balance means a log is missing. Fail closed rather than publish wrong points.
        if (s.held < 0n) throw Error(`imdUSD history is incomplete: ${who} would hold a negative balance at block ${e.block}`);
      }
    } else if (e.kind === "lp") {
      if (excluded.has(e.owner.toLowerCase())) continue;
      const s = at(e.owner);
      settle(s, e.block);
      if (e.value < 0n) throw Error("liquidity value cannot be negative");
      s.lp = e.value;
    } else if (e.kind === "bite") {
      if (e.block > start && e.block <= end && !excluded.has(e.liquidator.toLowerCase())) {
        at(e.liquidator).liquidationPoints += e.debtRepaid * creditBlocks;
      }
    }
  }

  let total = 0n;
  let totalRatePerBlock = 0n;
  const rows: AccountPoints[] = [];
  for (const [owner, s] of accounts) {
    settle(s, end);
    const points = s.holdPoints + s.lpPoints + s.liquidationPoints;
    const ratePerBlock = season.closed ? 0n : (s.held * holdBps + s.lp * lpBps) / 10_000n;
    if (points === 0n && ratePerBlock === 0n) continue;
    total += points;
    totalRatePerBlock += ratePerBlock;
    rows.push({ owner, held: s.held, lp: s.lp, holdPoints: s.holdPoints, lpPoints: s.lpPoints, liquidationPoints: s.liquidationPoints, points, ratePerBlock });
  }
  rows.sort((x, y) => (y.points > x.points ? 1 : y.points < x.points ? -1 : x.owner.localeCompare(y.owner)));
  return { startBlock: start, endBlock: end, blocksPerDay: season.blocksPerDay, total, totalRatePerBlock, accounts: rows };
}

export type PointsResult = ReturnType<typeof computePoints>;

/** Raw points as display points (1 imdUSD for 1 day = 1), to `decimals` places. */
export function display(raw: bigint, blocksPerDay: number, decimals = 2): string {
  const scale = WAD * BigInt(blocksPerDay);
  const whole = raw / scale;
  if (decimals === 0) return whole.toString();
  const unit = 10n ** BigInt(decimals);
  const frac = ((raw % scale) * unit) / scale;
  return `${whole}.${frac.toString().padStart(decimals, "0")}`;
}

/** Display points as a float, for counters and charts only; never for allocation. */
export function displayNumber(raw: bigint, blocksPerDay: number): number {
  return Number((raw * 1_000_000n) / (WAD * BigInt(blocksPerDay))) / 1_000_000;
}

/** Share of all points in basis points. */
export function shareBps(points: bigint, total: bigint): number {
  return total === 0n ? 0 : Number((points * 10_000n) / total);
}
