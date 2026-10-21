// The first script on every blog.imdusd.com page (as boot-imdusd.ts on imdusd.com): the theme and the blog's
// background before the first paint, then the page's code.
import "./style.css";
import { initializeTheme } from "./theme-core";
import { startVibe } from "./vibe-core";
import { BLOG_VIBES } from "./vibe-blog";

export function bootBlog(page: () => Promise<unknown>) {
  initializeTheme();
  startVibe(BLOG_VIBES);
  page().catch((e) => console.error("the page's code did not load", e));
}
