// imdusd.com/stats/ (the analytics page) as a soft route. The page reads the chain, so the public build (which reads none) aliases this
// file to analytics-route.public.ts in vite.config.ts and the page's code never enters that bundle.
import type { Route } from "./soft";

export const ANALYTICS_ROUTES: Route[] = [{ path: "stats/", load: () => import("./Analytics").then((m) => m.Analytics) }];
