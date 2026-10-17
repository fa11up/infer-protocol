import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { loadConfig, type Runtime } from "./config";
import { snapshot, feedsReady, shownReserve, type Snapshot } from "./state";
import { TERMINAL } from "./site";
import { AddressLink } from "./actions";
import { compact } from "./MarketCap";
import { age, fmt, ratio, WAD } from "./math";
import { LiveContracts, LivePanel, Page, type LiveLine } from "./Landing";

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
  v === undefined ? "—" : `$\u00a0${compact.format(Number(formatUnits(v, 18)))}`;

function LiveFigures({ s, error }: { s?: Snapshot; error: string }) {
  const [now, setNow] = useState(BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(
      () => setNow(BigInt(Math.floor(Date.now() / 1000))),
      1000,
    );
    return () => clearInterval(t);
  }, []);
  if (!s)
    return (
      <LivePanel
        state={error ? "down" : "wait"}
        note={
          error
            ? TERMINAL
              ? "Live figures are unavailable right now. The terminal shows which read failed."
              : "Live figures are unavailable right now. Try again shortly."
            : undefined
        }
      />
    );
  const v = s.v;
  const price = s.feeds.USD;
  // In LIVE_ROWS order (Landing.tsx).
  const lines: LiveLine[] = [
    {
      value:
        v.backingPerUnit === undefined
          ? "not reported"
          : `$\u00a0${fmt(v.backingPerUnit < WAD ? v.backingPerUnit : WAD)}`,
    },
    { value: usd(shownReserve(v).value) },
    {
      value: price
        ? `$\u00a0${fmt(price.value, 18, 2)} · ${price.stale ? "stale" : age(price.updated, now)}`
        : "—",
      tone: price?.stale ? "danger" : undefined,
    },
    { value: ratio(v.mat) },
    { value: feedsReady(s) ? "open" : "paused", tone: feedsReady(s) ? "healthy" : "danger" },
  ];
  return <LivePanel block={s.block} state="live" lines={lines} supply={v.supply} />;
}

/** The staging build that ships with the terminal: live figures from the configured deployment. */
export function LiveLanding() {
  const { r, s, error } = useLive();
  return (
    <Page
      network={r?.config.network.name}
      mainnet={r?.config.network.testnet === false}
      panel={<LiveFigures s={s} error={error} />}
      contractsHeading={`On ${r?.config.network.name ?? "testnet"}`}
      contracts={
        <>
          {r && r.config.network.testnet !== false && (
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
