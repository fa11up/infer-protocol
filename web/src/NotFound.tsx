import { SiteFooter, SiteHeader, TERMINAL, href } from "./site";

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
      <SiteFooter />
    </div>
  );
}
