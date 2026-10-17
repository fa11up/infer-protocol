import { unit } from "./unit";
import { perImd } from "./collateral";
import { useEffect, useRef, useState } from "react";
import { pack } from "./swarm";
import { formatUnits, maxUint256 } from "viem";
import type { Runtime } from "./config";
import { shownEarnLine, type Snapshot } from "./state";
import {
  loanBook,
  cadence,
  positionName,
  type Book,
  type Cadence,
  type Result,
} from "./history";
import { fmt, money, ratio, WAD, message, liquidationPrice, cushion } from "./math";
import { Ticker } from "./motion";
import { Info, Select } from "./actions";
import { useEns, ensName, displayName } from "./ens";

type Loaded<T> = Result<T> & { snapshot?: Snapshot; loading?: boolean };
export function useCharts(r: Runtime, s?: Snapshot) {
  const [book, setBook] = useState<Loaded<Book>>({ loading: true });
  const [feeds, setFeeds] = useState<Record<string, Loaded<Cadence>>>({});
  const [attempt, retry] = useState(0);
  const running = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!s) return;
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;
    setBook((old) => ({ ...old, loading: true }));
    const load = async <T,>(fn: () => Promise<T>): Promise<Loaded<T>> => {
      try {
        return { data: await fn(), snapshot: s };
      } catch (e) {
        return { error: message(e) };
      }
    };
    void Promise.all([
      // A failed read keeps the last good book on screen with its error, rather than emptying the chart.
      load(() => loanBook(r, s)).then((result) => {
        if (mounted.current)
          setBook((old) => (result.error && old.data ? { ...old, loading: false, error: result.error } : result));
      }),
      ...[
        "PriceFeed",
        "NhiFeed",
        "SpotFeed",
        ...(s.work.mode === "attested" ? ["oracle"] : []),
      ].map(async (name) => {
        if (mounted.current)
          setFeeds((old) => ({
            ...old,
            [name]: { ...old[name], loading: true },
          }));
        const result = await load(() => cadence(r, s.targets[name], s.block));
        if (mounted.current)
          setFeeds((old) => ({
            ...old,
            [name]: result.error && old[name]?.data ? { ...old[name], loading: false, error: result.error } : result,
          }));
      }),
    ]).finally(() => {
      running.current = false;
      if (pending.current && mounted.current) {
        pending.current = false;
        retry((n) => n + 1);
      }
    });
  }, [r, s, attempt]);
  return { book, feeds, retry: () => retry((n) => n + 1) };
}
export type ChartData = ReturnType<typeof useCharts>;
/** The loan book shows loans owing at least this much (1 imdUSD, about $1). */
const MIN_SHOWN_DEBT = 10n ** 18n;
const number = (v: bigint) => Number(formatUnits(v, 18));
const liquidation = (p: { collateral: bigint; debt: bigint }, s?: Snapshot) => {
  const at =
    s?.v.mat && perImd(liquidationPrice(p.collateral, p.debt, s.v.mat));
  return at
    ? `liquidates at $\u00a0${fmt(at, 18, 2)}, ${cushion(s!.feeds.USD?.value, at)}`
    : "liquidation price unavailable";
};
const stateOf = (cr: bigint, min: bigint, ceiling: bigint) =>
  cr < min ? "Liquidatable" : cr < ceiling ? "Redeemable" : "Safe";

