// imdusd.com/stats/: the protocol at a glance, every figure read live from the chain (and IdentityMD's public API
// for the swarm strip). Built only where the terminal is (site.tsx TERMINAL). A plain-language "right now" line and six
// vital signs lead; each panel below is the evidence for one of them, and each loads and fails on its own.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress } from "viem";
import {
  dayOf,
  feedUpdates,
  pegHistory,
  pegStats,
  readFloor,
  readSwarm,
  redemptionHistory,
  redemptionValue,
  REQUEST_IMD,
  settingEvents,
  tokenLedger,
  treasuryHoldings,
  vaultEvents,
  type FeedUpdates,
  type RedeemPoint,
} from "./analytics-data";
import { DayBars, HBars, PEG_CHART_W, PegChart, pegChartHeight, ShareBar, Spark, StressPlot, utcShort, type DayCol } from "./AnalyticsCharts";
import { loadConfig, pointsConfig, type Runtime } from "./config";
import { ensName, useEns } from "./ens";
import { describePending } from "./governance";
import { loanBook, type History } from "./history";
import { everyVisible } from "./infer/visible";
import { useMarket } from "./market";
import { message } from "./math";
import { usePegPrice } from "./peg-price";
import { SiteFooter, SiteHeader, href } from "./site";
import { snapshot, type Snapshot } from "./state";

