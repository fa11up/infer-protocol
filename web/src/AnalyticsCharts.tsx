// The analytics page's charts: hand-rolled SVG, coloured only through style.css roles (the .an-* classes), each an
// image with a name for screen readers and a <title> on every mark for hover. No chart library, like Charts.tsx.
import type { CoverPoint, FeedUpdates, PegHour, PegPoint, RedeemPoint } from "./analytics-data";
import { freshIntervals } from "./analytics-data";

const pad = (n: number) => String(n).padStart(2, "0");
export const utcShort = (t: number) => {
  const d = new Date(t * 1000);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const whole = (v: number) => Math.round(v).toLocaleString("en-US");

/** The peg pool's price as a step line over [t0, t1], the $0.99–$1.01 band, what redeeming one imdUSD returned (sampled,
 * dashed), and a freshness lane per feed. */
/** The peg chart's viewBox: 1060 wide, and tall enough for its price plot and one freshness lane per feed. */
export const PEG_CHART_W = 1060;
export const pegChartHeight = (lanes: number) => 246 + lanes * 26 + 30;
/** `minLanes` keeps room for the lanes of feeds still being read, so the chart does not grow when they arrive. */
export function PegChart({ points, feeds, t0, t1, now, minLanes = 0, redeem = [] }: { points: PegPoint[]; feeds: FeedUpdates[]; t0: number; t1: number; now: number; minLanes?: number; redeem?: RedeemPoint[] }) {
  const W = PEG_CHART_W,
    L = 100,
    R = 1044,
    T = 16,
    B = 222,
    laneTop = 246,
    lanes = feeds.filter((f) => f.name !== "health");
  const H = pegChartHeight(Math.max(lanes.length, minLanes));
  let start = points[0]?.price ?? 1;
  for (const p of points) if (p.t <= t0) start = p.price;
  const inside = points.filter((p) => p.t > t0 && p.t <= t1);
  // The redemption line from its last sample at or before t0, so it enters the chart at the left edge.
  let rFirst = -1;
  redeem.forEach((p, i) => p.t <= t0 && (rFirst = i));
  const rShown = redeem.slice(Math.max(0, rFirst)).filter((p) => p.t <= t1);
  const vals = [start, ...inside.map((p) => p.price), ...rShown.map((p) => p.value)];
  // Grid every 2 cents, or 5/10 cents once redemption pulls the range wide.
  const raw = Math.max(...vals) - Math.min(...vals);
  const gs = raw > 0.3 ? 0.1 : raw > 0.12 ? 0.05 : 0.02;
  const lo = Math.min(0.98, Math.floor((Math.min(...vals) - 0.01) / gs) * gs);
  const hi = Math.max(1.02, Math.ceil((Math.max(...vals) + 0.005) / gs) * gs);
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (R - L);
  const y = (v: number) => B - ((v - lo) / (hi - lo)) * (B - T);
  const grid: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += gs) grid.push(Number(v.toFixed(2)));
  const span = t1 - t0;
  const step = span > 4 * 86400 ? 86400 : span > 2 * 86400 ? 43200 : 3 * 3600;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  let d = `M${x(t0)},${y(start)}`;
  for (const p of inside) d += `H${x(p.t)}V${y(p.price)}`;
  d += `H${x(t1)}`;
  const clampT = (t: number) => Math.min(t1, Math.max(t0, t));
  const rd = rShown.map((p, i) => `${i ? "L" : "M"}${x(clampT(p.t))},${y(p.value)}`).join("");
  let low = { t: t0, price: start };
  for (const p of inside) if (p.price < low.price) low = p;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`imdUSD pool price, now $${now.toFixed(3)}, with price-feed freshness`} className="an-svg">
      <g className="an-grid">
        {grid.map((v) => (
          <g key={v}>
            <line x1={L} x2={R} y1={y(v)} y2={y(v)} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end">
              ${v.toFixed(2)}
            </text>
          </g>
        ))}
        {ticks.map((t) => {
          const dt = new Date(t * 1000);
          return (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={T} y2={H - 30} />
              <text x={x(t)} y={H - 12} textAnchor="middle">
                {dt.getUTCHours() === 0 ? `${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}` : `${pad(dt.getUTCHours())}:00`}
              </text>
            </g>
          );
        })}
      </g>
      <rect className="an-band" x={L} y={y(1.01)} width={R - L} height={y(0.99) - y(1.01)} />
      <line className="an-par" x1={L} x2={R} y1={y(1)} y2={y(1)} />
      <text className="an-note" x={L + 6} y={y(1.01) - 6}>
        peg band
      </text>
      {rd && <path className="an-redeem" d={rd} />}
      {rShown
        .filter((p) => p.t >= t0)
        .map((p) => (
          <circle key={`r${p.block}`} className="an-hit" cx={x(p.t)} cy={y(p.value)} r={5}>
            <title>{`${utcShort(p.t)} UTC: redeeming returned $${p.value.toFixed(3)}`}</title>
          </circle>
        ))}
      <path className="an-line" d={d} />
      {inside.map((p) => (
        <circle key={`${p.block}-${p.t}-${p.price}`} className="an-hit" cx={x(p.t)} cy={y(p.price)} r={6}>
          <title>{`${utcShort(p.t)} UTC: $${p.price.toFixed(4)}`}</title>
        </circle>
      ))}
      {low.price < 0.99 && (
        <g>
          <circle className="an-dot-danger" cx={x(low.t)} cy={y(low.price)} r={4} />
          <text className="an-danger" x={x(low.t) - 10} y={y(low.price) + 4} textAnchor="end">
            low ${low.price.toFixed(3)}
          </text>
        </g>
      )}
      <circle className="an-dot" cx={R} cy={y(now)} r={3.5}>
        <title>{`now: $${now.toFixed(4)}`}</title>
      </circle>
      {lanes.map((f, i) => {
        const ly = laneTop + i * 26;
        const spans = freshIntervals(f, t0, t1);
        const share = Math.round((spans.reduce((a, s) => a + (s.b - s.a), 0) / (t1 - t0)) * 100);
        return (
          <g key={f.name}>
            <rect className="an-stale" x={L} y={ly} width={R - L} height={16}>
              <title>{`${f.name} feed stale: older than ${f.maxAge / 60} minutes`}</title>
            </rect>
            {spans.map((s) => (
              <rect key={s.at} className="an-fresh" x={x(s.a)} y={ly} width={Math.max(1, x(s.b) - x(s.a))} height={16}>
                <title>{`${f.name} updated ${utcShort(s.at)} UTC`}</title>
              </rect>
            ))}
            <text x={L - 8} y={ly + 12} textAnchor="end">
              {`${f.name} ${share}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export type HRow = { label: string; value: number; text: string; tone?: "ink" | "muted" | "danger"; note?: string; title?: string };
/** Horizontal bars on one scale from zero, value printed past the bar end, an optional note column on the right. */
export function HBars({ rows, max, label, noteHead }: { rows: HRow[]; max: number; label: string; noteHead?: string }) {
  const W = 520,
    L = 132,
    R = noteHead ? 420 : 440,
    H = 24 + rows.length * 34;
  const x = (v: number) => L + (Math.max(0, v) / max) * (R - L);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="an-svg">
      {noteHead && (
        <text x={W - 10} y={12} textAnchor="end">
          {noteHead}
        </text>
      )}
      {rows.map((r, i) => {
        const yy = 20 + i * 34;
        return (
          <g key={r.label}>
            <text x={L - 10} y={yy + 13} textAnchor="end" className={i === 0 ? "an-strong" : undefined}>
              {r.label}
            </text>
            <rect className={`an-bar-${r.tone ?? "muted"}`} x={L} y={yy} width={Math.max(2, x(r.value) - L)} height={18} rx={2}>
              <title>{r.title ?? `${r.label}: ${r.text}`}</title>
            </rect>
            <text x={x(r.value) + 6} y={yy + 13} className={r.tone === "danger" ? "an-danger" : "an-strong"}>
              {r.text}
            </text>
            {r.note !== undefined && (
              <text x={W - 10} y={yy + 13} textAnchor="end">
                {r.note}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export type DayCol = { day: string; parts: { v: number; tone: "ink" | "muted"; title: string }[]; label?: string };
/** Columns per day from zero (stacked when a day has parts), the last day in ink, values printed where given. */
export function DayBars({ cols, label, unit, height = 200 }: { cols: DayCol[]; label: string; unit: (v: number) => string; height?: number }) {
  const W = 520,
    L = 46,
    R = 510,
    T = 18,
    B = height - 30;
  const total = (c: DayCol) => c.parts.reduce((a, p) => a + p.v, 0);
  const max = niceMax(Math.max(1, ...cols.map(total)));
  const y = (v: number) => B - (v / max) * (B - T);
  const band = (R - L) / Math.max(1, cols.length),
    bw = Math.min(46, band * 0.58);
  const every = Math.ceil(cols.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="an-svg">
      <g className="an-grid">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={R} y1={y(max * f)} y2={y(max * f)} />
            <text x={L - 6} y={y(max * f) + 4} textAnchor="end">
              {unit(max * f)}
            </text>
          </g>
        ))}
      </g>
      {cols.map((c, i) => {
        const xx = L + i * band + (band - bw) / 2;
        let acc = 0;
        return (
          <g key={c.day}>
            {c.parts.map((p, j) => {
              const top = y(acc + p.v),
                h = y(acc) - top - (j ? 2 : 0);
              acc += p.v;
              return (
                <rect key={j} className={`an-bar-${p.tone}`} x={xx} y={top} width={bw} height={Math.max(0, h)} rx={j === c.parts.length - 1 ? 2 : 0}>
                  <title>{p.title}</title>
                </rect>
              );
            })}
            {c.label && (
              <text className="an-strong" x={xx + bw / 2} y={y(total(c)) - 6} textAnchor="middle">
                {c.label}
              </text>
            )}
            {(i % every === 0 || i === cols.length - 1) && (
              <text x={xx + bw / 2} y={B + 16} textAnchor="middle">
                {c.day}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
export type FlowDay = { day: string; up: number; down: number; title: string };
/** Two columns per day from zero: what was minted (healthy) beside what was burned (danger). */
export function FlowBars({ days, label, unit, height = 200 }: { days: FlowDay[]; label: string; unit: (v: number) => string; height?: number }) {
  const W = 1060,
    L = 46,
    R = 1050,
    T = 18,
    B = height - 30;
  const max = niceMax(Math.max(1, ...days.map((d) => Math.max(d.up, d.down))));
  const y = (v: number) => B - (v / max) * (B - T);
  const band = (R - L) / Math.max(1, days.length),
    bw = Math.min(22, band * 0.32);
  const every = Math.ceil(days.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label={label} className="an-svg">
      <g className="an-grid">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={R} y1={y(max * f)} y2={y(max * f)} />
            <text x={L - 6} y={y(max * f) + 4} textAnchor="end">
              {unit(max * f)}
            </text>
          </g>
        ))}
      </g>
      {days.map((d, i) => {
        const mid = L + i * band + band / 2;
        return (
          <g key={d.day}>
            <title>{d.title}</title>
            <rect className="an-hit" x={mid - band / 2} y={T} width={band} height={B - T} />
            <rect className="an-bar-up" x={mid - bw - 1} y={y(d.up)} width={bw} height={Math.max(0, B - y(d.up))} rx={2} />
            <rect className="an-bar-down" x={mid + 1} y={y(d.down)} width={bw} height={Math.max(0, B - y(d.down))} rx={2} />
            {(i % every === 0 || i === days.length - 1) && (
              <text x={mid} y={B + 16} textAnchor="middle">
                {d.day}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export type StressLoan = { name: string; debt: number; cr: number };
/** Each loan as a circle (area = debt) at its collateral ratio after an IMD fall; under the minimum is liquidatable. */
export function StressPlot({ loans, fall, mat, redeemable }: { loans: StressLoan[]; fall: number; mat: number; redeemable: number }) {
  const W = 1060,
    H = 150,
    L = 20,
    R = 1040,
    hi = Math.max(560, ...loans.map((l) => l.cr + 20));
  const x = (v: number) => L + (Math.min(v, hi) / hi) * (R - L);
  const ticks = [0, 100, mat, redeemable, 300, 400, 500].filter((v, i, a) => v <= hi && a.indexOf(v) === i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Loans' collateral ratios after a ${fall}% IMD fall`} className="an-svg">
      <rect className="an-zone-danger" x={x(0)} y={20} width={x(mat) - x(0)} height={90} />
      <text className="an-danger" x={x(mat) - 6} y={34} textAnchor="end">
        liquidatable
      </text>
      <line className="an-ref-danger" x1={x(mat)} x2={x(mat)} y1={20} y2={110} />
      <line className="an-ref-caution" x1={x(redeemable)} x2={x(redeemable)} y1={20} y2={110} />
      <line className="an-axis" x1={L} x2={R} y1={110} y2={110} />
      {ticks.map((v) => (
        <text key={v} x={x(v)} y={128} textAnchor="middle" className={v === mat ? "an-danger" : undefined}>
          {v}%
        </text>
      ))}
      {loans.map((l) => {
        const nc = l.cr * (1 - fall / 100);
        return (
          <circle key={l.name} className={nc < mat ? "an-loan-bad" : "an-loan"} cx={x(nc)} cy={65} r={Math.max(4, Math.sqrt(l.debt) / 6.5)}>
            <title>{`${l.name}: ${whole(l.debt)} imdUSD, ${Math.round(l.cr)}% → ${Math.round(nc)}%`}</title>
          </circle>
        );
      })}
      <text x={R} y={146} textAnchor="end">
        circle area = debt
      </text>
    </svg>
  );
}

/** Parts of a whole as one bar, with a legend of the largest parts and their shares. */
export function ShareBar({ parts, label }: { parts: { label: string; value: number }[]; label: string }) {
  const W = 520,
    total = parts.reduce((a, p) => a + p.value, 0) || 1,
    shown = parts.slice(0, 4);
  let acc = 0;
  const tone = (i: number) => (i === 0 ? "an-bar-ink" : `an-bar-muted an-op${Math.min(i, 3)}`);
  return (
    <svg viewBox={`0 0 ${W} ${48 + shown.length * 24}`} role="img" aria-label={label} className="an-svg">
      {parts.map((p, i) => {
        const w = (p.value / total) * 500,
          xx = 10 + (acc / total) * 500;
        acc += p.value;
        return (
          <rect key={p.label} className={tone(i)} x={xx} y={4} width={Math.max(0, w - 2)} height={26}>
            <title>{`${p.label}: ${whole(p.value)} imdUSD`}</title>
          </rect>
        );
      })}
      {shown.map((p, i) => {
        const yy = 56 + i * 24;
        return (
          <g key={p.label}>
            <rect className={tone(i)} x={10} y={yy - 9} width={10} height={10} rx={2} />
            <text x={28} y={yy} className={i === 0 ? "an-strong" : undefined}>
              {p.label}
            </text>
            <text x={510} y={yy} textAnchor="end" className="an-strong">
              {`${whole(p.value)}  ${Math.round((p.value / total) * 100)}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A small trend line with its endpoint marked; each point carries its own hover text. */
export function Spark({ values, titles, label }: { values: number[]; titles: string[]; label: string }) {
  const W = 220,
    H = 34;
  if (values.length < 2) return null;
  const max = Math.max(...values),
    min = Math.min(0, ...values);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 8);
  const y = (v: number) => H - 3 - ((v - min) / (max - min || 1)) * (H - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="an-svg an-spark">
      <polyline className="an-spark-line" points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      <circle className="an-dot" cx={x(values.length - 1)} cy={y(values.at(-1)!)} r={3} />
      {values.map((v, i) => (
        <rect key={i} className="an-hit" x={x(i) - 8} y={0} width={16} height={H}>
          <title>{titles[i]}</title>
        </rect>
      ))}
    </svg>
  );
}

export type ChartEvent = { n: number; t0: number; t1?: number; title: string };
/** The resilience chart's viewBox: the peg row, the loan book's cover and IMD's price, on one time axis. */
export const RESILIENCE_W = 1060;
export const RESILIENCE_H = 486;
/**
 * Since launch, on one time axis: the peg pool's hourly average against its band; the loan book's collateral ratio at
 * IMD's market price against the minimum; and IMD's price in dollars. Each stress event is a numbered line through all
 * three rows (a shaded span when it lasted), matching the numbered list under the chart.
 */
export function ResilienceChart({ hours, cover, coverNote = "Reading…", events, t0, t1, mat }: { hours: PegHour[]; cover?: CoverPoint[]; coverNote?: string; events: ChartEvent[]; t0: number; t1: number; mat: number }) {
  const W = RESILIENCE_W,
    H = RESILIENCE_H,
    L = 100,
    R = 1044,
    top = 30;
  const x = (t: number) => L + ((Math.min(t1, Math.max(t0, t)) - t0) / Math.max(1, t1 - t0)) * (R - L);
  const rows = { peg: [44, 186], cr: [222, 330], imd: [366, 446] } as const;
  const scale = (row: readonly [number, number], lo: number, hi: number) => (v: number) => row[1] - ((v - lo) / (hi - lo || 1)) * (row[1] - row[0]);
  // Peg: a grid every 5 cents from below the worst hour to above the band.
  const pegMin = Math.min(0.98, ...hours.map((h) => h.avg));
  const pegLo = Math.floor((pegMin - 0.005) * 20) / 20,
    pegHi = Math.max(1.02, Math.ceil((Math.max(...hours.map((h) => h.avg), 1) + 0.005) * 50) / 50);
  const yp = scale(rows.peg, pegLo, pegHi);
  const pegGrid: number[] = [];
  for (let v = Math.ceil(pegLo * 20) / 20; v <= pegHi + 1e-9; v += 0.05) pegGrid.push(Number(v.toFixed(2)));
  const pegPath = hours.map((h, i) => `${i ? "L" : "M"}${x(h.t + 1800).toFixed(1)},${yp(h.avg).toFixed(1)}`).join("");
  const worst = hours.reduce<PegHour | undefined>((w, h) => (!w || h.avg < w.avg ? h : w), undefined);
  // Cover: collateral ratio at market, from 0 to a round step above its highest.
  const crs = (cover ?? []).filter((c) => c.cr !== undefined) as (CoverPoint & { cr: number })[];
  const crMax = Math.max(mat * 1.5, ...crs.map((c) => c.cr));
  const crStep = crMax > 900 ? 300 : crMax > 450 ? 150 : 100;
  const crHi = Math.ceil(crMax / crStep) * crStep;
  const yc = scale(rows.cr, 0, crHi);
  const crGrid: number[] = [];
  for (let v = 0; v <= crHi; v += crStep) crGrid.push(v);
  const crPath = crs.map((c, i) => `${i ? "L" : "M"}${x(c.t).toFixed(1)},${yc(c.cr).toFixed(1)}`).join("");
  // IMD in dollars: from zero, so a fall reads at its true size.
  const imds = cover ?? [];
  const imdMax = Math.max(0.01, ...imds.map((c) => c.imdUsd));
  const imdStep = niceStep(imdMax / 2);
  const imdHi = Math.ceil(imdMax / imdStep) * imdStep;
  const yi = scale(rows.imd, 0, imdHi);
  const imdGrid: number[] = [];
  for (let v = 0; v <= imdHi + 1e-9; v += imdStep) imdGrid.push(v);
  const imdPath = imds.map((c, i) => `${i ? "L" : "M"}${x(c.t).toFixed(1)},${yi(c.imdUsd).toFixed(1)}`).join("");
  // Days: a tick every day, labelled every other day when the span is long.
  const span = t1 - t0;
  const labelEvery = span > 24 * 86400 ? 4 : span > 12 * 86400 ? 2 : 1;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / 86400) * 86400; t <= t1; t += 86400) ticks.push(t);
  const money = (v: number) => (imdHi < 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 10 ? 1 : 0)}`);
  const label = `Since launch: the peg pool's hourly average${worst ? `, worst hour $${worst.avg.toFixed(3)}` : ""}; the loan book's collateral ratio at IMD's market price; and IMD's price. ${events.length} stress events marked.`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="an-svg">
      <g className="an-grid">
        {ticks.map((t, i) => {
          const dt = new Date(t * 1000);
          return (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={rows.peg[0]} y2={rows.imd[1]} />
              {i % labelEvery === 0 && (
                <text x={x(t)} y={H - 14} textAnchor="middle">
                  {`${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`}
                </text>
              )}
            </g>
          );
        })}
        {pegGrid.map((v) => (
          <g key={`p${v}`}>
            <line x1={L} x2={R} y1={yp(v)} y2={yp(v)} />
            <text x={L - 8} y={yp(v) + 4} textAnchor="end">
              ${v.toFixed(2)}
            </text>
          </g>
        ))}
        {crGrid.map((v) => (
          <g key={`c${v}`}>
            <line x1={L} x2={R} y1={yc(v)} y2={yc(v)} />
            <text x={L - 8} y={yc(v) + 4} textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        {imdGrid.map((v) => (
          <g key={`i${v}`}>
            <line x1={L} x2={R} y1={yi(v)} y2={yi(v)} />
            <text x={L - 8} y={yi(v) + 4} textAnchor="end">
              {money(v)}
            </text>
          </g>
        ))}
      </g>
      {events
        .filter((e) => e.t1 !== undefined)
        .map((e) => (
          <rect key={`s${e.n}`} className="an-event-span" x={x(e.t0)} y={top} width={Math.max(2, x(e.t1!) - x(e.t0))} height={rows.imd[1] - top} />
        ))}
      <text className="an-strong" x={L} y={rows.peg[0] - 6}>
        Peg pool, hourly average
      </text>
      <rect className="an-band" x={L} y={yp(1.01)} width={R - L} height={yp(0.99) - yp(1.01)} />
      <line className="an-par" x1={L} x2={R} y1={yp(1)} y2={yp(1)} />
      <path className="an-line" d={pegPath} />
      {worst && worst.avg < 0.99 && (
        <g>
          <circle className="an-dot-danger" cx={x(worst.t + 1800)} cy={yp(worst.avg)} r={4} />
          <text className="an-danger" x={x(worst.t + 1800) + 8} y={yp(worst.avg) + 4}>
            worst hour ${worst.avg.toFixed(3)}
          </text>
        </g>
      )}
      <text className="an-strong" x={L} y={rows.cr[0] - 6}>
        Collateral ratio at IMD's market price
      </text>
      <line className="an-ref-danger" x1={L} x2={R} y1={yc(mat)} y2={yc(mat)} />
      <text className="an-danger" x={R - 4} y={yc(mat) - 5} textAnchor="end">
        minimum {mat}%
      </text>
      {crPath ? <path className="an-line" d={crPath} /> : <text x={(L + R) / 2} y={(rows.cr[0] + rows.cr[1]) / 2} textAnchor="middle">{cover ? "No samples" : coverNote}</text>}
      <text className="an-strong" x={L} y={rows.imd[0] - 6}>
        IMD, US dollars
      </text>
      {imdPath ? <path className="an-line-muted" d={imdPath} /> : <text x={(L + R) / 2} y={(rows.imd[0] + rows.imd[1]) / 2} textAnchor="middle">{cover ? "No samples" : coverNote}</text>}
      {imds.map((c) => (
        <circle key={c.block} className="an-hit" cx={x(c.t)} cy={c.cr !== undefined ? yc(c.cr) : yi(c.imdUsd)} r={5}>
          <title>{`${utcShort(c.t)} UTC: collateral ratio ${c.cr !== undefined ? `${Math.round(c.cr)}%` : "unknown"} on ${whole(c.debt)} imdUSD of debt; IMD $${c.imdUsd.toFixed(3)}`}</title>
        </circle>
      ))}
      {events.map((e) => (
        <g key={`e${e.n}`} className="an-event">
          <line x1={x(e.t0)} x2={x(e.t0)} y1={top} y2={rows.imd[1]} />
          <circle cx={x(e.t0)} cy={top - 12} r={9} />
          <text x={x(e.t0)} y={top - 8} textAnchor="middle">
            {e.n}
          </text>
          <title>{`${e.n}. ${e.title}, ${utcShort(e.t0)} UTC`}</title>
        </g>
      ))}
    </svg>
  );
}
function niceStep(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-9))));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}
