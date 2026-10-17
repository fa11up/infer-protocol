// imdusd.com's pages for soft navigation (soft.tsx): the homepage and every docs page. Moving between them
// keeps the document, so the background and the music carry on. The docs pages are static HTML rendered at
// build time around a React header, so the layer swaps the page body ("swap" mode) and mounts its header.
import type { Route } from "./soft";
import { TERMINAL } from "./site";

export const IMDUSD_ROUTES: Route[] = [
  { path: "", load: () => import("./Landing").then((m) => m.Landing) },
  // /docs/, /docs/<section>/ and /docs/<section>/<page>/; an address with no page behind it 404s and loads.
  { path: /^docs\/(?:[a-z0-9-]+\/){0,2}$/, load: () => import("./Landing").then((m) => m.Docs) },
  // The analytics page reads the chain, so it exists only where the terminal does (the launch build and dev).
  ...(TERMINAL ? [{ path: "analytics/", load: () => import("./Analytics").then((m) => m.Analytics) }] : []),
];
