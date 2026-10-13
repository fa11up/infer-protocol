import type { ReactNode } from "react";
import { SiteHeader, href, WHITEPAPER, INFER_SITE, TERMINAL, XLink, DexLink } from "./site";
// The live homepage (chain reads, viem, the deployment file) lives in its own module. The public
// build aliases it to an empty stub (vite.config.ts), so no chain code ships on imdusd.com.
import { LiveLanding } from "./landing-live";

/**
 * The launch parameters, as set in the contracts (CDPVault mat/lull/CHOP_PERCENT/REDEMPTION_FEE_*,
 * DeploymentConfig PRICE_MAX_AGE/DUTY_BPS). The public homepage's figures AND its prose both read
 * this one table, so they cannot disagree with each other. Governance changes wait 48 hours.
 */
export const LAUNCH = {
  // Read from the mainnet vault (0x0b69…EF82) on 2026-10-11: mat, CHOP_PERCENT, the redemption fee's floor and cap,
  // lull, PriceFeed.maxAge, duty.
  minRatio: "170%",
  bonus: "20%",
  redemptionFee: "0.5–5%",
  grace: "6 h",
  priceMaxAge: "1 h",
  stabilityFee: "4.44%",
};

/** The public homepage's panel: launch parameters, not a live read of any chain. */
function LaunchPanel() {
  const lines: [string, string][] = [
    ["Minimum collateral ratio", LAUNCH.minRatio],
    ["Liquidation bonus", LAUNCH.bonus],
    ["Redemption fee", LAUNCH.redemptionFee],
    ["Stability fee", LAUNCH.stabilityFee],
    ["Price max age", LAUNCH.priceMaxAge],
  ];
  return (
    <section className="live-panel" aria-labelledby="live-heading">
      <div className="live-head">
        <h2 id="live-heading">Launch parameters</h2>
      </div>
      <dl className="live-lines">
        {lines.map(([k, val]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{val}</dd>
          </div>
        ))}
      </dl>
      <p className="live-wait">
        Final values are set before mainnet launch. Governance changes wait 48
        hours.
      </p>
    </section>
  );
}

/**
 * A mechanics figure: the value, or a dash while it is still pending. The dash is drawn for sight and
 * the word is kept for screen readers, which would otherwise announce "em dash".
 */
function Figure({ value }: { value: string }) {
  return value === "Pending" ? (
    <>
      <b className="figure-dash" aria-hidden="true">
        —
      </b>
      <span className="sr-only">Pending</span>
    </>
  ) : (
    <>{value}</>
  );
}

export function Landing() {
  return TERMINAL ? <LiveLanding /> : <PublicLanding />;
}

/** imdusd.com: no chain connection at all, so nothing on the page can show a testnet value. */
function PublicLanding() {
  return (
    <Page
      panel={<LaunchPanel />}
      contracts={
        <p className="note">
          Contract addresses are published here at mainnet launch.
        </p>
      }
    />
  );
}

export function Page({
  network,
  mainnet,
  panel,
  contracts,
  contractsHeading = "Contracts",
}: {
  network?: string;
  mainnet?: boolean;
  panel: ReactNode;
  contracts: ReactNode;
  contractsHeading?: string;
}) {
  return (
    <div className="site">
      <SiteHeader page="home" network={network} mainnet={mainnet}>
        {TERMINAL && (
          <a className="button primary" href={href("terminal/")}>
            Open terminal
          </a>
        )}
      </SiteHeader>
      <main className="home">
        <section className="hero">
          <div className="hero-copy">
            <h1>
              A dollar the swarm <span>prices.</span>
            </h1>
            <p className="lede">
              imdUSD is a dollar-denominated stablecoin borrowed against staked
              IMD. Its price comes from panels of IdentityMD agents, signed and
              checked on chain against the exact question each feed pins.
            </p>
            <div className="hero-actions">
              {TERMINAL ? (
                <a className="button primary" href={href("terminal/")}>
                  Open the terminal
                </a>
              ) : (
                <a
                  className="button primary"
                  href={WHITEPAPER}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the whitepaper ↗
                </a>
              )}
              <a className="button" href={href("docs/")}>
                Read the docs
              </a>
            </div>
          </div>
          {panel}
        </section>

        <section className="mechanics" aria-labelledby="mechanics-heading">
          <h2 id="mechanics-heading">How it holds a dollar</h2>
          <div className="mechanics-grid">
            <article>
              <h3>Borrow</h3>
              <p>
                Deposit IMD or sIMD and mint imdUSD against it; IMD is staked
                for you. A position must stay at or above the minimum collateral
                ratio, which rises as network health falls.
              </p>
              <p className="figure">
                <Figure value={LAUNCH.minRatio} /> <span>minimum ratio</span>
              </p>
            </article>
            <article>
              <h3>Redeem</h3>
              <p>
                Burn imdUSD for sIMD at the lesser of $&nbsp;1 and the backing behind
                each imdUSD, less a fee that grows with the size of the
                redemption and stays in the protocol as backing.
              </p>
              <p className="figure">
                <Figure value={LAUNCH.redemptionFee} />{" "}
                <span>redemption fee</span>
              </p>
            </article>
            <article>
              <h3>Price</h3>
              <p>
                Agent panels answer the IMD / ETH price over a block window; the
                swarm attester signs the agreed figure. Each feed accepts only
                answers to its own question, then the vault multiplies by
                Chainlink ETH / USD.
              </p>
              <p className="figure">
                2 feeds <span>primary and spot must agree</span>
              </p>
            </article>
            <article>
              <h3>Liquidate</h3>
              <p>
                Anyone can mark a position below the minimum ratio. Once its
                grace period passes, anyone can repay its debt; the position
                gives up collateral worth its debt plus a liquidation bonus,
                which is shared with whoever marked it.
              </p>
              <p className="figure">
                <Figure value={LAUNCH.grace} />{" "}
                <span>grace, set by network health</span>
              </p>
            </article>
          </div>
        </section>

        <section className="contracts" aria-labelledby="contracts-heading">
          <h2 id="contracts-heading">{contractsHeading}</h2>
          {contracts}
        </section>
      </main>
      <footer className="site-footer">
        <nav aria-label="Footer">
          {TERMINAL && <a href={href("terminal/")}>Terminal</a>}
          <a href={href("docs/")}>Docs</a>
          <a href={INFER_SITE} target="_blank" rel="noreferrer">
            INFER ↗
          </a>
          <a href={WHITEPAPER} target="_blank" rel="noreferrer">
            Whitepaper ↗
          </a>
          <XLink />
          <DexLink />
        </nav>
        <span>imdUSD · built on IdentityMD</span>
      </footer>
    </div>
  );
}

/** The docs pages are static HTML built from web/content/docs; React adds only the shared header. */
export function Docs() {
  return (
    <SiteHeader page="docs">
      {TERMINAL && (
        <a className="button primary" href={href("terminal/")}>
          Open terminal
        </a>
      )}
    </SiteHeader>
  );
}
