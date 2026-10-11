// What a price update would do, in plain words. Pure, so it is unit-tested apart from the page.
//
// The vault prices IMD from attested feeds that live one hour and are bought on demand, so most of the
// time the price is either stale (and price actions are paused) or behind the market. This turns the
// feeds, the live pool price and the viewer's position into the few sentences a user needs before
// paying for an update.

const WAD = 10n ** 18n;

export type FeedReading = { value: bigint; updated: bigint; stale: boolean; maxAge: bigint };

export type UpdateInput = {
  now: bigint;
  /** Primary IMD/ETH feed (wei ETH per 1e18 IMD). */
  price?: FeedReading;
  spot?: FeedReading;
  nhi?: FeedReading;
  /** The vault's IMD/USD price at the feed (1e18 = $1). */
  usd?: FeedReading;
  /** Live market from IMD's pool: wei ETH per 1e18 IMD, and the same in USD (1e18 = $1). */
  market?: { imdEth: bigint; imdUsd: bigint };
  /** The feeds' deviation cap, and how much wider it is once stale (absent: a stale feed is unbounded). */
  capBps?: bigint;
  staleMultiple?: bigint;
  /** The viewer's position: ratio in percent, debt, and the most it may owe at today's price. */
  position?: { cr: bigint; debt: bigint; maxDebt: bigint };
  mat?: bigint;
  /** One update's price, in IMD wei. */
  cost?: bigint;
  unit: string;
  /** The vault's allowed primary/spot divergence, in bps. */
  skewBps?: bigint;
  /** What a fresh primary would say now: the median of the request's own pool samples (market.ts). Absent:
   * the market's level stands in for it, which overstates how far one update moves after a fast move. */
  projected?: { median: bigint; samples: bigint[]; spacingBlocks: bigint };
};

export type UpdateAdvice = {
  /** The price purchase worth making now, in a single transaction, and only the feeds that need it: the
   * primary when it is stale or off the market, the spot when it is stale, would disagree with the primary
   * the purchase leaves, or would run out long before it. Nothing when neither does. */
  buy: ("PriceFeed" | "SpotFeed")[];
  /** Network health is out of date: a separate, daily update. */
  health: boolean;
  /** Market price relative to the vault's, 1e18 = equal. */
  ratio?: bigint;
  /** Plain sentences, most important first. */
  lines: string[];
  /** True when an update would put the viewer's position below the minimum ratio. */
  warning: boolean;
  /** Set when buying now would spend IMD without reopening the vault (or would close it): why, and how long to
   * wait. The page shows the button disabled with this as the reason. */
  wait?: string;
  /** The same, in a few words for under the disabled button. */
  waitShort?: string;
  /** What buying the update does for this viewer, in one sentence: their position's ratio and borrowing room,
   * or (with no position) what collateral counts for. Set only when an update is worth buying now. */
  impact?: string;
};

const DEAD_BAND_BPS = 50n; // closer than 0.5% is "in line with the market"
const SPOT_MIN_LEFT = 600n; // a spot with less life than this would lapse before a fresh primary lands

