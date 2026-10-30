// The stats page's resilience figures from the peg pool's price history: each hour's time-weighted average, every
// stretch below the band, and the share of hours inside it. Pure (types only), so tests/resilience.test.mjs runs them
// in Node; analytics-data.ts re-exports them.
import type { PegPoint } from "./analytics-data";

export type PegHour = { t: number; avg: number; low: number };
/** The pool price's time-weighted average and low in each whole UTC hour of [t0, t1). */
export function pegHours(points: PegPoint[], t0: number, t1: number): PegHour[] {
  const H = 3600;
  const out: PegHour[] = [];
  if (!points.length) return out;
  let i = 0,
    cur = points[0].price;
  for (let h = Math.ceil(t0 / H) * H; h + H <= t1; h += H) {
    while (i < points.length && points[i].t <= h) cur = points[i++].price;
    let area = 0,
      ct = h,
      low = cur;
    while (i < points.length && points[i].t < h + H) {
      area += cur * (points[i].t - ct);
      ct = points[i].t;
      cur = points[i++].price;
      if (cur < low) low = cur;
    }
    area += cur * (h + H - ct);
    out.push({ t: h, avg: area / H, low });
  }
  return out;
}

export type Depeg = { start: number; end?: number; low: number; lowAt: number };
/** Every stretch the pool price spent below `level`, from the swap that took it under to the swap that brought it back
 * (no `end` while it is still under). */
export function pegBreaks(points: PegPoint[], level = 0.99): Depeg[] {
  const out: Depeg[] = [];
  let open: Depeg | undefined;
  for (const p of points) {
    if (!open && p.price < level) open = { start: p.t, low: p.price, lowAt: p.t };
    else if (open) {
      if (p.price < open.low) {
        open.low = p.price;
        open.lowAt = p.t;
      }
      if (p.price >= level) {
        out.push({ ...open, end: p.t });
        open = undefined;
      }
    }
  }
  if (open) out.push(open);
  return out;
}

/** The resilience figures from the hourly peg: the share of whole hours whose average sat in the band, and the worst. */
export function bandShare(hours: PegHour[], lo = 0.99, hi = 1.01) {
  const inside = hours.filter((h) => h.avg >= lo && h.avg <= hi).length;
  const worst = hours.reduce<PegHour | undefined>((w, h) => (!w || h.avg < w.avg ? h : w), undefined);
  return { inside, total: hours.length, share: hours.length ? inside / hours.length : undefined, worst };
}
