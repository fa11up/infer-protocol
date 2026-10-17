// The Govern tab's "Recent governance actions": what the governance Safe has done outside imdUSD's Parameters
// timelock. Season openings (SeasonVault) and Treasury payouts (Treasury.withdraw) are direct Safe calls, so the
// Parameters view above never shows them. Read from the SeasonVault's state and the Treasury's `Withdrawn` logs.
// No pot amounts: they stay private (user, 2026-10-16).
import { useEffect, useState } from "react";
import { getAddress, type Address, type Hex } from "viem";
import { Row } from "./actions";
import { history } from "./history";
import { readSeason, SEASON_OPENED_TOPIC, type SeasonInfo } from "./season";
import { pointsConfig } from "./config";
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
  "0x0c1ce09ccfe9243c4ad23c3caee0c11d4e8340d3": "stakers",
  "0x00856bd495941f3b95da5b7e374c76d822c9059e": "the oracle",
  "0xbefd108085613662356aa26a2466ad3426da9c32": "the Safe",
};

type Payout = { block: bigint; tx: Hex; token: Address; to: Address; amount: bigint };
/** One line of the log: when, what, and the transaction that did it. */
type Entry = { at?: number; what: string; tx?: Hex; block?: bigint };
type Activity = { loaded: boolean; season?: SeasonInfo; entries: Entry[]; error?: string };

// A block's time and the opening's transaction never change: read once per page, not on every refresh.
const blockTimes = new Map<bigint, number>();
const openingTx = new Map<bigint, Hex | undefined>();
const utc = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
/** A log line's time: the heading says UTC, so each line need not. */
const stamp = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).replace(",", "");
const whole = (amount: bigint, decimals: number) => (amount / 10n ** BigInt(decimals)).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function GovActivity({ r, s }: { r: Runtime; s?: Snapshot }) {
  // Rendered inside another desk column: the governance desk holds two, and a third wrapped and overflowed.
  const [act, setAct] = useState<Activity>({ loaded: false, entries: [] });
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
      const payouts: Payout[] = (logs ?? [])
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
      const entries: Entry[] = payouts.map((p) => {
        const t = INFER_TOKENS[p.token.toLowerCase()];
        const amount = t ? `${whole(p.amount, t.decimals)} ${t.symbol}` : `${p.amount} of ${short(p.token)}`;
        return { what: `Paid ${amount} to ${RECIPIENTS[p.to.toLowerCase()] ?? short(p.to)}`, tx: p.tx, block: p.block };
      });
      // The season opening is known by its block: its transaction is the governance Safe's call in that block.
      if (season?.openedBlock !== undefined) {
        const opened: Entry = { what: "Season 1 opened", block: BigInt(season.openedBlock) };
        // Its transaction is the one in that block whose receipt carries the SeasonVault's SeasonOpened log. The
        // Safe's batch that opened Season 1 also paid stakers, so a payout in the same block already names it.
        opened.tx = payouts.find((p) => p.block === opened.block)?.tx ?? openingTx.get(opened.block!);
        const vault = (pointsConfig.seasonVaults[r.config.chainId] as string | undefined)?.toLowerCase();
        if (!opened.tx && vault && !openingTx.has(opened.block!)) {
          try {
            const receipts = (await r.client.request({
              method: "eth_getBlockReceipts" as never,
              params: [`0x${opened.block!.toString(16)}`] as never,
            })) as { transactionHash: Hex; logs: { address: string; topics: string[] }[] }[];
            opened.tx = receipts.find((rc) =>
              rc.logs.some((l) => l.address.toLowerCase() === vault && l.topics[0]?.toLowerCase() === SEASON_OPENED_TOPIC),
            )?.transactionHash;
          } catch {
            /* Shown with its block link instead. */
          }
          openingTx.set(opened.block!, opened.tx);
        }
        entries.push(opened);
      }
      // Every entry gets its block's time; a handful of blocks, read once per refresh of the list.
      await Promise.all(
        entries
          .filter((e) => e.at === undefined && e.block !== undefined)
          .map(async (e) => {
            try {
              e.at = blockTimes.get(e.block!) ?? Number((await r.client.getBlock({ blockNumber: e.block! })).timestamp);
              blockTimes.set(e.block!, e.at);
            } catch {
              /* Left without a time. */
            }
          }),
      );
      entries.sort((a, b) => Number((b.block ?? 0n) - (a.block ?? 0n)));
      // The desk never scrolls: the newest five.
      entries.splice(5);
      if (live) setAct({ loaded: true, season, entries, error: logs ? undefined : "Treasury history unavailable right now." });
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
        Recent governance actions · UTC{act.error ? " · not read" : ""}
      </div>
      <Row label="Season 1" info="Opened by the governance Safe on the SeasonVault: its start, its rules and its pot are fixed on chain and cannot be changed.">
        {!act.loaded
          ? "—"
          : !season || season.phase === "preseason"
          ? "Not opened"
          : season.phase === "scheduled"
            ? `Starts ${utc(season.start!)}`
            : season.phase === "live"
              ? `Live · ends ${utc(season.end!)}`
              : `Ended ${utc(season.end!)}`}
      </Row>
      <ol className="gov-log">
        {act.entries.map((e) => (
          <li key={`${e.tx ?? e.block}:${e.what}`}>
            <time dateTime={e.at ? new Date(e.at * 1000).toISOString() : undefined}>{e.at ? stamp(e.at) : "—"}</time>
            <span>{e.what}</span>
            {e.tx ? (
              <a href={`${explorer}/tx/${e.tx}`} target="_blank" rel="noreferrer" aria-label={`Transaction: ${e.what}`}>
                Tx ↗
              </a>
            ) : e.block !== undefined ? (
              <a href={`${explorer}/block/${e.block}`} target="_blank" rel="noreferrer" aria-label={`Block of: ${e.what}`}>
                Block ↗
              </a>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ol>
    </>
  );
}
