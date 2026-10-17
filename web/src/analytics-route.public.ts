// The public build's stand-in for analytics-route.ts (aliased in vite.config.ts): no analytics page, no chain reads.
import type { Route } from "./soft";

export const ANALYTICS_ROUTES: Route[] = [];
