import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { loadConfig, type Runtime } from "./config";
import { snapshot, feedsReady, shownReserve, type Snapshot } from "./state";
import { TERMINAL } from "./site";
import { AddressLink } from "./actions";
import { MarketCap, compact } from "./MarketCap";
import { age, fmt, ratio, WAD } from "./math";
import { Page } from "./Landing";

// The landing page reads the same contracts the terminal does, without a wallet, so its figures
// are the protocol's own and never a number written into the page.
function useLive() {
  const [r, setR] = useState<Runtime>();
  const [s, setS] = useState<Snapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    loadConfig()
      .then((runtime) => {
        if (!active) return;
        setR(runtime);
        const read = () =>
          snapshot(runtime)
            .then((next) => {
              if (active) {
                setS(next);
                setError("");
              }
            })
            .catch(() => active && setError("unavailable"));
        void read();
        timer = setInterval(() => {
          if (document.visibilityState === "visible") void read();
        }, 30000);
      })
      .catch(() => active && setError("unavailable"));
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, []);
  return { r, s, error };
}

const usd = (v?: bigint) =>
  v === undefined ? "—" : `$${compact.format(Number(formatUnits(v, 18)))}`;

function LivePanel({ s, error }: { s?: Snapshot; error: string }) {
  const [now, setNow] = useState(BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(
      () => setNow(BigInt(Math.floor(Date.now() / 1000))),
      1000,
    );
    return () => clearInterval(t);
  }, []);
  const v = s?.v ?? {};
  const price = s?.feeds.USD;
  const lines: [string, string, string?][] = s
    ? [
        [
          "Backing per imdUSD",
          v.backingPerUnit === undefined
            ? "not reported"
            : `$${fmt(v.backingPerUnit < WAD ? v.backingPerUnit : WAD)}`,
        ],
        ["Reserves", usd(shownReserve(v).value)],
        [
          "IMD / USD",
          price
            ? `$${fmt(price.value, 18, 2)} · ${price.stale ? "stale" : age(price.updated, now)}`
            : "—",
          price?.stale ? "danger" : undefined,
        ],
        ["Minimum collateral ratio", ratio(v.mat)],
        [
          "Price actions",
          feedsReady(s) ? "open" : "paused",
          feedsReady(s) ? "healthy" : "danger",
        ],
      ]
    : [];
  return (
    <section className="live-panel" aria-labelledby="live-heading">
      <div className="live-head">
        <h2 id="live-heading">
          Live · {s ? `block ${s.block}` : "reading the chain"}
        </h2>
        <span
          className="live-dot"
          data-state={s ? "live" : error ? "down" : "wait"}
          aria-hidden="true"
        />
      </div>
      {s ? (
        <>
          <dl className="live-lines">
            {lines.map(([k, val, tone]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className={tone ? `${tone}-text` : undefined}>{val}</dd>
              </div>
            ))}
          </dl>
          <p className="live-cap">
            <MarketCap supply={v.supply} />
          </p>
        </>
      ) : (
        <p className="live-wait" role="status">
          {error
            ? TERMINAL
              ? "Live figures are unavailable right now. The terminal shows which read failed."
              : "Live figures are unavailable right now. Try again shortly."
            : "Reading the contracts…"}
        </p>
      )}
    </section>
  );
}

/** The staging build that ships with the terminal: live figures from the configured deployment. */
export function LiveLanding() {
  const { r, s, error } = useLive();
  return (
    <Page
      network={r?.config.network.name}
      mainnet={r?.config.network.testnet === false}
      panel={<LivePanel s={s} error={error} />}
      contractsHeading={`On ${r?.config.network.name ?? "testnet"}`}
      contracts={
        <>
          {r?.config.network.testnet !== false && (
            <p className="note">
              The testnet deployment. The token is deployed there under its
              testnet name, COMP; contracts and parameters will change before
              mainnet.
            </p>
          )}
          <div className="contract-list">
            {r ? (
              [
                // The token, its Treasury and Parameters are created by the vault; listed once the snapshot has
                // read them from it and checked each names the vault back.
                ...(s?.targets.stablecoin ? [{ name: "imdUSD", address: s.targets.stablecoin.address }] : []),
                ...r.config.contracts,
                ...(s?.targets.treasury ? [{ name: "Treasury", address: s.targets.treasury.address }] : []),
                ...(s?.targets.parameters ? [{ name: "Parameters", address: s.targets.parameters.address }] : []),
              ].map((c) => (
                <AddressLink
                  key={c.name}
                  value={c.address}
                  explorer={r.config.network.explorer}
                  label={c.name}
                />
              ))
            ) : (
              <p className="note">
                {error ? "Deployment unavailable." : "Loading…"}
              </p>
            )}
          </div>
        </>
      }
    />
  );
}
