import { SiteHeader, WHITEPAPER, INFER_SITE, TERMINAL, href, XLink, DexLink } from "./site";

/** The public site's not-found page (404.html). The host serves it at any unknown path, so every
 * link resolves from the site root (the build rewrites this page's URLs to absolute ones). */
export function NotFound() {
  return (
    <div className="site">
      <SiteHeader page="home" />
      <main className="not-found" id="main">
        <p className="doc-meta">404</p>
        <h1>Page not found</h1>
        <p className="lede">
          There is nothing at this address. Try the homepage{TERMINAL ? ", the terminal" : ""} or the docs.
        </p>
        <nav aria-label="Where to go instead">
          <a href={href()}>Home</a>
          {TERMINAL && <a href={href("terminal/")}>Terminal</a>}
          <a href={href("docs/")}>Docs</a>
        </nav>
      </main>
      <footer className="site-footer">
        <nav aria-label="Footer">
          {TERMINAL && <a href={href("terminal/")}>Terminal</a>}
          {TERMINAL && <a href={href("stats/")}>Stats</a>}
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
