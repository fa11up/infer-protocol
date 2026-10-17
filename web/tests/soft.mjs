// Soft navigation (src/soft.tsx), end to end against both built sites: npm run build:infer && npm run
// build:public, then npm run test:soft. Each site is served as Cloudflare serves it (directories to
// index.html, unknown paths to 404.html, its own Content-Security-Policy), and a browser moves between its
// pages checking that the document, the background canvas and the sound carry on, that the address, title,
// canonical and focus follow, that Back and Forward work, that the wallet is set up once (INFER), and that a
// newer deploy or a missing script file falls back to an ordinary page load.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = fileURLToPath(new URL(".", import.meta.url));
let failed = 0;
const ok = (c, m) => { if (!c) { console.log("FAIL:", m); failed++; } else console.log("ok:", m); };

const RPC_UPSTREAM = process.env.RPC_UPSTREAM ?? "https://ethereum-rpc.publicnode.com";

async function serve(dir, port) {
  dir = resolve(here, dir);

  const headers = await readFile(resolve(dir, "_headers"), "utf8");
  const csp = headers.match(/Content-Security-Policy: (.*)/)[1];
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".mp4": "video/mp4" };
  let mode = "normal";
  return createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/__mode") { mode = u.searchParams.get("x"); res.end(mode); return; }
    // The sites read the chain through their Worker's same-origin /rpc (worker/rpc.js); a plain file server has none,
    // so every read 404ed and the console-error check failed on reads, not on navigation. Forward it as the Worker does.
    if (u.pathname === "/rpc") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        const up = await fetch(RPC_UPSTREAM, { method: "POST", headers: { "content-type": "application/json" }, body: Buffer.concat(chunks) });
        res.writeHead(up.status, { "content-type": "application/json" });
        res.end(Buffer.from(await up.arrayBuffer()));
      } catch {
        res.writeHead(502, { "content-type": "application/json" });
        res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"upstream unreachable"}}');
      }
      return;
    }
    let p = u.pathname.endsWith("/") ? u.pathname + "index.html" : u.pathname;
    if (mode === "nochunk" && /\/assets\/(Claim|Tokenomics|App|Docs|docs)[^/]*\.js$/.test(p)) { res.writeHead(404); res.end(); return; }
    let body, status = 200;
    try { body = await readFile(resolve(dir, "." + p)); }
    catch { try { body = await readFile(resolve(dir, "." + p + "/index.html")); p += "/index.html"; } catch { body = await readFile(resolve(dir, "404.html")); status = 404; p = "/404.html"; } }
    if (mode === "newbuild" && p.endsWith(".html") && !u.pathname.match(/^\/(index\.html)?$/)) body = Buffer.from(body.toString().replace(/<meta name="build" content="[^"]+"/, '<meta name="build" content="NEWER"'));
    res.writeHead(status, { "content-type": types[extname(p)] ?? "application/octet-stream", "content-security-policy": csp });
    res.end(body);
  }).listen(port, "127.0.0.1");
}