type Load<T> = { data?: T; error?: string };
/** Runs `fn` whenever `key` changes, keeping the last good result if a later run fails. */
function useLoad<T>(fn: (() => Promise<T>) | undefined, key: unknown): Load<T> {
  const [st, setSt] = useState<Load<T>>({});
  useEffect(() => {
    if (!fn) return;
    let live = true;
    fn()
      .then((data) => live && setSt({ data }))
      .catch((e) => live && setSt((old) => ({ data: old.data, error: message(e) })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!fn]);
  return st;
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const nameOf = (a: string) => ensName(a) ?? short(a);
const whole = (v: number) => Math.round(v).toLocaleString("en-US");
const usd = (v: number, places = 2) => `$${v.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : undefined);
const DUST = 15;
const DAY = 86_400;

export function Analytics() {
  const [r, setR] = useState<Runtime>();
  const [fatal, setFatal] = useState<string>();
  const [s, setS] = useState<Snapshot>();
  useEffect(() => {
    loadConfig().then(setR, (e) => setFatal(message(e)));
  }, []);
  useEffect(() => {
    if (!r) return;
    let live = true;
    const tick = () =>
      snapshot(r)
        .then((x) => live && setS(x))
        .catch((e) => live && setFatal(message(e)));
    tick();
    const stop = everyVisible(tick, 60_000);
    return () => {
      live = false;
      stop();
    };
  }, [r]);

  const market = useMarket();
  const livePeg = usePegPrice();
  const block = s?.block;
  const ready = r && s;
  const peg = useLoad(ready ? () => pegHistory(r, Number(s.block)) : undefined, block);
  const feeds = useLoad(ready ? () => feedUpdates(r, s) : undefined, block);
  const book = useLoad(ready ? () => loanBook(r, s) : undefined, block);
  const floor = useLoad(ready ? () => readFloor(r, s) : undefined, block);
  // Hourly samples: re-read once an hour of blocks has passed, not every snapshot.
  const redeemHist = useLoad(ready && peg.data ? () => redemptionHistory(r, s, peg.data!.firstBlock) : undefined, block !== undefined && peg.data ? `${block / 300n}` : undefined);
  const ledger = useLoad(ready ? () => tokenLedger(r, s) : undefined, block);
  const events = useLoad(ready ? () => vaultEvents(r, s) : undefined, block);
  const settings = useLoad(ready ? () => settingEvents(r, s) : undefined, block);
  const treasury = useLoad(ready ? () => treasuryHoldings(r, s, market?.imdUsd) : undefined, `${block}-${!!market}`);
  // The swarm strip changes slowly and reads a week of logs: once per ~10 minutes of blocks.
  const swarm = useLoad(ready ? () => readSwarm(r, s) : undefined, block !== undefined ? block / 50n : undefined);

  const now = Number(s?.timestamp ?? BigInt(Math.floor(Date.now() / 1000)));
  const pegNow = livePeg ?? peg.data?.points.at(-1)?.price;
  const redeem = floor.data && market ? redemptionValue(floor.data, market.imdUsd, s?.feeds.USD?.value) : undefined;
  const loans = useMemo(() => {
    if (!book.data || !s) return [];
    const col = s.feeds.Collateral?.value ?? 0n;
    return book.data.positions
      .map((p) => ({ owner: p.owner as string, debt: Number(p.debt) / 1e18, cr: Number(p.cr), usd: Number((p.collateral * col) / 10n ** 18n) / 1e18 }))
      .sort((a, b) => b.debt - a.debt);
  }, [book.data, s]);
  useEns([...loans.slice(0, 12).map((l) => l.owner), ...(ledger.data?.holders.slice(0, 4).map((h) => h.address) ?? [])]);
  const totalDebt = loans.reduce((a, l) => a + l.debt, 0);
  const systemCr = totalDebt ? (loans.reduce((a, l) => a + l.usd, 0) / totalDebt) * 100 : undefined;
  const top = loans[0];
  const feedAge = s ? now - Math.min(Number(s.feeds.PriceFeed?.updated ?? 0n), Number(s.feeds.SpotFeed?.updated ?? 0n)) : undefined;
  const feedsStale = !!(s?.feeds.PriceFeed?.stale || s?.feeds.SpotFeed?.stale);
  const priceFeed = feeds.data?.find((f) => f.name === "price");
  const fresh7 = priceFeed ? freshShare(priceFeed, now - 7 * DAY, now) : undefined;
  const sinceLaunch = peg.data ? pegStats(peg.data.points, peg.data.points[0].t, now) : undefined;
  const wage = num(s?.work.wage ?? s?.v.wage);
  const mat = num(s?.v.mat) ?? 170;

  if (fatal && !s)
    return (
      <Shell>
        <p className="an-error">The chain could not be read: {fatal} Reload to try again.</p>
      </Shell>
    );

  return (
    <Shell asOf={s ? `block ${Number(s.block).toLocaleString("en-US")} · ${utcShort(Number(s.timestamp))} UTC` : "reading the chain…"}>
      <section className="an-now" aria-labelledby="an-now-h">
        <h2 className="section-label" id="an-now-h">
          Right now
        </h2>
        <p className="an-lead">{lead(pegNow, redeem, feedsStale, feedAge)}</p>
        <div className="an-vitals">
          <Vital
            label="Peg pool price"
            value={pegNow !== undefined ? `$${pegNow.toFixed(3)}` : "…"}
            sev={pegNow === undefined ? "off" : Math.abs(pegNow - 1) > 0.02 ? "critical" : Math.abs(pegNow - 1) > 0.01 ? "warn" : "good"}
            pill={pegNow === undefined ? "Reading" : Math.abs(pegNow - 1) > 0.01 ? "Off peg" : "On peg"}
            note={sinceLaunch ? `Below $0.99 for ${(sinceLaunch.below / 3600).toFixed(1)} h since launch` : "Since launch: reading"}
          />
          <Vital
            label="Redemption value"
            value={redeem !== undefined ? `$${redeem.toFixed(2)}` : "…"}
            sev={redeem === undefined || pegNow === undefined ? "off" : redeem < pegNow - 0.02 ? "critical" : redeem < pegNow ? "warn" : "good"}
            pill={redeem === undefined || pegNow === undefined ? "Reading" : redeem < pegNow ? "Below pool" : "Defends peg"}
            note={floor.data ? `per imdUSD, after a ${(Number(floor.data.feeBps) / 100).toFixed(2)}% fee` : "per imdUSD"}
          />
          <Vital
            label="Price feeds"
            value={feedAge !== undefined ? ageText(feedAge) : "…"}
            sev={!s ? "off" : feedsStale ? "warn" : "good"}
            pill={!s ? "Reading" : feedsStale ? "Stale" : "Fresh"}
            note={fresh7 !== undefined ? `Fresh ${fresh7}% of the last 7 days` : "Freshness: reading"}
          />
          <Vital
            label="System collateral ratio"
            value={systemCr !== undefined ? `${Math.round(systemCr)}%` : "…"}
            sev={systemCr === undefined ? "off" : systemCr < mat + 30 ? "critical" : systemCr < mat + 80 ? "warn" : "good"}
            pill={systemCr === undefined ? "Reading" : systemCr < mat + 30 ? "Thin" : systemCr < mat + 80 ? "Watch" : "Healthy"}
            note={`Minimum ${mat}% · bad debt ${whole(Number(s?.v.totalBadDebt ?? 0n) / 1e18)}`}
          />
          <Vital
            label="Largest borrower"
            value={top ? `${Math.round((top.debt / totalDebt) * 100)}%` : "…"}
            sev={!top ? "off" : top.debt / totalDebt > 0.5 ? "warn" : "good"}
            pill={!top ? "Reading" : top.debt / totalDebt > 0.5 ? "Concentrated" : "Spread"}
            note={loans.length >= 3 ? `of all debt · top 3 owe ${Math.round((loans.slice(0, 3).reduce((a, l) => a + l.debt, 0) / totalDebt) * 100)}%` : "of all debt"}
          />
          <Vital
            label="Minting from work"
            value={wage === undefined ? "…" : wage === 0 ? "Off" : "On"}
            sev={wage === undefined || wage === 0 ? "off" : "good"}
            pill={wage === undefined ? "Reading" : wage === 0 ? "wage 0" : "wage set"}
            note={`${whole(Number(s?.v.totalEarned ?? 0n) / 1e18)} imdUSD minted from work`}
          />
        </div>
      </section>

      <PegPanel peg={peg} feeds={feeds.data} now={now} pegNow={pegNow} redeem={redeemLine(redeemHist.data, redeem, now)} lanes={s ? ["PriceFeed", "SpotFeed"].filter((k) => s.targets[k]).length : 2} />

      <div className="an-grid2">
        <Panel title="Redemption floor" sub="What 1 imdUSD is worth, three ways" load={floor} wait={floorWait}>
          {floor.data && s && pegNow !== undefined && redeem !== undefined && market ? (
            <FloorBody floor={floor.data} s={s} pegNow={pegNow} redeem={redeem} marketImdUsd={market.imdUsd} />
          ) : (
            floorWait("Reading the market price…")
          )}
        </Panel>
        <Panel title="Price updates" sub="Accepted answers per day, last 7 days" load={feeds} wait={updatesWait}>
          {feeds.data && s && <UpdatesBody feeds={feeds.data} s={s} now={now} />}
        </Panel>
      </div>

      <Panel title="Loan book over time" sub="Debt outstanding and collateral locked at each day's end" load={ledger}>
        {ledger.data && (
          <div className="an-grid2 an-flat">
            <figure className="an-fig">
              <figcaption>Debt, imdUSD</figcaption>
              <DayBars
                label="imdUSD supply at each day's end"
                unit={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`)}
                cols={ledger.data.days.map((d, i, a) => ({
                  day: d.day,
                  parts: [{ v: d.supply, tone: i === a.length - 1 ? "ink" : "muted", title: `${d.day}: ${whole(d.supply)} imdUSD (+${whole(d.minted)} drawn, −${whole(d.burned)} repaid)` }],
                  label: i === a.length - 1 || i === 0 ? whole(d.supply) : undefined,
                }))}
              />
            </figure>
            <figure className="an-fig">
              <figcaption>Collateral locked, sIMD</figcaption>
              {events.data && s ? (
                <DayBars label="sIMD locked in the vault at each day's end" unit={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`)} cols={collateralDays(events.data, Number(s.v.gemDecimals ?? 18), now)} />
              ) : (
                <p className="an-quiet">{events.error ?? "Reading vault history…"}</p>
              )}
            </figure>
          </div>
        )}
        <p className="an-src">imdUSD Transfer replay{ledger.data ? ` (${whole(ledger.data.supply)} imdUSD outstanding)` : ""} · the vault's Lock and Free logs</p>
      </Panel>

      <StressPanel loans={loans} mat={mat} redeemable={num(s?.v.redemptionCeilingCR) ?? 220} load={book} />

      <div className="an-grid2">
        <Panel title="Who owes it" sub="Debt by borrower, with collateral ratio" load={book}>
          {loans.length > 0 && (
            <HBars
              label={`The largest borrower owes ${Math.round((loans[0].debt / totalDebt) * 100)}% of imdUSD debt`}
              max={loans[0].debt}
              noteHead="CR"
              rows={[
                ...loans.slice(0, 3).map((l, i) => ({
                  label: nameOf(l.owner),
                  value: l.debt,
                  text: `${Math.round((l.debt / totalDebt) * 100)}%`,
                  tone: i === 0 ? ("ink" as const) : ("muted" as const),
                  note: `${l.cr}%`,
                  title: `${l.owner}: ${whole(l.debt)} imdUSD at ${l.cr}%`,
                })),
                ...(loans.length > 3
                  ? [{ label: `${loans.length - 3} others`, value: loans.slice(3).reduce((a, l) => a + l.debt, 0), text: `${Math.round((loans.slice(3).reduce((a, l) => a + l.debt, 0) / totalDebt) * 100)}%`, note: "–" }]
                  : []),
              ]}
            />
          )}
          <p className="an-src">
            {loans.length} loans with debt · {whole(totalDebt)} imdUSD
            {book.data && <> · {historyNote(book.data.history)}</>}
          </p>
        </Panel>
        <Panel title="Where imdUSD sits" sub={ledger.data ? `${ledger.data.holders.length} holders` : "Holders"} load={ledger}>
          {ledger.data && s && <ShareBar label="Where imdUSD is held" parts={holderParts(ledger.data.holders, s)} />}
        </Panel>
      </div>

      <EventsPanel events={events} settings={settings} peg={peg.data?.points} />

      <div className="an-grid2">
        <Panel title="Treasury" sub={s?.targets.treasury ? short(s.targets.treasury.address) : ""} load={treasury}>
          {treasury.data && (
            <div className="table-scroll">
              <table className="an-table">
                <thead>
                  <tr>
                    <th>Holding</th>
                    <th className="an-r">Amount</th>
                    <th className="an-r">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {treasury.data.map((h) => (
                    <tr key={h.symbol}>
                      <td>{h.symbol}</td>
                      <td className="an-r">{h.amount >= 1e6 ? `${(h.amount / 1e6).toFixed(1)}M` : h.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                      <td className="an-r">{h.usd !== undefined ? usd(h.usd, 0) : <span className="an-quiet">not valued</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="an-quiet">The reserve counts toward backing only while the sIMD price is fresh{s && s.v.reserveValue === 0n ? "; right now it reads $0 on chain." : "."}</p>
        </Panel>
        <Panel title="Settings" sub="Changed only through a 48-hour timelock" load={{ data: s }}>
          {s && <SettingsBody s={s} />}
        </Panel>
      </div>

      <SwarmPanel swarm={swarm} imdUsd={market ? Number(market.imdUsd) / 1e18 : undefined} />
    </Shell>
  );
}

/** Where the loan book's history came from: the public index (imdusd.com/api/v1) up to a block, or the chain. */
export function historyNote(h: History): string {
  return h.source === "Index" && h.index !== undefined ? `history via index, through block ${h.index.toLocaleString("en-US")}` : "history via chain";
}

/* ---------- page parts ---------- */

function Shell({ children, asOf }: { children: ReactNode; asOf?: string }) {
  return (
    <div className="site">
      <SiteHeader page="analytics" />
      <main className="analytics">
        <header className="an-head">
          <div>
            <p className="micro">Ethereum mainnet · live</p>
            <h1>imdUSD Analytics</h1>
          </div>
          {asOf && <p className="an-asof">{asOf}</p>}
        </header>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

/** A chart's empty frame at the size the chart will have (its viewBox), with a reading note over it: what a panel in
 * the first screens shows until its data arrives, so the panels under it do not move down when it does. */
function ChartWait({ w, h, note, scroll }: { w: number; h: number; note: string; scroll?: boolean }) {
  return (
    <div className={scroll ? "an-chart an-wait" : "an-wait"}>
      <svg viewBox={`0 0 ${w} ${h}`} className="an-svg" aria-hidden="true" />
      <p className="an-quiet">{note}</p>
    </div>
  );
}

function Panel({ title, sub, load, wait, children }: { title: string; sub?: string; load: Load<unknown>; wait?: (note: string) => ReactNode; children?: ReactNode }) {
  return (
    <section className="an-panel" aria-label={title}>
      <div className="an-panel-head">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {load.data === undefined ? (
        load.error || !wait ? <p className="an-quiet">{load.error ? `Could not read this: ${load.error}` : "Reading the chain…"}</p> : wait("Reading the chain…")
      ) : (
        children
      )}
      {load.data !== undefined && load.error && <p className="an-quiet">Showing the last good read; the latest failed: {load.error}</p>}
    </section>
  );
}

function Vital({ label, value, sev, pill, note }: { label: string; value: string; sev: "good" | "warn" | "critical" | "off"; pill: string; note: string }) {
  return (
    <div className={`an-vital an-sev-${sev}`}>
      <span className="an-vital-label">{label}</span>
      <span className="an-vital-value">{value}</span>
      <span className="an-pill">{pill}</span>
      <span className="an-vital-note">{note}</span>
    </div>
  );
}

function lead(peg: number | undefined, redeem: number | undefined, stale: boolean, age: number | undefined) {
  if (peg === undefined) return "Reading the peg pool and the vault…";
  const parts = [
    peg < 0.99
      ? `imdUSD trades at $${peg.toFixed(3)}, below its $0.99–$1.01 band.`
      : peg > 1.01
        ? `imdUSD trades at $${peg.toFixed(3)}, above its $0.99–$1.01 band.`
        : `imdUSD trades at $${peg.toFixed(3)}, inside its $0.99–$1.01 band.`,
  ];
  if (stale && age !== undefined) parts.push(`The price feeds are ${ageText(age)} old, so new borrowing is paused and the payout price is held.`);
  if (redeem !== undefined)
    parts.push(redeem < peg ? `Redeeming returns about $${redeem.toFixed(2)} per imdUSD, less than the pool pays, so redemption is not defending the price yet.` : `Redeeming returns about $${redeem.toFixed(2)} per imdUSD.`);
  return parts.join(" ");
}
function ageText(sec: number) {
  return sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : sec < 2 * DAY ? `${(sec / 3600).toFixed(1)} h` : `${Math.round(sec / DAY)} days`;
}
function freshShare(f: FeedUpdates, t0: number, t1: number) {
  let secs = 0;
  f.times.forEach((u, i) => {
    const a = Math.max(u, t0),
      b = Math.min(u + f.maxAge, f.times[i + 1] ?? Infinity, t1);
    if (b > a) secs += b - a;
  });
  return Math.round((secs / (t1 - t0)) * 100);
}
function Fig({ k, v }: { k: string; v: string }) {
  return (
    <div className="an-figure">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

const RANGES = [
  { id: "24h", label: "24 h", secs: DAY },
  { id: "3d", label: "3 days", secs: 3 * DAY },
  { id: "all", label: "Since launch", secs: 0 },
];
function readRange() {
  try {
    return localStorage.getItem("analytics-range") ?? "24h";
  } catch {
    return "24h";
  }
}
/** The sampled history with the live figure (the "Redemption value" tile's) as its last point. */
function redeemLine(hist: RedeemPoint[] | undefined, live: number | undefined, now: number): RedeemPoint[] | undefined {
  if (!hist) return undefined;
  return live === undefined ? hist : [...hist.filter((p) => p.t < now), { t: now, value: live, block: Infinity }];
}
function PegPanel({ peg, feeds, now, pegNow, lanes, redeem }: { peg: Load<Awaited<ReturnType<typeof pegHistory>>>; feeds?: FeedUpdates[]; now: number; pegNow?: number; lanes: number; redeem?: RedeemPoint[] }) {
  const [range, setRange] = useState(readRange);
  // The redemption line is off until asked for: it sits far under the peg while the payout price catches up, and
  // drawn by default it reads as the price of imdUSD. Its legend key turns it on and off.
  const [showRedeem, setShowRedeem] = useState(false);
  const pick = (id: string) => {
    setRange(id);
    try {
      localStorage.setItem("analytics-range", id);
    } catch {
      /* the choice just isn't remembered */
    }
  };
  const points = peg.data?.points;
  const first = points?.[0]?.t ?? now - DAY;
  const secs = RANGES.find((x) => x.id === range)?.secs ?? DAY;
  const t0 = secs ? Math.max(first, now - secs) : first;
  const st = points ? pegStats(points, t0, now) : undefined;
  const price = feeds?.find((f) => f.name === "price");
  return (
    <section className="an-panel" aria-label="Peg">
      <div className="an-panel-head">
        <h2>Peg</h2>
        <div className="an-seg" role="group" aria-label="Time range">
          {RANGES.map((x) => (
            <button key={x.id} type="button" aria-pressed={range === x.id} onClick={() => pick(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {/* The chart's frame, legend and figures are drawn before the swaps are read, at their final size: the panel
          sits in the first screen on a desktop and would push everything under it down when the chart arrives. */}
      {!points || !st ? (
        <ChartWait scroll w={PEG_CHART_W} h={pegChartHeight(lanes)} note={peg.error ? `Could not read the peg pool: ${peg.error}` : "Reading the peg pool…"} />
      ) : (
        <div className="an-chart" tabIndex={0} role="region" aria-label="Peg chart, scrolls sideways on small screens">
          <PegChart points={points} feeds={feeds ?? []} t0={t0} t1={now} now={pegNow ?? st.now} minLanes={feeds ? 0 : lanes} redeem={showRedeem ? redeem : undefined} />
        </div>
      )}
      <ul className="an-legend">
        <li>
          <i className="an-key-line" />
          pool price, USDC per imdUSD
        </li>
        <li>
          <button type="button" className="an-legend-toggle" aria-pressed={showRedeem} onClick={() => setShowRedeem((v) => !v)} title={showRedeem ? "Hide the redemption line" : "Show the redemption line"}>
            <i className="an-key-redeem" />
            redemption value: what redeeming 1 imdUSD returns at IMD's market price{showRedeem && !redeem ? " (reading…)" : ""}
          </button>
        </li>
        <li>
          <i className="an-key-band" />
          peg band $0.99–$1.01
        </li>
        <li>
          <i className="an-key-fresh" />
          feed fresh
        </li>
        <li>
          <i className="an-key-stale" />
          feed stale: new borrowing paused, payout price held
        </li>
      </ul>
      <dl className="an-figs">
        <Fig k="Time-weighted average" v={st ? `$${st.twap.toFixed(3)}` : "…"} />
        <Fig k="Time below $0.99" v={st ? `${(st.below / 3600).toFixed(1)} h` : "…"} />
        <Fig k="Lowest" v={st ? `$${st.low.price.toFixed(3)}` : "…"} />
        <Fig k="Swaps" v={st ? whole(st.inside.length) : "…"} />
        {(price || !feeds) && <Fig k="Price feed fresh" v={price && st ? `${freshShare(price, t0, now)}%` : "…"} />}
      </dl>
      <p className="an-src">Swap logs of the imdUSD/USDC pool {short(pointsConfig.pegPools[1]?.poolId ?? "0x0000000000")} · ValueUpdated logs of the price and spot feeds · the vault's payout price, fee and backing, sampled hourly (4-hourly before the last 3 days)</p>
    </section>
  );
}

function FloorBody({ floor, s, pegNow, redeem, marketImdUsd }: { floor: Awaited<ReturnType<typeof readFloor>>; s: Snapshot; pegNow: number; redeem: number; marketImdUsd: bigint }) {
  const dec = Number(s.v.gemDecimals ?? 18);
  const perShare = (v: bigint) => (Number(v) / 1e18) * 10 ** (dec - 18);
  const paid = floor.payoutPrice > floor.attested ? floor.payoutPrice : floor.attested;
  const attestedImd = s.feeds.USD?.value;
  const market = attestedImd ? perShare(floor.attested) * (Number(marketImdUsd) / Number(attestedImd)) : undefined;
  const payout = perShare(paid);
  const hours = market !== undefined && payout > market ? Math.log(market / payout) / Math.log(0.99) : 0;
  return (
    <>
      <HBars
        label={`Redemption pays $${redeem.toFixed(2)} per imdUSD; the pool pays $${pegNow.toFixed(3)}; par is $1`}
        max={1}
        rows={[
          { label: "Par", value: 1, text: "$1.000" },
          { label: "Pool price", value: pegNow, text: `$${pegNow.toFixed(3)}`, tone: "ink" },
          { label: "Redemption value", value: redeem, text: `$${redeem.toFixed(3)}`, tone: redeem < pegNow ? "danger" : "ink" },
        ]}
      />
      <p className="an-body">
        Redeemers are paid in sIMD at <span className="an-num">{usd(payout)}</span> per sIMD
        {market !== undefined && (
          <>
            , while sIMD trades at <span className="an-num">{usd(market)}</span>
          </>
        )}
        . {hours > 0.5 ? `The payout price falls at most 1% per fresh hour, so about ${Math.ceil(hours)} fresh hours close the gap.` : "The payout price is at the market."}
      </p>
    </>
  );
}

/** FloorBody's bars (HBars, three rows) and its two-line note, before the floor is read. */
function floorWait(note: string) {
  return (
    <>
      <ChartWait w={520} h={24 + 3 * 34} note={note} />
      <p className="an-body an-wait-lines" aria-hidden="true" />
    </>
  );
}
/** UpdatesBody's frame: its bars, legend and figures, before the feeds' logs are read. */
function updatesWait(note: string) {
  return (
    <>
      <ChartWait w={520} h={190} note={note} />
      <ul className="an-legend">
        <li>
          <i className="an-key-ink" />
          price feed
        </li>
        <li>
          <i className="an-key-muted" />
          spot and health feeds
        </li>
      </ul>
      <dl className="an-figs">
        <Fig k="Updates since launch" v="…" />
        <Fig k="Each bought for" v={`${REQUEST_IMD} IMD`} />
        <Fig k="Stability fees per day" v="…" />
      </dl>
    </>
  );
}

function UpdatesBody({ feeds, s, now }: { feeds: FeedUpdates[]; s: Snapshot; now: number }) {
  const today = Math.floor(now / DAY) * DAY;
  const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * DAY);
  const count = (name: string, t0: number) => feeds.find((f) => f.name === name)?.times.filter((t) => t >= t0 && t < t0 + DAY).length ?? 0;
  const cols: DayCol[] = days.map((t0) => ({
    day: dayOf(t0),
    parts: [
      { v: count("price", t0), tone: "ink", title: `${dayOf(t0)}: ${count("price", t0)} price updates` },
      { v: count("spot", t0) + count("health", t0), tone: "muted", title: `${dayOf(t0)}: ${count("spot", t0)} spot, ${count("health", t0)} health updates` },
    ],
  }));
  const total = feeds.reduce((a, f) => a + f.times.length, 0);
  const debt = Number(s.v.totalDebt ?? 0n) / 1e18;
  const duty = Number(s.v.duty ?? 0n) / 10_000;
  return (
    <>
      <DayBars label="Price updates per day, last 7 days" unit={(v) => `${Math.round(v)}`} cols={cols} height={190} />
      <ul className="an-legend">
        <li>
          <i className="an-key-ink" />
          price feed
        </li>
        <li>
          <i className="an-key-muted" />
          spot and health feeds
        </li>
      </ul>
      <dl className="an-figs">
        <Fig k="Updates since launch" v={whole(total)} />
        <Fig k="Each bought for" v={`${REQUEST_IMD} IMD`} />
        <Fig k="Stability fees per day" v={usd((debt * duty) / 365)} />
      </dl>
    </>
  );
}

function collateralDays(events: Awaited<ReturnType<typeof vaultEvents>>, dec: number, now: number): DayCol[] {
  // Lock adds collateral and Free removes it. A liquidation's seizure is not in these rows (Bite's logged amount is the
  // debt it repaid), which is why the caption says "locked".
  const sorted = [...events].sort((a, b) => a.t - b.t);
  if (!sorted.length) return [];
  let level = 0,
    i = 0;
  const out: DayCol[] = [];
  for (let t0 = Math.floor(sorted[0].t / DAY) * DAY; t0 <= now; t0 += DAY) {
    for (; i < sorted.length && sorted[i].t < t0 + DAY; i++) {
      const e = sorted[i];
      if (e.amount === undefined) continue;
      if (e.name === "Lock") level += Number(e.amount) / 10 ** dec;
      if (e.name === "Free") level -= Number(e.amount) / 10 ** dec;
    }
    const last = t0 + DAY > now;
    out.push({ day: dayOf(t0), parts: [{ v: Math.max(0, level), tone: last ? "ink" : "muted", title: `${dayOf(t0)}: ${whole(level)} sIMD locked` }], label: last ? whole(level) : undefined });
  }
  return out;
}

function StressPanel({ loans, mat, redeemable, load }: { loans: { owner: string; debt: number; cr: number }[]; mat: number; redeemable: number; load: Load<unknown> }) {
  const [fall, setFall] = useState(0);
  const real = loans.filter((l) => l.debt >= DUST);
  const after = real.map((l) => ({ ...l, nc: l.cr * (1 - fall / 100) }));
  const bad = after.filter((l) => l.nc < mat);
  const badDebt = bad.reduce((a, l) => a + l.debt, 0);
  const total = real.reduce((a, l) => a + l.debt, 0);
  const crAfter = total ? after.reduce((a, l) => a + l.debt * l.nc, 0) / total : 0;
  const redeemableDebt = after.filter((l) => l.nc >= mat && l.nc <= redeemable).reduce((a, l) => a + l.debt, 0);
  return (
    <Panel title="Stress test" sub={`If IMD fell now, which loans would drop under ${mat}%?`} load={load}>
      <div className="an-stress-ctl">
        <label htmlFor="an-fall">IMD price fall</label>
        <input id="an-fall" type="range" min={0} max={70} step={1} value={fall} onChange={(e) => setFall(Number(e.target.value))} />
        <output htmlFor="an-fall">{fall}%</output>
      </div>
      <div className="an-chart" tabIndex={0} role="region" aria-label="Stress chart, scrolls sideways on small screens">
        <StressPlot loans={real.map((l) => ({ name: nameOf(l.owner), debt: l.debt, cr: l.cr }))} fall={fall} mat={mat} redeemable={redeemable} />
      </div>
      <dl className="an-figs">
        <Fig k={`Loans under ${mat}%`} v={`${bad.length} of ${real.length}`} />
        <Fig k="Their debt" v={`${whole(badDebt)} imdUSD`} />
        <Fig k="Share of all debt" v={`${total ? Math.round((badDebt / total) * 100) : 0}%`} />
        <Fig k="Debt-weighted CR" v={`${Math.round(crAfter)}%`} />
        <Fig k={`Redeemable, ${mat}–${redeemable}%`} v={`${whole(redeemableDebt)} imdUSD`} />
      </dl>
      <p className="an-src">Loans of {DUST} imdUSD or more, at today's collateral ratio scaled by the fall. Ignores the grace period and any top-ups.</p>
    </Panel>
  );
}

function holderParts(holders: { address: string; balance: number }[], s: Snapshot) {
  const pm = (pointsConfig.poolManagers[1] ?? "").toLowerCase();
  const treasury = s.targets.treasury?.address.toLowerCase();
  const parts: { label: string; value: number }[] = [];
  let other = 0,
    named = 0;
  for (const h of holders) {
    const a = h.address.toLowerCase();
    if (a === pm) parts.push({ label: "Uniswap v4 pools", value: h.balance });
    else if (a === treasury) parts.push({ label: "Treasury", value: h.balance });
    else if (named < 2) {
      parts.push({ label: nameOf(h.address), value: h.balance });
      named++;
    } else other += h.balance;
  }
  if (other) parts.push({ label: "Other wallets", value: other });
  return parts.sort((a, b) => b.value - a.value);
}

type Row = { t: number; kind: "borrow" | "liq" | "peg" | "gov" | "redeem"; title: string; what: string; amount?: number; tx?: string };
const KIND_LABEL: Record<Row["kind"], string> = { borrow: "Borrowing", liq: "Liquidation", peg: "Peg", gov: "Settings", redeem: "Redemption" };
const FILTERS = [
  { id: "all", label: "All" },
  { id: "borrow", label: "Borrowing" },
  { id: "liq", label: "Liquidations" },
  { id: "peg", label: "Peg" },
  { id: "gov", label: "Settings" },
] as const;
function EventsPanel({ events, settings, peg }: { events: Load<Awaited<ReturnType<typeof vaultEvents>>>; settings: Load<Awaited<ReturnType<typeof settingEvents>>>; peg?: { t: number; price: number }[] }) {
  const [f, setF] = useState<string>("all");
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const e of events.data ?? []) {
      const amt = e.amount !== undefined ? Number(e.amount) / 1e18 : undefined;
      if ((e.name === "Draw" || e.name === "Wipe") && amt !== undefined && amt >= 1000)
        out.push({ t: e.t, kind: "borrow", title: e.name === "Draw" ? "Draw" : "Repay", what: e.who ? nameOf(e.who) : "", amount: e.name === "Draw" ? amt : -amt, tx: e.tx });
      if (e.name === "Bite") out.push({ t: e.t, kind: "liq", title: "Liquidation", what: `${e.who ? nameOf(e.who) : "A loan"} liquidated${e.by ? ` by ${nameOf(getAddress(e.by))}` : ""}`, amount: amt, tx: e.tx });
      if (e.name === "Cash") out.push({ t: e.t, kind: "redeem", title: "Redemption", what: e.who ? nameOf(e.who) : "", amount: amt, tx: e.tx });
    }
    for (const e of settings.data ?? []) {
      const p = e.payload ? describePending(e.payload, {}, "imdUSD") : undefined;
      const title = e.name === "Applied" ? "Change applied" : e.name === "Proposed" ? "Change proposed" : e.name === "Cancelled" ? "Change cancelled" : "Reserve asset";
      out.push({ t: e.t, kind: "gov", title, what: p?.title ?? e.detail ?? "", tx: e.tx });
    }
    if (peg?.length) {
      let below = false,
        low = Infinity;
      for (const p of peg) {
        if (!below && p.price < 0.99) {
          below = true;
          low = p.price;
          out.push({ t: p.t, kind: "peg", title: "Peg breaks", what: `Price falls to $${p.price.toFixed(3)}` });
        } else if (below && p.price >= 0.99) {
          below = false;
          out.push({ t: p.t, kind: "peg", title: "Peg restored", what: `Price back to $${p.price.toFixed(3)} (low $${low.toFixed(3)})` });
        } else if (below && p.price < low) low = p.price;
      }
    }
    return out.sort((a, b) => b.t - a.t);
  }, [events.data, settings.data, peg]);
  const shown = rows.filter((r) => f === "all" || r.kind === f || (f === "liq" && r.kind === "redeem")).slice(0, 120);
  return (
    <section className="an-panel" aria-label="Events">
      <div className="an-panel-head">
        <h2>Events</h2>
        <div className="an-seg" role="group" aria-label="Filter events">
          {FILTERS.map((x) => (
            <button key={x.id} type="button" aria-pressed={f === x.id} onClick={() => setF(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      {events.data === undefined ? (
        <p className="an-quiet">{events.error ? `Could not read vault history: ${events.error}` : "Reading vault history…"}</p>
      ) : (
        <div className="table-scroll an-log" tabIndex={0} role="region" aria-label="Event log">
          <table className="an-table">
            <thead>
              <tr>
                <th>Time, UTC</th>
                <th>Event</th>
                <th>What happened</th>
                <th className="an-r">imdUSD</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={`${r.t}-${i}`}>
                  <td className="an-when">{utcShort(r.t)}</td>
                  <td>
                    <span className={`an-tag an-tag-${r.kind}`}>{KIND_LABEL[r.kind]}</span> {r.title}
                  </td>
                  <td>
                    {r.tx ? (
                      <a href={`https://etherscan.io/tx/${r.tx}`} target="_blank" rel="noreferrer">
                        {r.what || "transaction"}
                      </a>
                    ) : (
                      r.what
                    )}
                  </td>
                  <td className="an-r">{r.amount === undefined ? "" : `${r.amount < 0 ? "−" : ""}${whole(Math.abs(r.amount))}`}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={4} className="an-quiet">
                    Nothing of this kind yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="an-src">Draws and repayments of 1,000 imdUSD or more, every liquidation and redemption, peg breaks below $0.99, settings changes.</p>
    </section>
  );
}

