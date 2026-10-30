// imdusd.com's pages for soft navigation (soft.tsx): the homepage, every docs page and the plain pages beside them. Moving between them
// keeps the document, so the background and the music carry on. The docs pages are static HTML rendered at
// build time around a React header, so the layer swaps the page body ("swap" mode) and mounts its header.
import type { Route } from "./soft";
import { ANALYTICS_ROUTES } from "./analytics-route";

export const IMDUSD_ROUTES: Route[] = [
  { path: "", load: () => import("./Landing").then((m) => m.Landing) },
  // /docs/, /docs/<section>/ and /docs/<section>/<page>/; an address with no page behind it 404s and loads.
  { path: /^docs\/(?:[a-z0-9-]+\/){0,2}$/, load: () => import("./Docs").then((m) => m.Docs) },
  // The links page (/links/, the one shared by QR code): reads no chain, so it is in every build.
  { path: "links/", load: () => import("./Links").then((m) => m.Links) },
  // For developers and partners (/build/, /partners/): plain pages that read no chain, so they are in every build too.
  { path: "build/", load: () => import("./Build").then((m) => m.Build) },
  { path: "partners/", load: () => import("./Partners").then((m) => m.Partners) },
  // The analytics page reads the chain, so it exists only where the terminal does (the launch build and dev).
  ...ANALYTICS_ROUTES,
];
