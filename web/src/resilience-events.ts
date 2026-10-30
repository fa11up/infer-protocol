// The stress events the stats page's resilience panel marks on its charts (Analytics.tsx ResiliencePanel). A short,
// hand-kept list of what happened and when, each one line and neutral: every figure the panel shows beside them is read
// from the chain (the peg pool's swaps, the feeds' updates, the vault's liquidations), so the list only names the dates.
// Times are UTC. Mainnet only: another deployment has its own history.

export type StressEvent = {
  /** When it began (and, for a span, ended): ISO 8601, UTC. */
  from: string;
  to?: string;
  title: string;
  text: string;
};

export const STRESS_EVENTS: StressEvent[] = [
  {
    from: "2026-10-11T06:21:00Z",
    title: "Launch",
    text: "The vault and the imdUSD/USDC peg pool open on Ethereum mainnet.",
  },
  {
    from: "2026-10-12T09:00:00Z",
    to: "2026-10-15T23:00:00Z",
    title: "IMD falls 41%",
    text: "IMD, the collateral's underlying token, falls 41% against ETH over three days; the peg pool stays within 1% of $1.",
  },
  {
    from: "2026-10-14T15:01:00Z",
    title: "First liquidation",
    text: "A loan under the minimum ratio is marked and liquidated by an outside keeper, with no bad debt.",
  },
  {
    from: "2026-10-16T15:34:00Z",
    to: "2026-10-19T02:06:00Z",
    title: "Depeg and recovery",
    text: "Borrowed imdUSD sold into a thin pool takes the pool to $0.88 while redemption lags the market; it is back inside the band on 10-19.",
  },
  {
    from: "2026-10-23T03:42:00Z",
    to: "2026-10-23T16:35:00Z",
    title: "Oracle network outage",
    text: "The oracle network's API is unreachable for about ten hours: feeds age out, new borrowing pauses on its own, keepers hold their paid requests, and updates resume when it returns.",
  },
];

export const eventTime = (iso: string) => Math.floor(Date.parse(iso) / 1000);