async function run(BASE, plan) {
  const b = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => {
  window.__eip = 0;
  window.addEventListener("eip6963:requestProvider", () => window.__eip++);
});
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
const mode = (x) => fetch(BASE + "/__mode?x=" + x);
await mode("normal");
await p.goto(BASE + plan.start, { waitUntil: "networkidle" });
await p.evaluate(() => { window.__doc = Math.random(); document.querySelector(".vibe-canvas").dataset.mark = "1"; });
const doc0 = await p.evaluate(() => window.__doc);
if (plan.sound) { await p.locator(".score-toggle").first().click(); await p.waitForTimeout(500); }
const same = () => p.evaluate((d) => window.__doc === d && document.querySelector(".vibe-canvas")?.dataset.mark === "1", doc0);
for (const [sel, path, title] of plan.links) {
  const t0 = Date.now();
  await p.locator(sel).first().click();
  await p.waitForURL((u) => u.pathname === path);
  await p.waitForFunction((t) => document.title.includes(t), title);
  const ms = Date.now() - t0;
  const info = await p.evaluate(() => ({ title: document.title, canon: document.querySelector('link[rel="canonical"]')?.href, og: document.querySelector('meta[property="og:url"]')?.content, focus: document.activeElement?.tagName, sound: document.querySelector(".score-toggle")?.dataset.state, y: scrollY, canvases: document.querySelectorAll(".vibe-canvas").length }));
  ok(await same(), `${path}: no reload, background canvas kept (${ms} ms)`);
  ok(info.canon === undefined || new URL(info.canon).pathname === path, `${path}: canonical ${info.canon}`);
  ok(info.focus === "H1", `${path}: focus on the heading (${info.focus})`);
  if (plan.sound) ok(info.sound === "on", `${path}: sound still on`);
  ok(info.canvases === 1, `${path}: one background canvas`);
}
// Back and Forward
await p.evaluate(() => window.scrollTo(0, 0));
await p.goBack(); await p.waitForTimeout(400);
ok(await same(), `back to ${await p.evaluate(() => location.pathname)} without a reload`);
await p.goForward(); await p.waitForTimeout(400);
ok(await same(), `forward to ${await p.evaluate(() => location.pathname)} without a reload`);
if (plan.wallet) ok((await p.evaluate(() => window.__eip)) === 1, `wallet set up once (${await p.evaluate(() => window.__eip)} requests)`);
// A newer deploy: the next page must be loaded properly.
await mode("newbuild");
await p.locator(plan.links[0][0]).first().click();
await p.waitForURL((u) => u.pathname === plan.links[0][1]);
await p.waitForLoadState("networkidle");
ok(!(await same()), "newer deploy -> full page load");
// A missing chunk: back to the start page fresh, then a page whose code is gone.
await mode("normal");
const before = errs.splice(0); // errors after this point are the missing files the test asks for
if (plan.chunk) {
await p.goto(BASE + plan.start, { waitUntil: "networkidle" });
await p.evaluate(() => { window.__doc = 7; });
await mode("nochunk");
await p.locator(plan.links[0][0]).first().click();
await p.waitForURL((u) => u.pathname === plan.links[0][1]);
await p.waitForTimeout(800);
ok((await p.evaluate(() => window.__doc)) !== 7, "missing chunk -> full page load");
}
await mode("normal");
// Ctrl-click is the browser's (no soft move)
await p.goto(BASE + plan.start, { waitUntil: "networkidle" });
await p.evaluate(() => { window.__doc = 9; });
const [popup] = await Promise.all([ctx.waitForEvent("page"), p.locator(plan.links[0][0]).first().click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] })]);
ok((await p.evaluate(() => [window.__doc, location.pathname])).join() === `9,${plan.start}`, "cmd-click opens a new tab, this page stays");
await popup.close();
ok(before.filter((e) => !/cloudflareinsights|__CF/.test(e)).length === 0, `no console errors ${JSON.stringify(before)}`);
await b.close();

}

const PLANS = [
  ["../../dist-infer", 5301, {
    start: "/", sound: true, wallet: true, chunk: true,
    links: [[".infer-nav a[href*=claim]", "/claim/", "Claim"], [".infer-nav a[href*=tokenomics]", "/tokenomics/", "Tokenomics"], [".infer-mark", "/", "Trade"]],
  }],
  ["../../dist-public", 5302, {
    start: "/", sound: true, chunk: false, // the homepage and the docs share one script file
    links: [[".site-nav a[href*=docs]", "/docs/", "imdUSD docs"], ["main a[href*=glossary]", "/docs/overview/glossary/", "Glossary"], ['main a[href*="relay-oracle-updates"]', "/docs/keepers/relay-oracle-updates/", "Relay"], ["header a:first-child", "/", "imdUSD"]],
  }],
];
// A docs page reserves its header's height until the header renders (style.css `.docs-site > #root:empty`), so the
// article never jumps down when it arrives. The reserved height must be the header's own at every layout. (Below
// 345px the reservation is the imdusd.com header's, whose peg ticker wraps the chips; this server has no /rpc, so
// no ticker, and 320px is not compared.)
async function docsHeaderReserved(dir, port) {
  const server = await serve(dir, port);
  const b = await chromium.launch();
  for (const width of [360, 390, 761, 900, 1001, 1440]) {
    const viewport = { width, height: 800 };
    const still = await b.newContext({ viewport, javaScriptEnabled: false });
    const sp = await still.newPage();
    await sp.goto(`http://127.0.0.1:${port}/docs/overview/glossary/`);
    const reserved = await sp.evaluate(() => document.getElementById("root").getBoundingClientRect().height);
    await still.close();
    const live = await b.newContext({ viewport });
    const lp = await live.newPage();
    await lp.goto(`http://127.0.0.1:${port}/docs/overview/glossary/`);
    await lp.locator(".topbar").waitFor();
    const header = await lp.evaluate(() => document.querySelector(".topbar").getBoundingClientRect().height);
    await live.close();
    ok(Math.abs(reserved - header) < 1, `docs at ${width}px: header space reserved ${reserved}px, header ${header}px`);
  }
  await b.close();
  server.close();
}
await docsHeaderReserved("../../dist-public", 5303);
for (const [dir, port, plan] of PLANS) {
  const server = await serve(dir, port);
  console.log(`== ${dir}`);
  await run(`http://127.0.0.1:${port}`, plan);
  server.close();
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
