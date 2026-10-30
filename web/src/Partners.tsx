// imdusd.com/partners/: for teams that hold, pay, launch or build with dollars. Ways to work with imdUSD, each kept to
// what is public (the docs and the blog), and how to reach us. It reads no chain.
import { Card, Cards, InfoPage, InfoSection } from "./InfoPage";
import { EMAIL } from "./links-config";
import { BLOG, href, IDENTITYMD, TERMINAL } from "./site";

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
          <Card title="White label" links={[{ text: "Build on imdUSD", url: href("build/") }]}>
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
