// Its own module so infer.imdusd.com's header can use it without imdusd.com's header (site.tsx), which brings
// imdusd.com's backgrounds, price chips and deployment file with it.

/** A header chip naming a network and its state ("Mainnet · live", "Robinhood · staging"), the state
 * pulsing. Shared with infer.imdusd.com. */
export function NetworkChip({
  network,
  state,
  optional = false,
}: {
  network: string;
  state: "live" | "staging";
  /** The first chip to give up its place when the header is short of room (style.css, below 1180px). */
  optional?: boolean;
}) {
  return (
    <span className={optional ? "chip chip-optional" : "chip"}>
      {network} · <span className={`chip-pulse chip-${state}`}>{state}</span>
    </span>
  );
}
