// Pure helpers for the Points pane's Season 1 view (no network, no DOM), so Node tests them directly.

export type SeasonPhase = "preseason" | "scheduled" | "live" | "ended";

export function phaseAt(now: number, opened: boolean, start?: number, end?: number): SeasonPhase {
  if (!opened || start === undefined || end === undefined) return "preseason";
  return now < start ? "scheduled" : now < end ? "live" : "ended";
}

/** A share of a pot, by points: pot × shareBps ÷ 10,000 × points ÷ total, rounded down (rules section 4). */
export function infer(points: bigint, total: bigint, pot: bigint, shareBps: number): bigint {
  if (total <= 0n || points <= 0n) return 0n;
  return (((pot * BigInt(shareBps)) / 10_000n) * points) / total;
}

