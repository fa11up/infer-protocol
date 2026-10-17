// The first script on every imdusd.com page, and the only one that holds the first paint (vite.config.ts
// renderBlocking): the theme and the background, with no React, no chain code and no page in it. The
// background is drawn before this returns, so the first paint carries it (vibe-core.ts) and a link to
// another page changes the page and not the background. Each entry then loads its page's code, which
// renders when it arrives: until then the visitor sees the background on the page's ground, not a held
// screen.
import "./style.css";
import { initializeTheme } from "./theme-core";
import { startVibe } from "./vibe-core";
import { IMDUSD_VIBES } from "./vibe-imdusd";

export function bootImdusd(page: () => Promise<unknown>) {
  initializeTheme();
  startVibe(IMDUSD_VIBES);
  page().catch((e) => console.error("the page's code did not load", e));
}
