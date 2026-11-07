// Soft navigation: moving between a site's own pages without loading a new document, so the background,
// the music (and on INFER the wallet) carry on and the switch is immediate. Every page is still its own
// HTML file: a direct link, a refresh, a crawler or a card in a post loads that file exactly as before,
// and this layer only takes over clicks on links between pages it knows. Anything it cannot do cleanly it
// hands back to the browser as an ordinary page load:
//
// - a link to a page that is not in the site's routes, to another origin, with a target, a download, or
//   a modifier key (a new tab is the visitor's to ask for);
// - a page whose code or HTML will not load (a 404 included: the not-found page then loads properly);
// - a page from a newer deploy than the one running (every built page carries <meta name="build">), so a
//   tab left open across a deploy never asks for script files that deploy removed;
// - a page that throws while rendering after a soft move.
//
// Two ways to change page, by how the site is built:
// - "keep": every page is a React component under one root (infer.imdusd.com). The root stays mounted,
//   with `frame` around every page, so what lives in the frame (the wallet) is never set up again.
// - "swap": a page is static HTML around a React root (imdusd.com's docs are rendered at build time). The
//   new page's body replaces this one's, the background canvas excepted, and its root is mounted afresh.
//
// What a document load did for free is done here: the address, the title and the head's description,
// canonical, social tags and app-root; scroll to the top (or back to where the visitor was, on Back);
// focus on the new page's heading, and the page's name read out to a screen reader.
import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

/** A page a site can move to softly: its path from the site root ("" for the root, or a pattern for a
 *  family of pages sharing one component) and its component. */
export type Route = { path: string | RegExp; load: () => Promise<ComponentType> };

type Site = {
  /** Whether this document is one of the routes (false for the not-found page, served at any address). */
  routed: boolean;
  routes: Route[];
  /** The page this document was loaded for, already imported (so the first paint is not held). */
  initial: ComponentType;
  mode: "keep" | "swap";
  /** Around every page. In "keep" mode it stays mounted across moves. */
  frame?: (page: ReactNode) => ReactNode;
};

const meta = (doc: Document, name: string) =>
  doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? null;

/** Set once the visitor has moved softly: from then on, a page that throws is loaded again properly. */
let moved = false;

