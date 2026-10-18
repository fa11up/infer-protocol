// The first script on every infer.imdusd.com page (but /97/, a film with no background), and the only one that
// holds the first paint (vite.config.ts renderBlocking): the theme and the background, with no React, no chain
// code and no page in it. As on imdusd.com (boot-imdusd.ts), the background is drawn before this returns, so the
// first paint carries it (vibe-core.ts) and a link to another page changes the page and not the background. Each
// entry then loads its page's code, which renders when it arrives: until then the visitor sees the background on
// the page's ground, not a held screen. On /buy/ (an X player card) that is a phone on a slow network in a frame.
import "./style.css";
import { initializeTheme } from "./theme-core";
import { startVibe } from "./vibe-core";
import { INFER_VIBES } from "./infer/vibes";

export function bootInfer(page: () => Promise<unknown>) {
  initializeTheme();
  startVibe(INFER_VIBES);
  page().catch((e) => console.error("the page's code did not load", e));
}
