import type { ReactNode } from "react";
import { ThemeToggle } from "./theme";
import { Vibe } from "./vibe";
import { IMDUSD_VIBES } from "./vibe-imdusd";
import { IMDUSD_SOUND_KEY } from "./sound-key";
import { PegTicker } from "./peg-price";
import { OracleChip } from "./oracle-chip";
import { lazySound } from "./lazy-sound";
import { NetworkChip } from "./network-chip";
export { NetworkChip };

// The sound button's score is loaded once the page is idle (lazy-sound.tsx).
const LazySound = lazySound(IMDUSD_SOUND_KEY, () => import("./sound-imdusd"));

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
/** The public source: contracts, both sites and the docs. */
export const SOURCE_REPO = "https://github.com/fa11up/infer-protocol";
/** IdentityMD, the agent network whose panels price imdUSD. */
export const IDENTITYMD = "https://imd.fun";
// INFER's launch pool on DexScreener: in its own module so infer.imdusd.com can link it without this file.
import { INFER_DEXSCREENER } from "./infer-dexscreener";
export { INFER_DEXSCREENER };

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

/** The footer's link to INFER's chart on DexScreener: DexScreener's eagle (traced from its icon), in the
 * text colour like the X mark, to its right. */
export function DexLink() {
  return (
    <a className="x-link" href={INFER_DEXSCREENER} target="_blank" rel="noreferrer" aria-label="INFER on DexScreener" title="INFER on DexScreener">
      <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M11.03 22.81C9.48 20.86 8.98 20.15 8.39 19.14C8.07 18.58 8.12 18.57 7.71 19.26C7.41 19.78 7.05 20.51 6.89 20.98C6.81 21.19 6.73 21.36 6.71 21.36C6.65 21.36 6.05 20.28 5.77 19.68C5.5 19.09 5.12 18.01 5.01 17.52C4.97 17.32 4.93 17.16 4.93 17.15C4.93 17.14 4.64 17.41 4.31 17.74C3.97 18.07 3.47 18.49 3.21 18.68C2.74 19.02 1.64 19.66 1.53 19.66C1.51 19.66 1.59 19.52 1.71 19.35C2.63 18.09 3.18 17.11 3.57 16.08C3.77 15.53 4.05 14.43 4.01 14.32C4 14.29 3.74 14.49 3.44 14.76C2.93 15.22 2.08 15.84 1.97 15.84C1.94 15.84 2.08 15.49 2.27 15.07C2.87 13.76 3.24 12.47 3.43 11.06C3.47 10.8 3.52 10.02 3.55 9.33C3.62 7.85 3.73 6.97 3.94 6.32L4.09 5.85L4.86 6.61C5.29 7.02 5.64 7.37 5.65 7.37C5.66 7.38 5.63 7.58 5.58 7.83C5.26 9.36 5.84 10.64 7.13 11.29C7.66 11.55 8.07 11.63 8.75 11.61C9.17 11.59 9.3 11.61 9.27 11.66C9.26 11.7 9.2 11.97 9.15 12.25L9.05 12.76L8.08 13.38C7.54 13.72 7.1 14.02 7.09 14.06C7.08 14.09 7.25 14.22 7.46 14.35C9.35 15.45 10.08 16.57 11.54 20.57C11.76 21.18 11.96 21.72 11.98 21.77C11.99 21.82 12.24 21.22 12.52 20.45C13.6 17.51 14.27 16.2 15.15 15.37C15.47 15.07 16.27 14.49 16.9 14.11C16.98 14.06 16.8 13.93 15.98 13.41L14.96 12.76L14.86 12.21C14.8 11.9 14.76 11.63 14.76 11.62C14.76 11.6 15 11.6 15.29 11.61C15.93 11.63 16.32 11.55 16.85 11.3C17.59 10.94 18.16 10.29 18.4 9.52C18.53 9.07 18.55 8.32 18.43 7.76L18.36 7.4L19.1 6.66C19.74 6.03 19.98 5.84 19.98 5.96C19.98 5.97 20.05 6.21 20.13 6.48C20.31 7.13 20.37 7.65 20.45 9.3C20.49 10.04 20.55 10.94 20.6 11.3C20.76 12.44 21.16 13.82 21.62 14.82C22.1 15.86 22.1 15.86 22 15.82C21.76 15.73 21.08 15.23 20.57 14.76C20.27 14.49 20.01 14.27 19.99 14.29C19.98 14.3 20.01 14.52 20.07 14.77C20.41 16.33 21.05 17.65 22.29 19.35C22.55 19.71 22.53 19.71 21.77 19.29C20.97 18.85 20.37 18.4 19.7 17.74C19.35 17.39 19.09 17.16 19.07 17.21C19.06 17.25 19.01 17.44 18.96 17.64C18.91 17.84 18.77 18.28 18.65 18.61C18.35 19.49 17.42 21.36 17.29 21.36C17.26 21.36 17.21 21.25 17.17 21.11C17.02 20.61 16.09 18.79 15.94 18.69C15.91 18.68 15.67 19.03 15.41 19.47C15.15 19.91 14.7 20.59 14.42 20.98C13.75 21.9 12.07 24 12.01 24C11.99 24 11.54 23.47 11.03 22.81ZM11.77 18.18C11.47 17.43 10.86 16.23 10.51 15.69C10.32 15.41 9.94 14.96 9.59 14.62L9 14.03L9.26 13.87C9.41 13.78 9.65 13.63 9.79 13.55L10.04 13.4L10.15 12.76C10.2 12.4 10.33 11.92 10.42 11.67C10.74 10.83 11.37 10.12 11.88 10C12.32 9.91 12.98 10.46 13.4 11.25C13.67 11.77 13.74 12 13.88 12.82L13.98 13.41L14.51 13.73L15.05 14.05L14.77 14.28C13.79 15.1 13.02 16.27 12.26 18.12C12.14 18.42 12.02 18.66 12 18.66C11.98 18.66 11.88 18.44 11.77 18.18ZM8.11 10.56C7.31 10.36 6.75 9.78 6.6 9C6.54 8.68 6.56 8.22 6.63 8.22C6.65 8.22 6.98 8.46 7.38 8.76C7.77 9.06 8.45 9.54 8.88 9.83C9.3 10.11 9.65 10.37 9.65 10.39C9.65 10.53 8.48 10.65 8.11 10.56ZM14.99 10.56C14.56 10.51 14.39 10.45 14.42 10.37C14.43 10.33 14.86 10.01 15.38 9.66C15.89 9.31 16.55 8.84 16.84 8.62C17.35 8.23 17.37 8.22 17.42 8.35C17.51 8.58 17.41 9.16 17.22 9.55C16.85 10.31 16 10.7 14.99 10.56ZM9.6 9.04C7.02 7.34 4.84 5.38 3.88 3.88C3.58 3.43 3.17 2.59 3.22 2.54C3.24 2.52 3.47 2.71 3.74 2.96C4 3.21 4.41 3.55 4.63 3.71C5.03 3.99 5.05 3.99 5.13 3.88C5.18 3.82 5.39 3.56 5.6 3.29C6.63 1.97 8.17 0.88 9.71 0.38C12.93 -0.66 16.35 0.56 18.6 3.55C18.87 3.91 18.95 3.98 19.03 3.94C19.25 3.82 19.86 3.34 20.3 2.94C20.55 2.71 20.77 2.53 20.79 2.55C20.86 2.62 20.14 3.92 19.76 4.43C18.74 5.79 16.71 7.54 14.39 9.06L13.53 9.63L13.28 9.46C12.37 8.84 11.58 8.83 10.79 9.42C10.65 9.53 10.52 9.62 10.51 9.62C10.5 9.62 10.09 9.36 9.6 9.04Z" />
      </svg>
    </a>
  );
}

type Page = "home" | "terminal" | "analytics" | "docs" | "links";
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
          {TERMINAL && link("analytics", "stats/", "Stats")}
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
            <PegTicker href={TERMINAL ? href("terminal/#trade") : undefined} />
            <OracleChip href={TERMINAL ? href("terminal/#oracle") : undefined} />
            <NetworkChip network="Mainnet" state="live" />
            <NetworkChip network="Robinhood" state="staging" optional />
          </span>
        )}
        <ThemeToggle />
        <Vibe suite={IMDUSD_VIBES} />
        <LazySound />
        {children}
      </div>
    </header>
  );
}

/** The footer every React-rendered page shares (the docs pages render the same links in scripts/docs-pages.mjs). */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <nav aria-label="Footer">
        {TERMINAL && <a href={href("terminal/")}>Terminal</a>}
        {TERMINAL && <a href={href("stats/")}>Stats</a>}
        <a href={href("docs/")}>Docs</a>
        <a href={href("links/")}>Links</a>
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
  );
}