export function LoanBook({
  charts,
  available,
  onOpen,
}: {
  charts: ChartData;
  available: boolean;
  /** Opens a borrower in the keeper desk. */
  onOpen?: (owner: string) => void;
}) {
  const { book } = charts;
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [selected, setSelected] = useState<string>();
  // The loan a pointer or keyboard is on (a tap focuses it): its popup shows while it stays there.
  const [hovered, setHovered] = useState<string>();
  const axisCeiling = useRef(300);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [book.data, available]);
  const s = book.snapshot;
  // Loans that matter: at least $1 of debt. A repaid position (no debt) or one owing cents is not a loan anyone
  // will mark, liquidate or redeem against, and on the chart it only crowded the left edge with specks.
  const all = book.data?.positions ?? [];
  const positions = all.filter((p) => p.cr !== maxUint256 && p.debt >= MIN_SHOWN_DEBT);
  const hidden = all.length - positions.length;
  useEns(positions.map((p) => p.owner));
  const min = s?.v.mat as bigint | undefined;
  const ceiling = s?.v.redemptionCeilingCR as bigint | undefined;
  const valid =
    available && !!book.data && min !== undefined && ceiling !== undefined;
  // Saturated uint256 ratios remain identifiable in the ledger; the arrow marks the overflow.
  const finite = positions
    .filter((p) => p.cr !== maxUint256)
    .map((p) => Number(p.cr));
  // The axis stops at 500%: past it a position is safe by any measure, and stretching the axis for one very
  // safe loan squeezes every position that matters into the left half. Those beyond sit on the right edge.
  const AXIS_CAP = 500;
  axisCeiling.current = Math.min(AXIS_CAP, Math.max(
    axisCeiling.current,
    Math.ceil(
      Math.max(
        Number(ceiling ?? 0n) * 1.05,
        ...finite.map((x) => x * 1.05),
        300,
      ) / 100,
    ) * 100,
  ));
  const maximum = axisCeiling.current;
  // The axis starts at 100%: below it a position is underwater (debt worth more than its collateral), and
  // those are pinned to the left edge with an arrow rather than stretching the axis down to zero.
  const FLOOR = 100;
  const at = (value: bigint) =>
    Math.max(0, Math.min(100, ((Number(value) - FLOOR) / (maximum - FLOOR)) * 100));
  // A bubble cloud: each circle at its exact ratio, nudged up or down only as far as it must to clear the
  // others (the height carries no value). AREA IS DEBT, in true proportion to the largest loan: the largest is
  // MAX_DOT px in radius and a loan a quarter its size is half that, so the cloud shows where the money is.
  // Only the smallest are lifted to MIN_DOT so they stay visible. If the cloud would outgrow MAX_HEIGHT the
  // dots shrink and it packs again, but every circle's HIT area stays a 24px target and the plot grows rather
  // than clip (swarm.ts `pack`).
  const largest = positions.reduce((m, p) => Math.max(m, Number(p.debt)), 1);
  const MAX_DOT = 24;
  const MIN_DOT = 4;
  const MAX_HEIGHT = 96; // the desk never scrolls: a stacked cloud shrinks its dots (sizes stay proportional) before it grows
  const plotWidth = Math.max(1, width);
  const { circles, ys, height } = pack(
    positions.map((p) => ({
      id: p.owner,
      x: (at(p.cr) / 100) * plotWidth,
      dot: Math.max(MIN_DOT, MAX_DOT * Math.sqrt(Number(p.debt) / largest)),
    })),
    MAX_HEIGHT,
  );
  const centre = height / 2;
  const marks = positions.map((p) => {
    const c = circles.find((q) => q.id === p.owner)!;
    return {
      ...p,
      x: at(p.cr),
      y: centre + (ys.get(p.owner) ?? 0),
      radius: c.dot,
      hit: c.r,
    };
  });
  return (
    <>
      <div className="book-heading">
        <p className="figure-head">
          Collateral ratio
          <Info
            label="Loan book"
            text={`Every open position owing at least $1, by collateral ratio, from 100%. Circle area is accrued ${unit()} debt, in proportion to the largest loan; circles stack up and down only to stay apart, so height carries no value and a tall cloud is where debt is concentrated. Positions under 100% sit at the left edge and those above 500% at the right edge. The bands move with the live minCR and redemption ceiling.`}
          />
        </p>
        <span className="muted" title={hidden ? `${hidden} position${hidden === 1 ? "" : "s"} owing under $1 not shown` : undefined}>
          {/* The book's own block: after a failed refresh the last good book stays on screen, read at its block. */}
          {valid
            ? `${positions.length} open · block ${(book.snapshot ?? s!).block}`
            : "Coverage unverified"}
          {book.loading && " · Reading…"}
        </span>
      </div>
      {valid && book.error && !book.loading && (
        <p className="micro danger-text" role="status">
          Could not refresh the loan book: {book.error} Showing the book as read at block{" "}
          {(book.snapshot ?? s!).block}. Refresh state to try again.
        </p>
      )}
      <div className="book-legend">
        <span className="danger-text">Below minCR · liquidatable</span>
        <span className="caution-text">minCR → ceiling · redeemable</span>
        <span className="healthy-text">Above ceiling · safe</span>
      </div>
      {!valid ? (
        <div className="chart-unavailable" role="status">
          <p>
            {book.error
              ? `Could not read loan book. ${book.error} Refresh state or retry history; position count is unknown.`
              : !available
                ? "Waiting for live contract state. Position count is unknown."
                : book.loading
                  ? "Reading deposit logs and every owner’s position…"
                  : "Could not read loan book thresholds. Refresh state."}
          </p>
          <button disabled={book.loading || !available} onClick={charts.retry}>
            Retry history
          </button>
        </div>
      ) : (
        <>
          <div className="strip-wrap">
            <div className="strip-labels">
              <span aria-hidden="true" />
              <span className="min-label" style={{ left: `${at(min!)}%` }}>
                minCR <Ticker text={`${min}%`} />
              </span>
              <span
                className="ceiling-label"
                style={{ left: `${at(ceiling!)}%` }}
              >
                Ceiling <Ticker text={`${ceiling}%`} />
              </span>
              <span aria-hidden="true" />
            </div>
            <div
              className="strip-plot"
              ref={host}
              style={{ height }}
              role="group"
              aria-label="Open positions by collateral ratio"
            >
              <div
                className="ratio-band liquidatable-band"
                style={{ width: `${at(min!)}%` }}
              />
              <div
                className="ratio-band redeemable-band"
                style={{
                  left: `${at(min!)}%`,
                  width: `${at(ceiling!) - at(min!)}%`,
                }}
              />
              <div
                className="ratio-band safe-band"
                style={{
                  left: `${at(ceiling!)}%`,
                  width: `${100 - at(ceiling!)}%`,
                }}
              />
              <div className="band-boundary" style={{ left: `${at(min!)}%` }} />
              <div
                className="band-boundary ceiling-boundary"
                style={{ left: `${at(ceiling!)}%` }}
              />
              {marks.map((p) => (
                <button
                  key={p.owner}
                  type="button"
                  className={`loan-mark ${p.cr < min! ? "is-danger" : p.cr < ceiling! ? "is-redeemable" : "is-healthy"}`}
                  style={{ left: `${p.x}%`, top: p.y, width: p.hit * 2, height: p.hit * 2 }}
                  aria-label={`${displayName(p.owner)}, ${p.owner}, ${p.cr}% collateral ratio, ${fmt(p.debt)} ${unit()}, ${stateOf(p.cr, min!, ceiling!)}, ${liquidation(p, s)}`}
                  aria-pressed={selected === p.owner}
                  onMouseEnter={() => setHovered(p.owner)}
                  onMouseLeave={() => setHovered((h) => (h === p.owner ? undefined : h))}
                  onFocus={(e) => {
                    // Keyboard focus shows the popup; focus a script moved here does not.
                    if (e.currentTarget.matches(":focus-visible")) setHovered(p.owner);
                  }}
                  onBlur={() => setHovered((h) => (h === p.owner ? undefined : h))}
                  onClick={() =>
                    setSelected(selected === p.owner ? undefined : p.owner)
                  }
                >
                  <span
                    className="loan-dot"
                    style={{ width: p.radius * 2, height: p.radius * 2 }}
                  />
                </button>
              ))}
              {(() => {
                const p = marks.find((m) => m.owner === hovered);
                if (!p) return null;
                // Above the circle, or below it when there is no room above.
                const below = p.y - p.hit < 52;
                return (
                  <div
                    className={`loan-pop${below ? " is-below" : ""}`}
                    role="tooltip"
                    style={{ left: `${p.x}%`, top: below ? p.y + p.hit + 6 : p.y - p.hit - 6 }}
                  >
                    <b>
                      {p.cr === maxUint256 && "→ "}
                      {p.cr < BigInt(FLOOR) && "← "}
                      {displayName(p.owner)}
                    </b>
                    <span>
                      {p.cr === maxUint256 ? "No debt" : `${p.cr}%`} · {money(p.debt)} ·{" "}
                      {stateOf(p.cr, min!, ceiling!)}
                    </span>
                    <span>{liquidation(p, s)}</span>
                  </div>
                );
              })()}
            </div>
            <div className="strip-axis">
              <span>{FLOOR}%</span>
              <span>{maximum}%{positions.some((p) => p.cr > BigInt(maximum)) ? "+" : ""}</span>
            </div>
          </div>
          <LoanFeed
            positions={positions}
            s={s!}
            min={min!}
            ceiling={ceiling!}
            selected={selected}
            onSelect={setSelected}
            onOpen={onOpen}
            coverage={book.data!.history}
          />
        </>
      )}
    </>
  );
}

