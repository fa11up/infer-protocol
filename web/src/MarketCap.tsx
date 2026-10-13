import { formatUnits } from "viem";

// imdUSD is USD-denominated, so its market cap at par is its supply in dollars.
// Drawn as a monospace progress line, the way imd.fun tracks $IMD against its goal.
export const GOAL = 1_000_000_000;
const CELLS = 24;
export const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
export function capBar(dollars: number, cells = CELLS) {
  const share = Math.min(1, Math.max(0, dollars / GOAL));
  // Any supply at all shows one cell, so a live protocol never reads as empty.
  const filled = dollars > 0 ? Math.max(1, Math.round(share * cells)) : 0;
  return `[${"=".repeat(filled)}${"·".repeat(cells - filled)}]`;
}
export function MarketCap({ supply }: { supply?: bigint }) {
  const dollars =
    supply === undefined ? undefined : Number(formatUnits(supply, 18));
  return (
    <span
      className="market-cap"
      role="meter"
      aria-label="imdUSD market cap toward the $&nbsp;1B goal"
      aria-valuemin={0}
      aria-valuemax={GOAL}
      aria-valuenow={dollars ?? 0}
      aria-valuetext={
        dollars === undefined
          ? "Unavailable"
          : `$\u00a0${compact.format(dollars)} of $\u00a01B`
      }
      title="Market cap = supply × $&nbsp;1 par"
    >
      imdUSD{" "}
      <b>{dollars === undefined ? "—" : `$\u00a0${compact.format(dollars)}`}</b>{" "}
      <span className="cap-bar" aria-hidden="true">
        {capBar(dollars ?? 0)}
      </span>{" "}
      $&nbsp;1B goal
    </span>
  );
}