/** A page that throws after a soft move is loaded again properly; on the first load it stays as is. */
class Fallback extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    if (moved) location.reload();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Mounts a site's page in #root and takes over moves between its pages. */
export function softSite(site: Site) {
  const framed = (page: ReactNode) => (site.frame ? site.frame(page) : page);
  let root: Root = createRoot(document.getElementById("root")!);
  if (!site.routed) {
    // The not-found page renders as it always did, and its links load pages properly.
    root.render(framed(<site.initial />));
    return;
  }
  // The site's root, from the page's own <meta name="app-root"> (the root relative to the page).
  const base = new URL(meta(document, "app-root") || "./", location.href).pathname;
  const routeOf = (url: URL) => {
    if (url.origin !== location.origin || !url.pathname.startsWith(base)) return null;
    const rest = url.pathname.slice(base.length).replace(/index\.html$/, "");
    return (
      site.routes.find((r) => (typeof r.path === "string" ? r.path === rest : r.path.test(rest))) ?? null
    );
  };
  const here = routeOf(new URL(location.href));
  const loaded = new Map<Route, ComponentType>();
  if (here) loaded.set(here, site.initial);

  // "keep" mode: one root for the whole visit, its page swapped through a small store.
  let current = { key: location.pathname, Page: site.initial, n: 0 };
  const listeners = new Set<() => void>();
  const store = {
    get: () => current,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  function Pages() {
    const { Page, key, n } = useSyncExternalStore(store.subscribe, store.get);
    return (
      <>
        {framed(
          <Fallback key={`${key}#${n}`}>
            <Page />
          </Fallback>,
        )}
      </>
    );
  }
  const mountSwap = (Page: ComponentType) =>
    root.render(
      framed(
        <Fallback>
          <Page />
        </Fallback>,
      ),
    );
  if (site.mode === "keep") root.render(<Pages />);
  else mountSwap(site.initial);

  const build = meta(document, "build");
  const pages = new Map<string, { at: number; doc: Promise<Document> }>();
  /** The page's HTML, parsed. A hover fetches it ahead and the click that follows (within half a minute)
   *  uses that copy once; every other visit fetches it fresh, so a deploy in between is always seen. */
  const html = (url: URL) => {
    const key = url.pathname;
    const hit = pages.get(key);
    if (hit && Date.now() - hit.at < 30_000) return hit.doc;
    const doc = fetch(url.pathname, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((t) => new DOMParser().parseFromString(t, "text/html"));
    doc.catch(() => pages.delete(key));
    pages.set(key, { at: Date.now(), doc });
    return doc;
  };
  const code = (r: Route) => {
    const have = loaded.get(r);
    return have ? Promise.resolve(have) : r.load().then((c) => (loaded.set(r, c), c));
  };

  // The page's name, read out after a move. Kept across "swap" moves.
  const say = document.createElement("p");
  say.className = "sr-only";
  say.setAttribute("aria-live", "polite");
  say.dataset.softKeep = "";
  document.body.append(say);

  /** Copies what names the page from the new document's head into this one. */
  const head = (doc: Document) => {
    document.title = doc.title;
    for (const sel of [
      'meta[name="description"]',
      'meta[name="app-root"]',
      'meta[name="robots"]',
      'link[rel="canonical"]',
      'meta[property^="og:"]',
      'meta[name^="twitter:"]',
    ]) {
      document.head.querySelectorAll(sel).forEach((el) => el.remove());
      document.head.append(...[...doc.head.querySelectorAll(sel)].map((el) => document.importNode(el, true)));
    }
    // The page's own classes on <html>, keeping a theme change that is under way.
    const changing = document.documentElement.classList.contains("theme-changing");
    document.documentElement.className = doc.documentElement.className;
    if (changing) document.documentElement.classList.add("theme-changing");
  };

  /** Replaces the body with the new page's, keeping the background canvas and the reader's voice. */
  const swapBody = (doc: Document, Page: ComponentType) => {
    root.unmount();
    const keep = [...document.body.children].filter((el) => el.matches(".vibe-canvas, [data-soft-keep]"));
    const fresh = [...doc.body.childNodes]
      .filter((n) => n.nodeName !== "SCRIPT")
      .map((n) => document.importNode(n, true));
    document.body.className = doc.body.className;
    document.body.replaceChildren(...fresh, ...keep);
    root = createRoot(document.getElementById("root")!);
    mountSwap(Page);
  };

  let seq = 0;
  let shown = location.pathname; // the page on screen, to tell a hash change from a move
  /** Moves to `url`. `how`: "push" for a click, "pop" for Back and Forward. */
  async function go(url: URL, how: "push" | "pop") {
    const route = routeOf(url)!;
    const mine = ++seq;
    const hard = () => (how === "pop" ? location.reload() : location.assign(url.href));
    let doc: Document, Page: ComponentType;
    try {
      [doc, Page] = await Promise.all([html(url), code(route)]);
    } catch {
      if (mine !== seq) return; // a later click won: its page, not this one
      return hard();
    }
    pages.delete(url.pathname); // used: the next visit asks again
    if (mine !== seq) return; // a later click won
    if (meta(doc, "build") !== build) return hard(); // a newer deploy: load it properly
    if (how === "push") {
      // Where the visitor was, so Back can return there.
      history.replaceState({ ...history.state, soft: true, y: scrollY }, "");
      history.pushState({ soft: true, y: 0 }, "", url.href);
    }
    shown = url.pathname;
    head(doc);
    moved = true;
    // Rendered at once, after the address changed, so the new page's relative links resolve from it.
    flushSync(() => {
      if (site.mode === "swap") swapBody(doc, Page);
      else {
        current = { key: url.pathname, Page, n: current.n + 1 };
        listeners.forEach((fn) => fn());
      }
    });
    const target = url.hash && document.getElementById(decodeURIComponent(url.hash.slice(1)));
    if (target) target.scrollIntoView();
    else window.scrollTo(0, how === "pop" ? (history.state?.y ?? 0) : 0);
    const h1 = document.querySelector<HTMLElement>("main h1, h1");
    if (h1) {
      if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
      h1.focus({ preventScroll: true });
    }
    say.textContent = doc.title;
  }

  /** The link a click or a hover is on, if it is one this layer should take. */
  const linkOf = (e: Event): URL | null => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return null;
    const url = new URL(a.href, location.href);
    return routeOf(url) ? url : null;
  };
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = linkOf(e);
    if (!url) return;
    // A link to a spot on this same page is the browser's to scroll to.
    if (url.pathname === location.pathname && url.hash) return;
    e.preventDefault();
    if (url.pathname === location.pathname) return window.scrollTo(0, 0);
    void go(url, "push");
  });
  // Fetch the next page while the pointer is on its link, so the click finds it ready.
  const warm = (e: Event) => {
    const url = linkOf(e);
    if (!url || url.pathname === location.pathname) return;
    html(url).catch(() => {});
    code(routeOf(url)!).catch(() => {});
  };
  document.addEventListener("pointerover", warm, { passive: true });
  document.addEventListener("focusin", warm);
  window.addEventListener("popstate", () => {
    const url = new URL(location.href);
    if (!routeOf(url)) return location.reload();
    if (url.pathname === shown) return; // a hash change on this page
    void go(url, "pop");
  });
  history.scrollRestoration = "manual";
  history.replaceState({ ...history.state, soft: true, y: scrollY }, "");
}
