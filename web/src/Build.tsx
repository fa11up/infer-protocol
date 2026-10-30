// imdusd.com/build/: for developers. What anyone can build on imdUSD today, from public parts only: the swarm's oracle
// answers, the public history API, the keeper, the liquidity skill, and the contracts. It reads no chain.
import { BUILD_CONTRACTS, PEG_POOL_ID } from "./build-addresses";
import { Card, Cards, InfoPage, InfoSection } from "./InfoPage";
import { href, IDENTITYMD, SOURCE_REPO } from "./site";

export const KEEPER_REPO = "https://github.com/fa11up/imdusd-keeper";
export const SKILLS_REPO = "https://github.com/fa11up/imd-skills";
export const LIQUIDITY_SKILL = "https://github.com/fa11up/imd-skills/tree/main/imdusd-liquidity";
export const PEG_HOOK_REPO = "https://github.com/fa11up/imdusd-peg-hook";
const API = "https://imdusd.com/api/v1";
const docs = (path: string) => href(`docs/${path}`);
const etherscan = (a: string) => `https://etherscan.io/address/${a}#code`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function Build() {
  return (
    <InfoPage
      page="build"
      kicker="Build"
      title="Build on imdUSD"
      lede={
        <p>
          imdUSD's contracts have no owner, no upgrade path and no allowlist. Everything the terminal does, your code can
          do: read the vault, relay the swarm's price answers, keep loans healthy, and provide liquidity at the peg. These
          are the public parts to start from.
        </p>
      }
    >
      <nav className="plain-toc" aria-label="On this page">
        <a href="#build-oracle">Oracle answers</a>
        <a href="#build-api">History API</a>
        <a href="#build-keeper">Keeper</a>
        <a href="#build-skill">Liquidity skill</a>
        <a href="#build-contracts">Contracts</a>
      </nav>

      <InfoSection
        id="build-oracle"
        title="Oracle answers from the IdentityMD swarm"
        intro="imdUSD's prices come from panels of IdentityMD agents. Each answer is an EIP-712 attestation signed by the oracle service, and a feed accepts it only if it answers the exact question that feed pins, from a large enough panel that agrees."
      >
        <Cards>
          <Card
            title="Relay an answer"
            links={[
              { text: "Relay oracle updates", url: docs("keepers/relay-oracle-updates/") },
              { text: "Oracle and question binding", url: docs("reference/oracle-and-question-binding/") },
            ]}
          >
            <p>
              <code>SwarmRelay</code> is open to anyone. It delivers one attestation or several in one transaction, and can
              mark or liquidate a loan in the same call, so nobody can act on the new price between your update and your
              action.
            </p>
          </Card>
          <Card title="Ask your own questions" links={[{ text: "IdentityMD", url: IDENTITYMD, external: true }]}>
            <p>
              The same swarm answers questions for anyone: prices over a block window, on-chain reads, counts of events.
              Requests are paid in IMD, and an answer can be signed for your own contract and chain, so it verifies there
              exactly as imdUSD's feeds verify theirs.
            </p>
          </Card>
          <Card title="Check before you buy" links={[{ text: "What a feed checks", url: docs("keepers/relay-oracle-updates/#what-a-feed-checks") }]}>
            <p>
              Every feed tells you what it will accept: <code>expectedQuestionHash(fromBlock, toBlock)</code> returns the
              question for a window, and <code>epoch()</code> how far the next value may move.
            </p>
          </Card>
        </Cards>
      </InfoSection>

      <InfoSection
        id="build-api"
        title="Public history API"
        intro="Raw logs of imdUSD's contracts and the peg pool, shaped like eth_getLogs results, so you can decode them with the ABIs you already have and check any log against the chain by its transaction hash. Read-only, CORS-open, no key."
      >
        <div className="plain-code" tabIndex={0} role="region" aria-label="History API requests">
          <pre>
            <code>{`GET ${API}/meta
GET ${API}/logs?address=<addr[,addr]>&fromBlock=<n>&toBlock=<n>
               [&topic0=<t[,t]>][&topic1=<t[,t]>][&after=<block>:<logIndex>]`}</code>
          </pre>
        </div>
        <ul className="plain-list">
          <li>
            <b>Covers</b> the vault, the three price feeds, imdUSD, Parameters, the Treasury and the work oracle, plus the
            peg pool's own logs (read through the Uniswap v4 PoolManager with <code>topic1</code> = the pool id) and its
            liquidity positions' transfers. <code>meta</code> lists every address.
          </li>
          <li>
            <b>Limits:</b> 50,000 blocks per request and 10,000 logs per response (follow <code>next</code> for the rest);
            up to 10 addresses and 4 values per topic.
          </li>
          <li>
            <b>Freshness:</b> every answer carries <code>through</code>, the last block indexed (always at least 12 blocks
            behind the head). Read newer blocks from the chain. If <code>unverified</code> is true, a check against the
            chain found a mismatch that is not yet repaired: read from the chain instead.
          </li>
        </ul>
      </InfoSection>

      <InfoSection id="build-keeper" title="Run a keeper" intro="A protocol is safer with many keepers than with one. Every call a keeper makes is permissionless.">
        <Cards>
          <Card
            title="imdusd-keeper"
            tag="Open source"
            links={[
              { text: "github.com/fa11up/imdusd-keeper", url: KEEPER_REPO, external: true },
              { text: "How liquidation works", url: docs("keepers/how-liquidation-works/") },
            ]}
          >
            <p>
              Keeps the oracle fresh with the Treasury's budget, relays answers the Intake has not delivered, marks and
              liquidates loans under the minimum, and can keep the redemption price paced to the market. It starts report-only: run it for a day
              without a key before you give it one.
            </p>
          </Card>
          <Card title="Keeper economics" links={[{ text: "Keeper economics", url: docs("keepers/keeper-economics/") }, { text: "Mark and liquidate", url: docs("keepers/mark-and-liquidate/") }]}>
            <p>
              Liquidators earn a bonus in sIMD, shared with whoever marked the loan. A bite burns the keeper's own imdUSD,
              so a keeper holds an imdUSD inventory to act.
            </p>
          </Card>
        </Cards>
      </InfoSection>

      <InfoSection id="build-skill" title="Liquidity skill for agents" intro="A skill an AI agent can load to manage imdUSD liquidity without ever touching a key.">
        <Cards>
          <Card
            title="imdusd-liquidity"
            tag="Agent skill"
            links={[
              { text: "The skill", url: LIQUIDITY_SKILL, external: true },
              { text: "The peg pool", url: docs("overview/the-peg-pool/") },
            ]}
          >
            <p>
              Reads the imdUSD/USDC peg pool tick by tick (price, fee now, depth, cost to peg), values a wallet's liquidity
              positions, plans a range, compares venues, and builds simulated, unsigned transactions for the user to sign
              with their own wallet, a hardware wallet or a Safe.
            </p>
          </Card>
          <Card title="The peg hook" tag="Open source" links={[{ text: "github.com/fa11up/imdusd-peg-hook", url: PEG_HOOK_REPO, external: true }]}>
            <p>
              The pool's <code>PegFeeHook</code>: 0.01% near the peg, a surcharge on swaps that push the price away from $1,
              nothing on swaps toward it. No owner and nothing anyone can change.
            </p>
          </Card>
        </Cards>
      </InfoSection>

      <InfoSection
        id="build-contracts"
        title="Contracts"
        intro="Ethereum mainnet, all verified on Etherscan and Sourcify. Before you integrate, read each address back on chain: the vault's getters name every contract it uses, and each names the vault."
      >
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
                      <span className="sr-only">
                        {" "}
                        {c.address} on Etherscan (opens in a new tab)
                      </span>
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
                <td>imdUSD/USDC, Uniswap v4 pool id: pin the id, not the token pair</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="plain-links">
          <a href={docs("reference/contracts-and-addresses/")}>Every contract and what can change it →</a>
          <a href={docs("reference/vault-functions/")}>Vault functions →</a>
          <a href={docs("reference/reading-state/")}>Reading state →</a>
          <a href={docs("reference/audit-history/")}>Audit history →</a>
          <a href={SOURCE_REPO} target="_blank" rel="noreferrer">
            Source code ↗<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      </InfoSection>
    </InfoPage>
  );
}