function SettingsBody({ s }: { s: Snapshot }) {
  const v = s.v;
  const pct = (x: unknown) => (num(x) !== undefined ? `${num(x)}%` : "—");
  const bps = (x: unknown) => (num(x) !== undefined ? `${(num(x)! / 100).toFixed(2)}%` : "—");
  const hrs = (x: unknown) => (num(x) !== undefined ? `${(num(x)! / 3600).toFixed(num(x)! % 3600 ? 1 : 0)} h` : "—");
  const pending = v.pendingChange ?? v.pending;
  const p = typeof pending === "string" ? describePending(pending as `0x${string}`, {}, "imdUSD") : undefined;
  const rows: [string, string][] = [
    ["Minimum collateral ratio", pct(v.mat)],
    ["Stability fee", `${bps(v.duty)} / yr`],
    ["Debt ceiling", v.line !== undefined ? whole(Number(v.line) / 1e18) : "—"],
    ["Loans redeemable at or below", pct(v.redemptionCeilingCR)],
    ["Price and spot may differ by", bps(v.skew)],
    ["Grace before liquidation", hrs(v.lull)],
    ["Price feeds' maximum age", s.feeds.PriceFeed ? hrs(s.feeds.PriceFeed.maxAge) : "—"],
    ["Pending change", p ? p.title : "none"],
  ];
  return (
    <div className="table-scroll">
      <table className="an-table">
        <tbody>
          {rows.map(([k, val]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="an-r">{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SwarmPanel({ swarm, imdUsd }: { swarm: Load<Awaited<ReturnType<typeof readSwarm>>>; imdUsd?: number }) {
  const d = swarm.data;
  const days = d?.days ?? [];
  const avgReq = days.length ? days.reduce((a, x) => a + x.requests, 0) / days.length : undefined;
  const avgImd = days.length ? days.reduce((a, x) => a + x.imd, 0) / days.length : undefined;
  return (
    <Panel title="The economy it serves" sub="IdentityMD's AI-agent swarm: paid work, last 7 full days" load={swarm}>
      <div className="an-swarm">
        <div className="an-figure">
          <span className="an-k">Agents online</span>
          <span className="an-v">{d?.online !== undefined ? whole(d.online) : "—"}</span>
          {d?.enrolled !== undefined && <span className="an-quiet">{whole(d.enrolled)} enrolled</span>}
        </div>
        <div className="an-figure">
          <span className="an-k">Paid requests per day</span>
          <span className="an-v">{avgReq !== undefined ? whole(avgReq) : "—"}</span>
          <Spark label="Paid requests per day, last 7 days" values={days.map((x) => x.requests)} titles={days.map((x) => `${x.day}: ${whole(x.requests)} paid requests`)} />
        </div>
        <div className="an-figure">
          <span className="an-k">Request revenue per day</span>
          <span className="an-v">
            {avgImd !== undefined ? `${whole(avgImd)} IMD` : "—"}
            {avgImd !== undefined && imdUsd !== undefined ? ` · ${usd(avgImd * imdUsd, 0)}` : ""}
          </span>
          <Spark label="Request revenue per day in IMD, last 7 days" values={days.map((x) => x.imd)} titles={days.map((x) => `${x.day}: ${whole(x.imd)} IMD`)} />
        </div>
        <div className="an-figure">
          <span className="an-k">Price of one request</span>
          <span className="an-v">{imdUsd !== undefined ? usd(REQUEST_IMD * imdUsd) : "—"}</span>
          <span className="an-quiet">{REQUEST_IMD} IMD at today's market</span>
        </div>
      </div>
      <p className="an-quiet">Every request costs {REQUEST_IMD} IMD, so its dollar price moves with IMD. A dollar-denominated unit would hold it still.</p>
      <p className="an-src">api.imd.fun/swarm · IMD transfers to IdentityMD's payment address {short("0x4e0fa57bde726079356537e2f34d671e9f41adbc")} · IMD market from the IMD/ETH pool and Chainlink</p>
    </Panel>
  );
}
