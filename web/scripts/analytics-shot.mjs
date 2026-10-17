// Local look at /analytics/ against mainnet: waits for the panels to finish reading, then screenshots.
// usage (serve a launch build first): node scripts/analytics-shot.mjs <url> <outPrefix> [theme] [width]
import { chromium } from "playwright";
const [url, out, theme = "light", width = "1440"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(width), height: 900 }, colorScheme: theme });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript((t) => { try { localStorage.setItem("comp-terminal-theme", t); } catch {} }, theme);
await page.goto(url);
const t0 = Date.now();
while (Date.now() - t0 < 150_000) {
  const pending = await page.locator(".an-quiet", { hasText: /Reading/ }).count();
  if (!pending) break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(1500);
const quiet = await page.locator(".an-quiet").allInnerTexts();
const scrollW = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
await page.screenshot({ path: `${out}.png`, fullPage: true });
console.log(JSON.stringify({ secs: Math.round((Date.now() - t0) / 1000), sideways: scrollW, quiet, errors: errors.slice(0, 12) }, null, 1));
await browser.close();
