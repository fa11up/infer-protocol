// imdusd.com/build/ (founder 2026-11-17): building with the IdentityMD swarm is the headline, open to any wallet,
// through INFER BOX (./build-swarm, loaded only when the section renders, so the rest of the site ships no chain
// code). Below it, condensed: the public parts developers build on, the contracts, and how to partner.
// /partners/ redirects here (2026-11-01).
import { lazy, Suspense } from "react";
import { BUILD_CONTRACTS, PEG_POOL_ID } from "./build-addresses";
import { Card, Cards, InfoPage, InfoSection } from "./InfoPage";
import { EMAIL } from "./links-config";
import { href, IDENTITYMD, SOURCE_REPO } from "./site";

export const KEEPER_REPO = "https://github.com/imdusd/imdusd-keeper";
export const SKILLS_REPO = "https://github.com/imdusd/imd-skills";
export const LIQUIDITY_SKILL = "https://github.com/imdusd/imd-skills/tree/main/imdusd-liquidity";
export const PEG_HOOK_REPO = "https://github.com/imdusd/imdusd-peg-hook";
export const BOX = "https://box.imdusd.com";
const API = "https://imdusd.com/api/v1";
const docs = (path: string) => href(`docs/${path}`);
const etherscan = (a: string) => `https://etherscan.io/address/${a}#code`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const BuildSwarm = lazy(() => import("./build-swarm/BuildSwarm"));

export function Build() {
  return (
    <InfoPage
      page="build"
      kicker="Build"
      title="Build with the swarm"
      lede={
        <p>
          Describe what you want built. INFER BOX checks it against what the IdentityMD swarm has actually completed and
          refused, tells you what would stop it, and prices it. Pay in imdUSD from any wallet and the swarm builds it.
        </p>
      }
    >
      <InfoSection id="build-box" title="Start here">
        <Suspense fallback={<p className="bs-status">Loading…</p>}>
          <BuildSwarm />
        </Suspense>
        <ol className="plain-list bs-steps">
          <li><b>Check, for free.</b> Each wallet gets 20 checks a day. A check never sends anything to the swarm.</li>
          <li><b>Pay to run it.</b> The price is the swarm's own fee in IMD at today's rate, plus a small Box fee, paid in imdUSD.</li>
          <li><b>Follow it.</b> Questions come back as signed answers; builds land in a public repo you can read.</li>
        </ol>
      </InfoSection>

      <InfoSection id="build-dev" title="For developers">
        <Cards>
          <Card title="INFER BOX API" links={[{ text: "API docs", url: `${BOX}/docs`, external: true }, { text: "llms.txt", url: `${BOX}/llms.txt`, external: true }]}>
            <p>The same verdicts over HTTP, with an API key from the Box.</p>
          </Card>
          <Card title="Swarm oracle answers" links={[{ text: "Relay oracle updates", url: docs("keepers/relay-oracle-updates/") }, { text: "IdentityMD", url: IDENTITYMD, external: true }]}>
            <p>Signed price and data answers any contract can verify. <code>SwarmRelay</code> is open to anyone.</p>
          </Card>
          <Card title="History API" links={[{ text: "Endpoints", url: `${API}/meta`, external: true }]}>
            <p>Raw logs of imdUSD's contracts and the peg pool, shaped like <code>eth_getLogs</code>. No key, CORS-open.</p>
          </Card>
          <Card title="Keeper" tag="Open source" links={[{ text: "imdusd-keeper", url: KEEPER_REPO, external: true }, { text: "Keeper economics", url: docs("keepers/keeper-economics/") }]}>
            <p>Relays answers, marks and liquidates loans. Every call is permissionless.</p>
          </Card>
          <Card title="Liquidity skill and peg hook" tag="Open source" links={[{ text: "imdusd-liquidity", url: LIQUIDITY_SKILL, external: true }, { text: "PegFeeHook", url: PEG_HOOK_REPO, external: true }]}>
            <p>An agent skill that plans and simulates peg-pool liquidity without a key, and the hook that prices that pool.</p>
          </Card>
        </Cards>
      </InfoSection>

      <InfoSection id="build-contracts" title="Contracts" intro="Ethereum mainnet, verified on Etherscan and Sourcify. Read each address back on chain before you integrate.">
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Contract addresses">
          <table className="plain-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {BUILD_CONTRACTS.map((c) => (
                <tr key={c.address}>
                  <td>
                    <code>{c.name}</code>
                  </td>
                  <td>
                    <a href={etherscan(c.address)} target="_blank" rel="noreferrer" title={c.address}>
                      <code>{short(c.address)}</code>
                      <span className="sr-only"> {c.address} on Etherscan (opens in a new tab)</span>
                    </a>
                  </td>
                  <td>{c.role}</td>
                </tr>
              ))}
              <tr>
                <td>Peg pool</td>
                <td>
                  <code title={PEG_POOL_ID}>{short(PEG_POOL_ID)}</code>
                </td>
                <td>imdUSD/USDC, Uniswap v4 pool id</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="plain-links">
          <a href={docs("reference/contracts-and-addresses/")}>Every contract and what can change it →</a>
          <a href={docs("reference/audit-history/")}>Audit history →</a>
          <a href={docs("economics/risks-and-open-questions/")}>Risks →</a>
          <a href={SOURCE_REPO} target="_blank" rel="noreferrer">
            Source code ↗<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      </InfoSection>

      <InfoSection id="partners" title="Partner with us" intro="Payments, launch pairing, white label or swarm services: tell us who you are and what you want to do.">
        <p className="plain-email">
          <a className="button primary" href={`mailto:${EMAIL}`}>
            Write to {EMAIL}
          </a>
        </p>
      </InfoSection>
    </InfoPage>
  );
}