type Zone = "Liquidatable" | "Redeemable" | "Safe";
function LoanFeed({
  positions,
  s,
  min,
  ceiling,
  selected,
  onSelect,
  onOpen,
  coverage,
}: {
  positions: Book["positions"];
  s: Snapshot;
  min: bigint;
  ceiling: bigint;
  selected?: string;
  onSelect: (owner?: string) => void;
  onOpen?: (owner: string) => void;
  coverage: Book["history"];
}) {
  const [query, setQuery] = useState("");
  const [zone, setZone] = useState<"all" | Zone>("all");
  const [order, setOrder] = useState<"ratio" | "debt">("ratio");
  const list = useRef<HTMLUListElement>(null);
  const q = query.trim().toLowerCase();
  const shown = positions
    .filter(
      (p) =>
        (zone === "all" || stateOf(p.cr, min, ceiling) === zone) &&
        (!q ||
          p.owner.toLowerCase().includes(q) ||
          displayName(p.owner).toLowerCase().includes(q) ||
          positionName(p.owner).toLowerCase().includes(q)),
    )
    .sort((a, b) =>
      order === "debt"
        ? a.debt > b.debt
          ? -1
          : a.debt < b.debt
            ? 1
            : 0
        : a.cr < b.cr
          ? -1
          : a.cr > b.cr
            ? 1
            : 0,
    );
  // A loan picked on the chart is always found in the list: a search or zone filter that would hide
  // it is cleared, then its row scrolls into view (the pane too, when the list is below the fold).
  // Only a new pick does this; filtering afterwards may hide the selected row like any other.
  const hidden = !!selected && !shown.some((p) => p.owner === selected);
  const [reveal, setReveal] = useState<string>();
  useEffect(() => {
    if (!selected) return;
    if (hidden) {
      setQuery("");
      setZone("all");
    }
    setReveal(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  useEffect(() => {
    if (!reveal || hidden) return;
    list.current
      ?.querySelector(`[data-owner="${reveal}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setReveal(undefined);
  }, [reveal, hidden]);
  return (
    <div className="loan-feed-wrap">
      <div className="loan-tools">
        <input
          type="search"
          id="loan-search"
          aria-label="Search positions by name or address"
          placeholder="Search name, ENS or 0x…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          id="loan-zone"
          label="Filter by zone"
          showLabel={false}
          value={zone}
          onChange={(v) => setZone(v as "all" | Zone)}
          options={[
            ["all", "All zones"],
            ["Liquidatable", "Liquidatable"],
            ["Redeemable", "Redeemable"],
            ["Safe", "Safe"],
          ]}
        />
        <Select
          id="loan-order"
          label="Sort positions"
          showLabel={false}
          value={order}
          onChange={(v) => setOrder(v as "ratio" | "debt")}
          options={[
            ["ratio", "Ratio ↑"],
            ["debt", "Debt ↓"],
          ]}
        />
      </div>
      {/* QA-05: the result count is announced politely when search or filter changes it. */}
      <p className="sr-only" role="status" aria-live="polite">
        {q || zone !== "all"
          ? `${shown.length} of ${positions.length} positions shown`
          : ""}
      </p>
      <div className="loan-columns" aria-hidden="true">
        <span>Position</span>
        <span>Ratio</span>
        <span>Debt</span>
        <span>Liquidates at</span>
      </div>
      <ul className="loan-feed" ref={list} aria-label="Open positions">
        {shown.map((p) => {
          const at = perImd(liquidationPrice(p.collateral, p.debt, min));
          const zoneOf = stateOf(p.cr, min, ceiling);
          return (
            <li
              key={p.owner}
              data-owner={p.owner}
              className={selected === p.owner ? "selected-loan" : undefined}
            >
              <button
                type="button"
                aria-current={selected === p.owner || undefined}
                title={`Open ${displayName(p.owner)} in Keeper`}
                onClick={() => {
                  onSelect(p.owner);
                  onOpen?.(p.owner);
                }}
              >
                <span className="loan-who">
                  <b className={ensName(p.owner) ? "ens-name" : undefined}>
                    {displayName(p.owner)}
                  </b>
                  <span className="loan-address" title={p.owner}>
                    {p.owner}
                  </span>
                </span>
                <span
                  className={
                    zoneOf === "Liquidatable"
                      ? "danger-text"
                      : zoneOf === "Safe"
                        ? "healthy-text"
                        : undefined
                  }
                >
                  {ratio(p.cr)}
                </span>
                <span>{money(p.debt)}</span>
                <span>
                  {at ? `$\u00a0${fmt(at, 18, 2)}` : "—"}
                  <small>{at ? cushion(s.feeds.USD?.value, at) : ""}</small>
                </span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="loan-empty">
            {positions.length ? "No positions match" : "No open positions"}
          </li>
        )}
      </ul>
      <div className="loan-coverage">
        <span>
          {coverage.source} · blocks {coverage.from.toString()}–
          {coverage.through.toString()} · {shown.length}/{positions.length}
        </span>
        <Info
          label="Read coverage"
          text="Owners are discovered from the vault's deposit logs over this block range, then each position is read at the displayed block. Names are deterministic labels for public addresses and can repeat."
        />
      </div>
    </div>
  );
}
function Unavailable({ children }: { children: string }) {
  return <p className="micro chart-unavailable">{children}</p>;
}
export function Sparkline({
  feed,
  live,
  now,
  label,
}: {
  feed?: Loaded<Cadence>;
  live?: Snapshot["feeds"][string];
  now: bigint;
  label: string;
}) {
  if (!feed?.data || !live)
    return (
      <Unavailable>
        {feed?.error
          ? `Could not read ${label} cadence. Retry history in the loan book.`
          : "Reading accepted updates…"}
      </Unavailable>
    );
  const points = feed.data.points;
  const start = Math.min(...points.map((p) => p.time));
  const latest = points.reduce((a, b) => (a.time > b.time ? a : b));
  const expiry = latest.time + Number(live.maxAge);
  const end = Math.max(Number(now), latest.time, start + 1);
  const values = points.map((p) => number(p.value));
  const low = Math.min(...values),
    high = Math.max(...values);
  const x = (t: number) => 6 + ((t - start) / (end - start)) * 288;
  const expiryX = Math.min(294, x(expiry));
  const y = (v: number) =>
    high === low ? 34 : 56 - ((v - low) / (high - low)) * 40;
  const d = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.time)},${y(number(p.value))}`)
    .join(" ");
  return (
    <figure className="mini-chart cadence-chart">
      <svg
        viewBox="0 0 300 78"
        role="img"
        aria-label={`${label}: ${points.length} accepted updates, irregular signed timestamps. Last accepted value expires ${new Date(expiry * 1000).toISOString()}.`}
      >
        <path d={d} className="spark-path" pathLength="1" />
        <line
          className="limit-line"
          x1={expiryX}
          x2={expiryX}
          y1="10"
          y2="64"
        />
        <text
          className="chart-text"
          x={expiryX > 180 ? expiryX - 3 : expiryX + 3}
          y="9"
          textAnchor={expiryX > 180 ? "end" : "start"}
        >
          {expiry > end ? "stale after →" : "stale after"}
        </text>
        {points.map((p) => (
          <circle
            key={p.id}
            className="spark-point"
            cx={x(p.time)}
            cy={y(number(p.value))}
            r="3"
          >
            <title>{`${new Date(p.time * 1000).toISOString()} · ${fmt(p.value, 18, 8)} · block ${p.block}`}</title>
          </circle>
        ))}
        <text className="chart-text" x="6" y="77">
          {new Date(start * 1000).toISOString().slice(5, 16).replace("T", " ")}
        </text>
        <text className="chart-text" x="294" y="77" textAnchor="end">
          {new Date(end * 1000).toISOString().slice(5, 16).replace("T", " ")}
        </text>
      </svg>
      <figcaption className="figure-head">
        {points.length} accepted · expiry{" "}
        {new Date(expiry * 1000).toISOString().slice(5, 16).replace("T", " ")}
        {feed.loading && " · Updating…"}
        <Info
          label={`${label} history`}
          text={`Every accepted attestation, plotted at its signed time (UTC). Gaps are real: updates are bought on demand, not pushed on a clock. Stale after ${live.maxAge}s.`}
        />
      </figcaption>
      <details>
        <summary>Accepted update values</summary>
        <ul className="point-list">
          {points.map((p) => (
            <li key={p.id}>
              {new Date(p.time * 1000).toISOString()} · {fmt(p.value, 18, 8)}
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
}

export function WorkChart({ s }: { s?: Snapshot }) {
  const minted = s?.v.totalEarned as bigint | undefined,
    ceiling = shownEarnLine(s?.v).value;
  if (minted === undefined || ceiling === undefined)
    return <Unavailable>Could not read work ceiling headroom.</Unavailable>;
  const max = minted > ceiling ? minted : ceiling;
  const fraction = (value: bigint) =>
    max ? (Number(value) / Number(max)) * 100 : 0;
  return (
    <figure className="mini-chart work-chart">
      <figcaption>Work ceiling headroom</figcaption>
      <div
        className="bar"
        role="img"
        aria-label={`${fmt(minted)} ${unit()} minted against ${fmt(ceiling)} ${unit()} ceiling`}
      >
        <span
          className={`bar-fill ${minted > ceiling ? "over-limit" : ""}`}
          style={{ width: `${fraction(minted)}%` }}
        />
        <i className="bar-marker" style={{ left: `${fraction(ceiling)}%` }} />
      </div>
      <p className={minted > ceiling ? "micro danger-text" : "micro"}>
        <Ticker
          text={
            minted > ceiling
              ? `${money(minted - ceiling)} over ceiling`
              : `${money(ceiling - minted)} available`
          }
        />
      </p>
    </figure>
  );
}

export function SupplyChart({ s }: { s?: Snapshot }) {
  const v = s?.v;
  // Secured collateral is in raw collateral units; the vault values it at its collateral price.
  const usd = s?.feeds.Collateral;
  if (
    !v ||
    [
      v.supply,
      v.totalDebt,
      v.totalEarned,
      v.totalNonPrincipalRedeemed,
      v.reserveValue,
      v.securedCollateral,
      v.mat,
      v.totalBadDebt,
    ].some((x) => x === undefined) ||
    !usd?.value
  )
    return (
      <Unavailable>Could not read supply composition and backing.</Unavailable>
    );
  const supply = v.supply as bigint;
  const debt = v.totalDebt as bigint,
    minted = v.totalEarned as bigint,
    burns = v.totalNonPrincipalRedeemed as bigint;
  const collateral = v.securedCollateral as bigint,
    badDebt = v.totalBadDebt as bigint,
    minCR = v.mat as bigint;
  const reserveValue = v.reserveValue as bigint;
  if (debt + minted - burns !== supply)
    return (
      <Unavailable>
        Supply accounting did not reconcile. Refresh state to retry.
      </Unavailable>
    );
  const principal = debt < supply ? debt : supply;
  const work = supply - principal;
  const secured = (collateral * usd.value) / WAD;
  const backedPrincipal = debt > badDebt ? debt - badDebt : 0n;
  const cap = (backedPrincipal * minCR) / 100n;
  const backing = reserveValue + (secured < cap ? secured : cap);
  const ratio = supply ? Number(backing) / Number(supply) : 0;
  const domain = Math.max(1.25, ratio * 1.1);
  return (
    <figure className="mini-chart supply-chart">
      <figcaption className="figure-head">
        Supply · <Ticker text={`${money(supply)}`} />
        <Info
          label="Supply composition"
          text={`■ collateral-backed principal (capped at supply) and ▨ net work-issued ${unit()}. Solid marker = backing ratio, dashed = par.`}
        />
      </figcaption>
      <div
        className="bar composition"
        role="img"
        aria-label={`${fmt(principal)} ${unit()} collateral principal, ${fmt(work)} ${unit()} net work. Backing ${supply ? (ratio * 100).toFixed(1) + "%" : "undefined: zero supply"}`}
      >
        <span
          className="collateral-fill"
          style={{
            width: `${supply ? (Number(principal) / Number(supply)) * 100 : 0}%`,
          }}
        />
        <span
          className="work-fill"
          style={{
            width: `${supply ? (Number(work) / Number(supply)) * 100 : 0}%`,
          }}
        />
        <i
          className="par-marker"
          style={{ left: `${100 / domain}%` }}
          title="Par: 100% backing"
        />
        {supply > 0n && (
          <i
            className="backing-marker"
            style={{ left: `${(ratio / domain) * 100}%` }}
            title={`${(ratio * 100).toFixed(1)}% backing`}
          />
        )}
      </div>
      <p className="composition-legend">
        <span>■ Collateral {fmt(principal)}</span>
        <span>▨ Net work {fmt(work)}</span>
      </p>
      <div className="row">
        <span>
          Backing ratio
          <Info
            label="Backing ratio"
            text={`Reserve value + secured collateral at the live USD price, capped at (principal − bad debt) × minCR, over supply. Bar scale 0–${(domain * 100).toFixed(0)}%. A point-in-time ratio, not a promise of redeemability.`}
          />
        </span>
        <strong>
          <Ticker text={supply ? `${(ratio * 100).toFixed(1)}%` : "—"} />
          {usd.stale && <span className="muted"> · USD stale</span>}
        </strong>
      </div>
    </figure>
  );
}
