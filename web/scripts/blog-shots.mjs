// Review screenshots of the built blog, served by `npm run preview:blog` on :4180: the index and the first post,
// light and dark, desktop and phone, plus a table view; also reports any horizontal overflow and console errors.
// GPU rendering is forced: Chromium's software renderer leaves a painted block under the sticky contents box over
// the WebGL background, which real browsers do not.
//   node scripts/blog-shots.mjs <out dir>
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "blog-shots";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BLOG_URL ?? "http://localhost:4180";
const b = await chromium.launch({ args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const post = process.env.BLOG_POST ?? "v2-scope-and-strategy";
const report = [];
for (const scheme of ["light", "dark"]) {
  for (const [dev, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: dev === "phone" ? 2 : 1 });
    const p = await ctx.newPage();
    const errs = [];
    p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 120)));
    p.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
    for (const [name, path] of [["index", "/"], ["post", `/${post}/`]]) {
      await p.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await p.waitForTimeout(800);
      const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await p.screenshot({ path: `${OUT}/${name}-${scheme}-${dev}.png` });
      if (name === "post") {
        await p.evaluate(() => document.querySelector(".table-wrap")?.scrollIntoView({ block: "center" }));
        await p.waitForTimeout(600);
        await p.screenshot({ path: `${OUT}/post-table-${scheme}-${dev}.png` });
      }
      report.push(`${name} ${scheme} ${dev}: overflow ${over}px${errs.length ? ` errors: ${errs.join(" | ")}` : ""}`);
      errs.length = 0;
    }
    await ctx.close();
  }
}
console.log(report.join("\n"));
await b.close();
