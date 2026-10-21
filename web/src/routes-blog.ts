// blog.imdusd.com's pages for soft navigation (soft.tsx): the index and every post, all static HTML around the
// shared header ("swap" mode), so the background and the music carry on between them.
import type { Route } from "./soft";

export const BLOG_ROUTES: Route[] = [
  { path: "", load: () => import("./Blog").then((m) => m.Blog) },
  // /<slug>/: an address with no post behind it 404s and loads the not-found page properly.
  { path: /^[a-z0-9-]+\/$/, load: () => import("./Blog").then((m) => m.Blog) },
];
