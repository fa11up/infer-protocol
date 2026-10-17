// The Govern tab's "Recent governance actions": what the governance Safe has done outside imdUSD's Parameters
// timelock. Season openings (SeasonVault) and Treasury payouts (Treasury.withdraw) are direct Safe calls, so the
// Parameters view above never shows them. Read from the SeasonVault's state and the Treasury's `Withdrawn` logs.
// No pot amounts: they stay private (user, 2026-10-16).
import { useEffect, useState } from "react";
import { getAddress, type Address, type Hex } from "viem";
import { Row } from "./actions";
import { history } from "./history";
import { readSeason, type SeasonInfo } from "./season";
import type { Runtime } from "./config";
import type { Snapshot } from "./state";

/** keccak256("Withdrawn(address,address,uint256)"): Treasury.withdraw, token and recipient indexed. */
const WITHDRAWN = "0xd1c19fbc";
const INFER_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x53d0ea0a685220718dc6a0a6e4617194c6f37921": { symbol: "INFER", decimals: 18 },
  "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7": { symbol: "IMD", decimals: 18 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
  "0x61aaf8a992a3143e2b0c9cb0030b9fe702854a25": { symbol: "imdUSD", decimals: 18 },
};
const RECIPIENTS: Record<string, string> = {
  "0x0c1ce09ccfe9243c4ad23c3caee0c11d4e8340d3": "INFER stakers (InferDripper)",
  "0x00856bd495941f3b95da5b7e374c76d822c9059e": "Oracle asker (price updates)",
  "0xbefd108085613662356aa26a2466ad3426da9c32": "Governance Safe",
};

type Payout = { block: bigint; tx: Hex; token: Address; to: Address; amount: bigint };
type Activity = { loaded: boolean; season?: SeasonInfo; payouts: Payout[]; error?: string };

const utc = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const whole = (amount: bigint, decimals: number) => (amount / 10n ** BigInt(decimals)).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function GovActivity({ r, s }: { r: Runtime; s?: Snapshot }) {
  // Rendered inside another desk column: the governance desk holds two, and a third wrapped and overflowed.
  const [act, setAct] = useState<Activity>({ loaded: false, payouts: [] });
  const block = s?.block;
  const treasury = s?.targets.treasury;
  useEffect(() => {
    if (!block || !treasury) return;
    let live = true;
    (async () => {
      const [season, logs] = await Promise.all([
        readSeason(r, block, Math.floor(Date.now() / 1000)).catch(() => undefined),
        history(r, treasury, block)
          .then((h) => h.logs)
          .catch((e) => {
            console.warn("Treasury history:", e);
            return undefined;
          }),
      ]);
      const payouts = (logs ?? [])
        .filter((l) => l.topics[0]?.toLowerCase().startsWith(WITHDRAWN) && l.topics.length >= 3)
        .map((l) => ({
          block: l.blockNumber,
          tx: l.transactionHash,
          token: getAddress(`0x${l.topics[1]!.slice(-40)}`),
          to: getAddress(`0x${l.topics[2]!.slice(-40)}`),
          amount: BigInt(l.data),
        }))
        .sort((a, b) => (a.block > b.block ? -1 : 1))
        .slice(0, 5);
      if (live) setAct({ loaded: true, season, payouts, error: logs ? undefined : "Treasury history unavailable right now." });
    })();
    return () => {
      live = false;
    };
  }, [r, block, treasury]);

  const explorer = r.config.network.explorer;
  const season = act.season;
  return (
    <>
      <div className="section-label" title={act.error || undefined}>
        Recent governance actions{act.error ? " · not read" : ""}
      </div>
      <Row label="Season 1" info="Opened by the governance Safe on the SeasonVault: its start, its rules and its pot are fixed on chain and cannot be changed.">
        {!act.loaded
          ? "—"
          : !season || season.phase === "preseason"
          ? "Not opened"
          : season.phase === "scheduled"
            ? `Opened · starts ${utc(season.start!)}`
            : season.phase === "live"
              ? `Live · ends ${utc(season.end!)}`
              : `Ended ${utc(season.end!)}`}
      </Row>
      {season?.openedBlock !== undefined && (
        <Row label="Opened at" info="The preseason ended at this block (rules/season-1.md section 3). The rules document's hash was committed in the same transaction; the document is published after the season ends.">
          <a href={`${explorer}/block/${season.openedBlock}`} target="_blank" rel="noreferrer">
            block {season.openedBlock.toLocaleString("en-US")} ↗
          </a>
        </Row>
      )}
      {act.payouts.map((p) => {
        const t = INFER_TOKENS[p.token.toLowerCase()];
        return (
          <Row key={`${p.tx}:${p.to}`} label="Treasury payout" info="Treasury.withdraw, sent by the governance Safe.">
            <a href={`${explorer}/tx/${p.tx}`} target="_blank" rel="noreferrer">
              {t ? `${whole(p.amount, t.decimals)} ${t.symbol}` : `${p.amount} of ${short(p.token)}`} →{" "}
              {RECIPIENTS[p.to.toLowerCase()] ?? short(p.to)} ↗
            </a>
          </Row>
        );
      })}
    </>
  );
}