export function pct(bps: bigint) {
  const whole = bps / 100n;
  const frac = (bps % 100n) / 10n;
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

export function dollars(wad: bigint) {
  const cents = (wad + 5n * 10n ** 15n) / 10n ** 16n;
  const s = (cents / 100n).toLocaleString("en-US");
  return `$${s}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function minutes(seconds: bigint) {
  const m = seconds / 60n;
  return m >= 60n ? `${m / 60n} hour${m / 60n === 1n ? "" : "s"}` : `${m} minute${m === 1n ? "" : "s"}`;
}

/** How many updates it takes to carry the vault's price to `ratio` (1e18 = no move). */
export function stepsTo(ratio: bigint, capBps: bigint, firstBps: bigint | undefined): number | undefined {
  if (capBps <= 0n) return undefined;
  const up = ratio >= WAD;
  let at = WAD;
  for (let n = 1; n <= 20; n++) {
    const bps = n === 1 && firstBps !== undefined ? firstBps : capBps;
    at = up ? (at * (10000n + bps)) / 10000n : (at * (10000n - (bps > 10000n ? 10000n : bps))) / 10000n;
    if (up ? at >= ratio : at <= ratio) return n;
  }
  return undefined;
}

export function adviseUpdate(i: UpdateInput): UpdateAdvice {
  const lines: string[] = [];
  let buy: UpdateAdvice["buy"] = [];
  let warning = false;
  let yours: string | undefined;
  const stale = (f?: FeedReading) => !f || f.stale || !f.updated;
  const priceStale = stale(i.price);
  const spotStale = stale(i.spot);
  const health = stale(i.nhi);
  const apart =
    i.price?.value && i.spot?.value
      ? ((i.price.value > i.spot.value ? i.price.value - i.spot.value : i.spot.value - i.price.value) * 10000n) /
        i.price.value
      : undefined;
  const breached = !priceStale && !spotStale && apart !== undefined && i.skewBps !== undefined && apart > i.skewBps;
  const life = i.price?.maxAge ? minutes(i.price.maxAge) : "an hour";
  if (priceStale) {
    lines.push(
      `Borrowing, withdrawing against debt, liquidating and redeeming are paused because the vault's price is out of date. An update reopens them for ${life}.`,
    );
  } else if (spotStale || breached) {
    // Which side is behind: the one further from the live market. In a fast move it is usually the primary
    // (an average over a window), and refreshing the spot would only widen the gap.
    const off = (v: bigint, m: bigint) => (v > m ? v - m : m - v);
    const primaryBehind =
      breached && i.market !== undefined && off(i.price!.value, i.market.imdEth) > off(i.spot!.value, i.market.imdEth);
    lines.push(
      `Borrowing, withdrawing against debt, liquidating and redeeming are paused because the spot check ${spotStale ? "is out of date" : `is ${pct(apart!)} off the primary (${pct(i.skewBps!)} allowed)`}. ${primaryBehind ? "The primary is the one behind the market: updating it reopens them once its average has caught up." : "Refreshing the spot check reopens them."}`,
    );
  }
  if (health)
    lines.push("Network health is out of date, which also pauses those actions. It is a separate update, once a day.");

  let ratio: bigint | undefined;
  if (i.market && i.price?.value) {
    ratio = (i.market.imdEth * WAD) / i.price.value;
    const diffBps = ratio >= WAD ? ((ratio - WAD) * 10000n) / WAD : ((WAD - ratio) * 10000n) / WAD;
    const moved = diffBps >= DEAD_BAND_BPS;
    if (!moved) {
      lines.push("The vault's price is in line with the market (within 0.5%).");
    } else if (ratio > WAD) {
      lines.push(
        `IMD trades ${pct(diffBps)} above the vault's price. After an update, collateral counts for ${pct(diffBps)} more.`,
      );
    } else {
      lines.push(
        `IMD trades ${pct(diffBps)} below the vault's price. An update lowers what collateral counts for by ${pct(diffBps)}.`,
      );
    }
    // What an update would actually set the price to: the window's median when it has been read (after a fast
    // move it lands short of the market), else the market's level.
    const eff = i.projected?.median !== undefined ? (i.projected.median * WAD) / i.price.value : ratio;
    if (moved && i.position && i.position.debt > 0n) {
      const after = (i.position.cr * eff) / WAD;
      let sentence = `Your collateral ratio would go from ${i.position.cr}% to ${after}%`;
      if (eff > WAD) {
        const room = (i.position.maxDebt * eff) / WAD - i.position.debt;
        const now = i.position.maxDebt > i.position.debt ? i.position.maxDebt - i.position.debt : 0n;
        sentence += `, and you could borrow up to ${fmtWad(room > 0n ? room : 0n)} ${i.unit} (${fmtWad(now)} today).`;
      } else sentence += ".";
      lines.push(sentence);
      yours = sentence;
      if (i.mat !== undefined && after < i.mat && eff < WAD) {
        warning = true;
        lines.push(
          `That is below the ${i.mat}% minimum: once the price updates, your position can be marked for liquidation. Add collateral or repay first.`,
        );
      }
    }
    if (moved && ratio < WAD)
      lines.push("The protocol's Treasury pays for this kind of update itself once the gap passes 5%.");
    if (moved && i.capBps !== undefined) {
      const first = priceStale ? (i.staleMultiple !== undefined ? i.capBps * i.staleMultiple : undefined) : i.capBps;
      const steps = first === undefined && priceStale ? 1 : stepsTo(ratio, i.capBps, first);
      if (steps !== undefined && steps > 1)
        lines.push(
          `The move is larger than one update can carry (each may move the price at most ${pct(first ?? i.capBps)}${first !== i.capBps ? `, then ${pct(i.capBps)}` : ""}), so it takes ${steps} updates.`,
        );
    }
    if (priceStale) buy = ["PriceFeed"];
    else if (moved) {
      // Fresh and off the market: worth buying only if the window's median has moved off today's value too.
      const med = i.projected?.median;
      const medBps = med !== undefined ? ((med > i.price.value ? med - i.price.value : i.price.value - med) * 10000n) / i.price.value : undefined;
      if (medBps === undefined || medBps >= DEAD_BAND_BPS) buy = ["PriceFeed"];
      else lines.push("An update would not move the vault's price yet: it is an average of the last two hours, and that average is still within 0.5% of today's value.");
    }
  } else {
    lines.push("The live market price could not be read, so the gap to the market is unknown.");
    if (priceStale) buy = ["PriceFeed"];
  }
  // The spot only when the vault would still be paused without it: stale, beyond the allowed gap (less a tenth)
  // from the primary this purchase leaves (the window's median when read, else the market's level; today's
  // primary when only the spot is in question), or running out before a fresh answer could land (10 minutes).
  // A spot with longer left is not paid for now: it gets its own update when it runs out. Unknown market: buy it.
  const skewBps = i.skewBps ?? 500n;
  const nextPrimary = buy.length ? (i.projected?.median ?? i.market?.imdEth) : i.price?.value;
  const spotGap =
    nextPrimary && i.spot?.value
      ? ((nextPrimary > i.spot.value ? nextPrimary - i.spot.value : i.spot.value - nextPrimary) * 10000n) / nextPrimary
      : undefined;
  const spotLeft = !spotStale ? i.spot!.updated + i.spot!.maxAge - i.now : 0n;
  const needSpot =
    spotStale ||
    spotGap === undefined ||
    spotGap * 10n > skewBps * 9n ||
    (buy.length > 0 && spotLeft < SPOT_MIN_LEFT);
  if (needSpot && (buy.length || breached || spotStale)) buy = [...buy, "SpotFeed"];
  // The mirror: a fresh primary is not bought just because the spot is. When the spot is what pauses the vault
  // and a fresh one (at the market) would sit within the allowed gap of today's primary, the spot alone reopens
  // it; refreshing the primary as well only adds borrowing room, which nobody has to pay for to get unpaused.
  if (!priceStale && (spotStale || breached) && buy.length === 2 && i.market && i.price?.value) {
    const alone = ((i.market.imdEth > i.price.value ? i.market.imdEth - i.price.value : i.price.value - i.market.imdEth) * 10000n) / i.price.value;
    if (alone * 10n <= skewBps * 9n) buy = ["SpotFeed"];
  }

  // Would the purchase reopen the vault? The primary lands at the window's median, the spot at the market (or
  // stays). If they would still be more than skew apart (with a tenth of it to spare), buying now spends IMD and
  // changes nothing; wait for the average to catch up. The estimate assumes IMD holds at today's price.
  let wait: string | undefined;
  let waitShort: string | undefined;
  const med = i.projected?.median;
  if (med !== undefined && buy.includes("PriceFeed")) {
    const spotAfter = buy.includes("SpotFeed") ? i.market?.imdEth : i.spot?.value;
    const gapTo = (m: bigint, x: bigint) => ((m > x ? m - x : x - m) * 10000n) / m;
    const allowed = (skewBps * 9n) / 10n;
    if (spotAfter !== undefined && gapTo(med, spotAfter) > allowed) {
      let eta: bigint | undefined;
      const live = i.market?.imdEth;
      const s = i.projected!.samples;
      if (live !== undefined)
        for (let k = 1; k < s.length; k++) {
          const m = medianOf([...s.slice(k), ...Array(k).fill(live)]);
          if (gapTo(m, live) <= allowed) {
            eta = (BigInt(k) * i.projected!.spacingBlocks * 12n) / 60n;
            break;
          }
        }
      const at = i.usd?.value && i.price?.value ? `about ${dollars((i.usd.value * med) / i.price.value)}` : "a price";
      wait = `Not yet. The vault's price is a two-hour average, so an update now would land at ${at}, still ${pct(gapTo(med, spotAfter))} from the spot check (${pct(skewBps)} allowed) and reopen nothing. ${eta !== undefined ? `If IMD holds here, it catches up in about ${minutes(eta * 60n)}.` : "It catches up once IMD steadies."}`;
      waitShort = eta !== undefined ? `Wait about ${minutes(eta * 60n)}` : "Wait for IMD to steady";
      lines.unshift(wait);
    }
  } else if (buy.length === 1 && buy[0] === "SpotFeed" && i.market && i.price?.value && !priceStale) {
    // A spot alone lands at the market. If the primary is the side behind, that widens the gap: hold too.
    const gapTo = (m: bigint, x: bigint) => ((m > x ? m - x : x - m) * 10000n) / m;
    const allowed = (skewBps * 9n) / 10n;
    const live = i.market.imdEth;
    if (gapTo(i.price.value, live) > allowed) {
      let eta: bigint | undefined;
      const s = i.projected?.samples;
      if (s?.length)
        for (let k = 1; k < s.length; k++) {
          const m = medianOf([...s.slice(k), ...Array(k).fill(live)]);
          if (gapTo(m, live) <= allowed) {
            eta = (BigInt(k) * i.projected!.spacingBlocks * 12n) / 60n;
            break;
          }
        }
      wait = `Not yet. A fresh spot check would land at the market, ${pct(gapTo(i.price.value, live))} from the vault's two-hour average (${pct(skewBps)} allowed), and reopen nothing. ${eta !== undefined ? `If IMD holds here, the average catches up in about ${minutes(eta * 60n)}.` : "The average catches up once IMD steadies."}`;
      waitShort = eta !== undefined ? `Wait about ${minutes(eta * 60n)}` : "Wait for IMD to steady";
      lines.unshift(wait);
    }
  }

  if (i.cost !== undefined && !wait) {
    const cost = (n: bigint) =>
      `${fmtWad(i.cost! * n)} IMD${i.market ? ` (about ${dollars((i.cost! * n * i.market.imdUsd) / WAD)})` : ""}`;
    if (buy.length === 2)
      lines.push(
        `Updating the price buys two answers in one transaction, the primary and the spot check, because the vault acts only while they agree: ${cost(2n)} from your wallet. Each arrives within minutes. No protocol money is spent.`,
      );
    else if (buy[0] === "PriceFeed")
      lines.push(
        `Only the primary needs updating: ${cost(1n)} from your wallet, arriving within minutes.${
          !spotStale && spotLeft < (i.price?.maxAge ?? 3600n) ? ` The spot check runs out in ${minutes(spotLeft)}; it needs its own update then.` : ""
        }`,
      );
    else if (buy.length === 1)
      lines.push(`Only the spot check needs updating: ${cost(1n)} from your wallet, arriving within minutes.`);
    if (health) lines.push(`Updating network health costs ${cost(1n)}.`);
  }
  // With no position, the equivalent: what an update does to every position's collateral.
  if (!yours && ratio !== undefined && i.price?.value) {
    const eff = i.projected?.median !== undefined ? (i.projected.median * WAD) / i.price.value : ratio;
    const bps = eff >= WAD ? ((eff - WAD) * 10000n) / WAD : ((WAD - eff) * 10000n) / WAD;
    if (bps >= DEAD_BAND_BPS)
      yours = `After an update, collateral counts for ${pct(bps)} ${eff >= WAD ? "more" : "less"}.`;
  }
  const impact = buy.includes("PriceFeed") && !wait ? yours : undefined;
  return { buy, health, ratio, lines, warning, wait, waitShort, impact };
}

function medianOf(values: bigint[]) {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}

/** A wad to at most four decimals, trailing zeros trimmed. */
export function fmtWad(v: bigint) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / WAD).toLocaleString("en-US");
  const frac = ((a % WAD) / 10n ** 14n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
