import type { ReactNode } from "react";
import { ThemeToggle } from "./theme";
import { Vibe } from "./vibe";
import { IMDUSD_VIBES } from "./vibe-imdusd";
import { Sound } from "./score";
import { IMDUSD_SCORE } from "./score-imdusd";
import { PegTicker } from "./peg-price";

// The site is three static pages (/, /terminal/, /docs/), so any host serves it with no routing
// rules. Each page names the site root relative to itself in <meta name="app-root">; every shared
// link and data file is resolved from there.
export function appRoot(): URL {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="app-root"]');
  return new URL(meta?.content || "./", document.baseURI);
}
export const href = (path = "") => new URL(path, appRoot()).href;
/**
 * Whether this build serves the terminal. `vite build --mode public` makes the public site that goes on
 * imdusd.com: the homepage and docs only, with every terminal link replaced, so nothing links to a page
 * that is not served.
 */
// The public site gains the terminal in the launch build (VITE_TERMINAL=1; vite.config.ts LAUNCH).
export const TERMINAL =
  import.meta.env.MODE !== "public" || import.meta.env.VITE_TERMINAL === "1";
export const WHITEPAPER = "https://whitepaper.imdusd.com";
export const INFER_SITE = "https://infer.imdusd.com";
export const X_ACCOUNT = "https://x.com/imdusd";

/** The footer's link to imdUSD on X: the X mark, in the text colour, named for screen readers. */
export function XLink() {
  return (
    <a className="x-link" href={X_ACCOUNT} target="_blank" rel="noreferrer" aria-label="imdUSD on X" title="imdUSD on X">
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  );
}

/** A header chip naming a network and its state ("Mainnet · live", "Robinhood · staging"), the state
 * pulsing. Shared with infer.imdusd.com. */
export function NetworkChip({
  network,
  state,
}: {
  network: string;
  state: "live" | "staging";
}) {
  return (
    <span className="chip">
      {network} · <span className={`chip-pulse chip-${state}`}>{state}</span>
    </span>
  );
}

type Page = "home" | "terminal" | "docs";
/** One header for every page: brand and navigation on the left; the network chip, theme, background and a
 * page-specific end on the right. */
export function SiteHeader({
  page,
  network,
  mainnet = false,
  children,
}: {
  page: Page;
  network?: string;
  /** True on a mainnet deployment: the chip then reads "Mainnet · live". */
  mainnet?: boolean;
  children?: ReactNode;
}) {
  const link = (to: Page, path: string, text: string) => (
    <a href={href(path)} aria-current={page === to ? "page" : undefined}>
      {text}
    </a>
  );
  return (
    <header className="topbar">
      <div className="brand">
        <a className="wordmark" href={href()} aria-label="imdUSD home">
          imd<b>USD</b>
        </a>
        <nav className="site-nav" aria-label="Site">
          {TERMINAL && link("terminal", "terminal/", "Terminal")}
          {link("docs", "docs/", "Docs")}
          <a href={INFER_SITE} target="_blank" rel="noreferrer">
            INFER ↗
          </a>
          <a href={WHITEPAPER} target="_blank" rel="noreferrer">
            Whitepaper ↗
          </a>
        </nav>
      </div>
      <div className="wallet-bar">
        {TERMINAL && network && !mainnet ? (
          <span className="chip">{`${network} · testnet`}</span>
        ) : (
          <span className="chips">
            <PegTicker />
            <NetworkChip network="Mainnet" state="live" />
            <NetworkChip network="Robinhood" state="staging" />
          </span>
        )}
        <ThemeToggle />
        <Vibe suite={IMDUSD_VIBES} />
        <Sound score={IMDUSD_SCORE} />
        {children}
      </div>
    </header>
  );
}
