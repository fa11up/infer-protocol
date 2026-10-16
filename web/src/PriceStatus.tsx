import type { Runtime } from "./config";
import { type Snapshot, feedsReady } from "./state";
import { Info, type Actions } from "./actions";
import { BuyUpdate } from "./BuyUpdate";
import { age, maxDebt } from "./math";
import { unit } from "./unit";
import { useMarket, useProjection } from "./market";
import { adviseUpdate, dollars, pct } from "./priceUpdate";

/** Time left on a fresh price: "42m more", "23h 57m more". */
function remaining(seconds: bigint) {
  const m = seconds / 60n;
  return m >= 60n ? `${m / 60n}h ${m % 60n}m` : `${m}m`;
}


/**
 * The price the vault is using, when it was last updated, what IMD trades at right now, and what buying
 * an update would do for this viewer, in plain words, with the buttons to buy it.
 */
export function PriceStatus({
  r,
  s,
  now,
  actions,
  where,
  slim = false,
}: {
  r: Runtime;
  s?: Snapshot;
  now: bigint;
  actions: Actions;
  /** Ids stay unique when the panel is shown in more than one pane. */
  where: string;
  /** Update buttons only while price actions are paused (the position desk, where the oracle pane's own
   * buttons sit beside it on a desktop). */
  slim?: boolean;
}) {
  const market = useMarket();
  const projected = useProjection(r.config.oracleAsker?.requests?.PriceFeed);
  const f = s?.feeds ?? {};
  const v = s?.v ?? {};
  const price = f.PriceFeed;
  const usd = f.USD;
  const held = v.positions?.[0] as bigint | undefined;
  const debt = v.debtOf as bigint | undefined;
  const collateralPrice = f.Collateral?.value;
  const position =
    held !== undefined && debt !== undefined && v.collateralRatio !== undefined && v.mat && collateralPrice
      ? { cr: v.collateralRatio as bigint, debt, maxDebt: maxDebt(held, v.mat, collateralPrice) }
      : undefined;
  const asker = s?.asker === "unreadable" ? undefined : s?.asker;
  const advice = adviseUpdate({
    now,
    price,
    spot: f.SpotFeed,
    nhi: f.NhiFeed,
    usd,
    market: market && { imdEth: market.imdEth, imdUsd: market.imdUsd },
    capBps: v.priceCapBps,
    staleMultiple: v.staleMultiple,
    position,
    mat: v.mat,
    cost: asker?.price,
    unit: unit(),
    skewBps: v.skew,
    projected,
  });
  const open = feedsReady(s);
  // The spot check: the attested spot against the primary (both wei ETH per IMD), in bps, and its USD price.
  const spot = f.SpotFeed;
  const skew = v.skew as bigint | undefined;
  const apart =
    price?.value && spot?.value
      ? ((price.value > spot.value ? price.value - spot.value : spot.value - price.value) * 10000n) / price.value
      : undefined;
  const spotUsd = usd?.value && price?.value && spot?.value ? (usd.value * spot.value) / price.value : undefined;
  const left = price && !price.stale ? price.updated + price.maxAge - now : undefined;
  const diff =
    advice.ratio === undefined
      ? undefined
      : advice.ratio >= 10n ** 18n
        ? `${pct(((advice.ratio - 10n ** 18n) * 10000n) / 10n ** 18n)} vs primary`
        : `${pct(((10n ** 18n - advice.ratio) * 10000n) / 10n ** 18n)} vs primary`;
  // One sentence, and only when it matters: why the button waits, a warning, or what an update worth buying does
  // for this viewer. A paused vault with nothing to gain from an update says why it is paused. Otherwise none.
  const headline =
    advice.wait ||
    (advice.warning && advice.lines.find((l) => /minimum/.test(l))) ||
    advice.impact ||
    advice.lines.find((l) => /paused/.test(l));
  const freshness = price?.updated ? (
    open ? (
      <span className="healthy-text">fresh{left !== undefined && left > 0n ? ` ${remaining(left)}` : ""}</span>
    ) : (
      <span className="muted">out of date</span>
    )
  ) : null;
  const showButtons = (advice.buy.length > 0 || advice.health) && (!slim || !open);
  return (
    <section className="price-status" aria-label="IMD price">
      {/* Three prices on one grid (labels, figures, captions in rows, so each lines up with its
          neighbours): what the vault uses, the attested spot check against it, and the live market
          read straight from IMD's pool, outside the oracle. */}
      <div className="price-hero">
        <span>
          Primary
          <Info
            label="Primary"
            text="The price the vault uses: an attested median of IMD's pool over a block window, in USD through Chainlink ETH/USD."
          />
        </span>
        <span>
          Spot
          <Info
            label="Spot"
            text={`An attested reading of IMD's pool at a single block, checked against the primary. If they are more than ${skew !== undefined ? pct(skew) : "the allowed divergence"} apart, borrowing, marking, liquidation and redemption pause.`}
          />
        </span>
        <span className="price-hero-right">
          Market
          <Info
            label="Market"
            text="Live, read directly from IMD's Uniswap pool on Ethereum mainnet and Chainlink ETH/USD every 30 seconds. Not attested and not used by the vault: it shows what the next update would move the price toward."
          />
        </span>
        <strong className="price-hero-vault">{usd?.value ? dollars(usd.value) : "—"}</strong>
        <strong className="price-hero-mid">{spotUsd !== undefined ? dollars(spotUsd) : "—"}</strong>
        <strong className="price-hero-mid price-hero-right">{market ? dollars(market.imdUsd) : "—"}</strong>
        <small>
          {price?.updated ? <>{!slim && `${age(price.updated, now)} · `}</> : "never updated"}
          {freshness}
        </small>
        <small>
          {!spot?.updated ? (
            "never updated"
          ) : spot.stale ? (
            <span className="muted">Stale</span>
          ) : apart === undefined || skew === undefined ? (
            <span className="healthy-text">{age(spot.updated, now)}</span>
          ) : apart > skew ? (
            <span className="danger-text">
              Breached · {pct(apart)} / {pct(skew)}
            </span>
          ) : (
            <span className="healthy-text">{`${slim ? "" : `${age(spot.updated, now)} · `}${pct(apart)} off`}</span>
          )}
        </small>
        <small className="price-hero-right">
          {!market
            ? "pool unreadable"
            : advice.ratio === undefined || !diff
              ? "live"
              : (
                  // Market above the primary reads green, below it red.
                  <span className={advice.ratio >= 10n ** 18n ? "healthy-text" : "danger-text"}>
                    {`${advice.ratio >= 10n ** 18n ? "▲" : "▼"} ${slim ? diff.replace(" vs primary", "") : diff}`}
                  </span>
                )}
        </small>
      </div>
      {/* The button on the left, what it does for you beside it; with no button, the sentence alone. */}
      <div className={showButtons ? "price-status-actions" : undefined}>
        {showButtons && (
          <div className="price-status-buttons">
            {advice.buy.length > 0 && (
              <BuyUpdate
                r={r}
                s={s}
                feed={advice.buy[0]}
                feeds={advice.buy}
                actions={actions}
                label={advice.buy.includes("PriceFeed") ? "Update price" : "Update spot check"}
                idPrefix={`price-status-${where}`}
                info={!advice.health}
                hold={advice.wait}
                holdNote={advice.waitShort}
              />
            )}
            {advice.health && (
              <BuyUpdate
                r={r}
                s={s}
                feed="NhiFeed"
                actions={actions}
                label="Update network health"
                idPrefix={`price-status-${where}`}
              />
            )}
          </div>
        )}
        {headline && (
          <p className={`price-status-line${advice.warning ? " danger-text" : ""}`}>
            {headline}
          </p>
        )}
      </div>
    </section>
  );
}
