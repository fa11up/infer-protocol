// Counts the eth_getLogs a page makes on load against mainnet, and how long the page takes to settle.
// usage (after `npm run build:launch`): node scripts/log-count.mjs <public|own> [path ...]
//   public: serves dist-public on http://127.0.0.1, so the page reads the public RPCs directly (no /rpc), as local dev does.
//   own:    serves dist-public as https://imdusd.com through Playwright and answers /rpc with worker/rpc.js (memory cache,
//           the public upstreams only), so the count is what the browser would send to imdusd.com/rpc.
// A page is settled when no eth_getLogs or Blockscout request has been made for QUIET ms (and, on /stats/, no panel
// still says "Reading"). Each run starts from empty storage (a first visit).
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode = "public", ...paths] = process.argv.slice(2);
const dir = fileURLToPath(new URL("../../dist-public/", import.meta.url));
const QUIET = 8000;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
async function file(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    return { body: await readFile(join(dir, p)), type: types[extname(p)] ?? "application/octet-stream" };
  } catch {
    try {
      return { body: await readFile(join(dir, p, "index.html")), type: "text/html" };
    } catch {
      return undefined;
    }
  }
}

let origin = "https://imdusd.com";
let server;
if (mode === "public") {
  server = createServer(async (req, res) => {
    const f = await file(new URL(req.url, "http://x").pathname);
    if (!f) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": f.type }).end(f.body);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const { handleRpc } = await import("../worker/rpc.js");
const store = new Map();
const cache = {
  match: async (req) => {
    const hit = store.get(req.url);
    return hit ? new Response(hit) : undefined;
  },
  put: async (req, res) => void store.set(req.url, await res.text()),
  delete: async (req) => store.delete(req.url),
};
let upstreamLogs = 0;
const upstreamFetch = (url, init) => {
  if (JSON.parse(init.body).method === "eth_getLogs") upstreamLogs++;
  return fetch(url, init);
};
const env = { ASSETS: { fetch: async (req) => { const f = await file(new URL(req.url).pathname); return f ? new Response(f.body) : new Response("", { status: 404 }); } } };

const browser = await chromium.launch();
for (const path of paths.length ? paths : ["/terminal/", "/stats/"]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const logs = [];
  let last = Date.now();
  const t0 = Date.now();
  const note = (host, calls) => {
    for (const c of calls)
      if (c?.method === "eth_getLogs") {
        const f = c.params?.[0] ?? {};
        logs.push({ target: Array.isArray(f.address) && f.address.length > 1 ? `group of ${f.address.length}` : `${[f.address].flat()[0]}${f.topics?.length ? " (topics)" : ""}`, host, span: Number(BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n), addresses: [f.address].flat().length, topics: Array.isArray(f.topics) && f.topics.length > 0, key: JSON.stringify([f.address, f.topics ?? null, f.fromBlock, f.toBlock]) });
        last = Date.now();
      }
  };
  let blockscout = 0;
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (u.hostname.endsWith("blockscout.com")) {
      blockscout++;
      last = Date.now();
    }
    if (req.method() !== "POST") return;
    try {
      note(u.hostname + u.pathname.replace(/\/$/, ""), [JSON.parse(req.postData() ?? "null")].flat());
    } catch {
      /* not JSON-RPC */
    }
  });
  if (mode === "own")
    await page.route("https://imdusd.com/**", async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.pathname === "/rpc") {
        const r = await handleRpc(new Request(req.url(), { method: "POST", body: req.postData() ?? "" }), env, { fetch: upstreamFetch, cache }, { logs: true, pages: "the imdUSD terminal" });
        return route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() });
      }
      const f = await file(u.pathname);
      return f ? route.fulfill({ status: 200, contentType: f.type, body: f.body }) : route.fulfill({ status: 404, body: "" });
    });
  const before = upstreamLogs;
  await page.goto(origin + path);
  while (Date.now() - t0 < 180_000) {
    await page.waitForTimeout(1000);
    const reading = path.startsWith("/stats") ? await page.locator(".an-quiet", { hasText: /Reading/ }).count() : 0;
    if (!reading && Date.now() - last > QUIET) break;
  }
  const byHost = {};
  for (const l of logs) byHost[l.host] = (byHost[l.host] ?? 0) + 1;
  const quiet = path.startsWith("/stats") ? await page.locator(".an-quiet").allInnerTexts() : [];
  console.log(
    JSON.stringify({
      mode,
      path,
      getLogs: logs.length,
      distinct: new Set(logs.map((l) => l.key)).size,
      byHost,
      byTarget: Object.fromEntries(Object.entries(Object.groupBy(logs, (l) => l.target)).map(([k, v]) => [k, v.length])),
      multiAddress: logs.filter((l) => l.addresses > 1).length,
      topicFiltered: logs.filter((l) => l.topics).length,
      maxSpan: Math.max(0, ...logs.map((l) => l.span)),
      blockscout,
      ...(mode === "own" && { upstreamGetLogs: upstreamLogs - before }),
      settledSecs: Math.round((last - t0) / 100) / 10,
      quiet: quiet.slice(0, 6),
    }),
  );
  await context.close();
}
await browser.close();
server?.close();
