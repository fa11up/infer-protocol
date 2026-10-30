// imdusd.com/partners/: for teams that hold, pay, launch or build with dollars. Ways to work with imdUSD, each kept to
// what is public (the docs and the blog), and how to reach us. It reads no chain.
import { Card, Cards, InfoPage, InfoSection } from "./InfoPage";
import { EMAIL } from "./links-config";
import { BLOG, href, IDENTITYMD, TERMINAL } from "./site";

const V2_POST = `${BLOG}v2-scope-and-strategy/`;
const docs = (path: string) => href(`docs/${path}`);

export function Partners() {
  return (
    <InfoPage
      page="partners"
      kicker="Partners"
      title="Work with imdUSD"
      lede={
        <p>
          imdUSD is a dollar on Ethereum, borrowed against staked IMD and priced by the IdentityMD swarm. If your team holds,
          pays, launches or builds with dollars on chain, these are the ways we can work together. Write to{" "}
          <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
        </p>
      }
    >
      <InfoSection id="partners-ways" title="Ways to work together">
        <Cards>
          <Card title="Earn on imdUSD" tag="With v2" links={[{ text: "v2: scope and strategy", url: V2_POST }]}>
            <p>
              v2 adds sImdUSD, a savings vault: deposit imdUSD and earn a share of what borrowers pay, streamed to savers. It
              is built and in review. Teams holding imdUSD can talk to us now about using it when v2 launches.
            </p>
          </Card>
          <Card title="Payroll and payments" links={[{ text: "What is imdUSD", url: docs("overview/what-is-imdusd/") }]}>
            <p>
              imdUSD is a standard ERC-20 on Ethereum. Only its vault can mint it, against collateral held on chain, and no one
              can pause or freeze it. If you pay contributors, agents or suppliers in dollars, we will help you set up payments in imdUSD and
              hold the float in it.
            </p>
          </Card>
          <Card title="Launch pairing" links={[{ text: "The peg pool", url: docs("overview/the-peg-pool/") }]}>
            <p>
              Pair a token with imdUSD and its price reads in dollars, not in a volatile asset. imdUSD trades against USDC at
              the peg and against IMD on Uniswap v4; we can help you open your pool beside them and seed it.
            </p>
          </Card>
          <Card title="White label" links={[{ text: "Build on imdUSD", url: href("build/") }]}>
            <p>
              Offer imdUSD under your own brand: your front end over the same ownerless contracts, with the public history
              API and the docs behind it. Talk to us about a branded terminal for your community.
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
              If you need a price, an on-chain fact or a code review answered by the swarm, we will help you shape the
              question so a panel can agree on it, and wire the signed answer into your contract.
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
