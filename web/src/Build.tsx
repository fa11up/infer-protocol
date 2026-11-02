// imdusd.com/build/: for developers and partners (/partners/ redirects here, 2026-11-01). What anyone can build on imdUSD today, from public parts only: INFER BOX, the swarm's oracle
// answers, the public history API, the keeper, the liquidity skill, and the contracts. It reads no chain.
import { BUILD_CONTRACTS, PEG_POOL_ID } from "./build-addresses";
import { Card, Cards, InfoPage, InfoSection } from "./InfoPage";
import { EMAIL } from "./links-config";
import { href, IDENTITYMD, SOURCE_REPO, TERMINAL } from "./site";

export const KEEPER_REPO = "https://github.com/fa11up/imdusd-keeper";
export const SKILLS_REPO = "https://github.com/fa11up/imd-skills";
export const LIQUIDITY_SKILL = "https://github.com/fa11up/imd-skills/tree/main/imdusd-liquidity";
export const PEG_HOOK_REPO = "https://github.com/fa11up/imdusd-peg-hook";
export const BOX = "https://box.imdusd.com";
const API = "https://imdusd.com/api/v1";
const IMD_DOCS = "https://imd.fun/docs/";
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
          are the public parts to start from, and <a href="#partners">the ways to partner with us</a> are below.
        </p>
      }
    >
      <InfoSection
        id="build-box"
        title="INFER BOX: check an idea before the swarm runs it"
        intro="Describe what you want from the IdentityMD swarm in plain words. INFER BOX says whether the swarm would complete it, what would stop it, what to be more specific about, and which facts it still needs. It is a developer tool and the quickest way to learn how the swarm works."
      >
        <Cards>
          <Card
            title="A verdict, by web or API"
            tag="Beta"
            links={[
              { text: "Open INFER BOX", url: BOX, external: true },
              { text: "API docs", url: `${BOX}/docs`, external: true },
              { text: "llms.txt", url: `${BOX}/llms.txt`, external: true },
            ]}
          >
            <p>
              Each evaluation returns a band (likely, uncertain, unlikely), the risks with what to do instead, what to
              sharpen, and the typed facts still missing. Send those facts back with the same idea and evaluate again.
              When it reads likely, pay in imdUSD on Ethereum mainnet from the website and the swarm runs the request.
            </p>
          </Card>
          <Card title="Learn how the swarm works" links={[{ text: "IdentityMD docs", url: IMD_DOCS, external: true }]}>
            <p>
              Verdicts are grounded in what the swarm has actually completed and refused: questions that pin one fact, a
              source and a block; builds that link a public repo and commit; launches that name every address and fee.
              Running your ideas through it teaches the shape of a request a panel of agents can agree on.
            </p>
          </Card>
        </Cards>
        <div className="plain-code" tabIndex={0} role="region" aria-label="INFER BOX API request">
          <pre>
            <code>{`curl -s ${BOX}/api/v1/evaluate \\
  -H "Authorization: Bearer $INFER_BOX_KEY" -H "content-type: application/json" \\
  -d '{"idea":"How many Transfer events did IMD 0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7 emit between blocks 26200000 and 26207000?","type":"question"}'`}</code>
          </pre>
        </div>
        <ul className="plain-list">
          <li>
            <b>Access:</b> sign in with a one-time access code or a member's invite link; that wallet keeps access for
            good. Finish the basics in the learn tab to make your own API key. Ask for a code at{" "}
            <a href="mailto:admin@imdusd.com">admin@imdusd.com</a>.
          </li>
          <li>
            <b>Types:</b> <code>question</code>, <code>build</code>, <code>launch</code>, <code>workflow</code> (a launch with
            its website) and <code>continue</code> (a follow-up to an existing swarm project).
          </li>
        </ul>
      </InfoSection>

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
              { text: "Public keeper repo", url: KEEPER_REPO, external: true },
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
          <Card title="The peg hook" tag="Open source" links={[{ text: "Public peg hook repo", url: PEG_HOOK_REPO, external: true }]}>
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
      <InfoSection
        id="partners"
        title="Partner with us"
        intro="If your team holds, pays, launches or builds with dollars on chain, these are the ways we can work together."
      >
        <Cards>
          <Card title="Payroll and payments" links={[{ text: "What is imdUSD", url: docs("overview/what-is-imdusd/") }]}>
            <p>
              imdUSD is a standard ERC-20 on Ethereum. Only its vault can mint it, against collateral held on chain, and no one
              can pause or freeze it, so it can be held and paid like any other dollar token.
            </p>
          </Card>
          <Card title="Launch pairing" links={[{ text: "The peg pool", url: docs("overview/the-peg-pool/") }]}>
            <p>
              Pair a token with imdUSD and its price reads in dollars, not in a volatile asset. imdUSD trades against USDC at
              the peg and against IMD on Uniswap v4.
            </p>
          </Card>
          <Card title="White label" links={[{ text: "Public history API", url: "#build-api" }]}>
            <p>
              Offer imdUSD under your own brand: your front end over the same ownerless contracts, with the public history
              API and the docs behind it.
            </p>
          </Card>
          <Card
            title="Swarm services"
            links={[
              { text: "How the swarm prices imdUSD", url: docs("economics/swarm-evidence/") },
              { text: "Audit history", url: docs("reference/audit-history/") },
              { text: "IdentityMD", url: IDENTITYMD, external: true },
            ]}
          >
            <p>
              We run some of the IdentityMD swarm's most-used paid price feeds, and most audits of our contracts ran on it.
              Our feed contracts, keeper and question documents are public, so they show how to wire a signed swarm answer into a contract.
            </p>
          </Card>
        </Cards>
      </InfoSection>

      <InfoSection id="partners-contact" title="Get in touch">
        <div className="plain-contact">
          <p>
            Tell us who you are, what you want to hold, pay, launch or build, and roughly how much and when.
          </p>
          <p className="plain-email">
            <a className="button primary" href={`mailto:${EMAIL}`}>
              Write to {EMAIL}
            </a>
          </p>
        </div>
      </InfoSection>

      <InfoSection id="partners-before" title="Before you integrate">
        <p className="plain-intro">
          imdUSD is a dollar, not an investment, and nothing on this page is a promise of price or yield. Read who holds which
          powers and what can go wrong
          {TERMINAL ? (
            <>
              , and check its record yourself: the <a href={href("stats/")}>stats page</a> shows the peg, the loans and the
              oracle since launch.
            </>
          ) : (
            "."
          )}
        </p>
        <p className="plain-links">
          <a href={docs("economics/risks-and-open-questions/")}>Risks and open questions →</a>
          <a href={docs("governance/parameters/")}>Parameters and the timelock →</a>
        </p>
      </InfoSection>
    </InfoPage>
  );
}
