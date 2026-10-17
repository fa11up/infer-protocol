// imdusd.com/analytics/: the protocol at a glance, every figure read live from the chain (and IdentityMD's public API
// for the swarm strip). Built only where the terminal is (site.tsx TERMINAL).
import { SiteHeader, SiteFooter, href } from "./site";

export function Analytics() {
  return (
    <div className="site">
      <SiteHeader page="analytics">
        <a className="button primary" href={href("terminal/")}>
          Open terminal
        </a>
      </SiteHeader>
      <main className="analytics">
        <h1>imdUSD Analytics</h1>
      </main>
      <SiteFooter />
    </div>
  );
}
