// Local end-to-end of the public history index: the launch build served by a local `wrangler dev` of the imdusd.com
// Worker (with a local imdusd-public D1 filled by infer-ops' `npm run public:backfill -- --local`), loaded in Chromium
// AS imdusd.com (every https://imdusd.com request is answered by the local Worker), so the page takes the same paths
// as in production: /rpc and /api/v1 same-origin. Counts every log read and times the history, with the index and
// with /api/v1 refused (the chain path, as before), and screenshots both.
//
//   npm run build:launch
//   wrangler dev -c wrangler.jsonc --persist-to <infer-ops>/.wrangler/public-shared --port 8799 --local-protocol https
//   node scripts/history-e2e.mjs https://127.0.0.1:8799 <outDir>
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const [local = "https://127.0.0.1:8799", out = "docs/frontend/history-e2e", order = "chain,index,index,chain"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function run(page, mode) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  // rpcLogsUpstream: eth_getLogs calls /rpc could not answer from its cache (they reach a provider's quota).
  const n = { api: 0, apiLogs: 0, rpcGetLogs: 0, rpcLogsUpstream: 0, directGetLogs: 0, blockscout: 0, byHost: {} };
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await ctx.route(/^https:\/\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postData();
    const calls = body ? [JSON.parse(body)].flat().filter((c) => c && c.method) : [];
    const logs = calls.filter((c) => c.method === "eth_getLogs").length;
    if (u.hostname === "imdusd.com") {
      if (u.pathname.startsWith("/api/v1/")) {
        n.api++;
        if (u.pathname === "/api/v1/logs") n.apiLogs++;
        if (mode === "chain") return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"refused for the comparison"}' });
      }
      if (u.pathname === "/rpc") n.rpcGetLogs += logs;
      const res = await route.fetch({ url: `${local}${u.pathname}${u.search}` });
      if (u.pathname === "/rpc" && logs) {
        const sources = (res.headers()["x-rpc"] ?? "").split(",");
        calls.forEach((c, i) => c.method === "eth_getLogs" && sources[i] === "upstream" && n.rpcLogsUpstream++);
      }
      return route.fulfill({ response: res });
    }
    if (logs) {
      n.directGetLogs += logs;
      n.byHost[u.hostname] = (n.byHost[u.hostname] ?? 0) + logs;
    }
    if (u.hostname.includes("blockscout")) n.blockscout++;
    return route.continue();
  });
  const t0 = Date.now();
  const result = { mode, page };
  if (page === "stats") {
    await p.goto("https://imdusd.com/stats/");
    await p.locator(".an-src", { hasText: /history via/ }).first().waitFor({ timeout: 180_000 });
    result.historyMs = Date.now() - t0;
    result.note = await p.locator(".an-src", { hasText: /history via/ }).first().innerText();
    // Let the rest of the page (peg history, events) finish too.
    const t1 = Date.now();
    while (Date.now() - t1 < 150_000 && (await p.locator(".an-quiet", { hasText: /^Reading/ }).count())) await p.waitForTimeout(1000);
    result.settledMs = Date.now() - t0;
  } else {
    await p.goto("https://imdusd.com/terminal/");
    await p.getByRole("tab", { name: /Loan book/ }).first().click().catch(() => {});
    await p.locator(".loan-coverage").first().waitFor({ timeout: 180_000 });
    result.historyMs = Date.now() - t0;
    result.note = await p.locator(".loan-coverage").first().innerText();
    await p.waitForTimeout(3000);
  }
  await p.screenshot({ path: `${out}/${page}-${mode}.png`, fullPage: page === "stats" });
  Object.assign(result, n, { errors: errors.slice(0, 5) });
  await ctx.close();
  return result;
}

const results = [];
// Alternating order, so neither mode is always the one that warms the local /rpc cache.
for (const page of ["stats", "terminal"]) for (const mode of order.split(",")) results.push(await run(page, mode));
await browser.close();
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2) + "\n");
console.table(results.map(({ byHost, errors, ...r }) => r));
for (const r of results) if (Object.keys(r.byHost).length) console.log(r.page, r.mode, "direct getLogs by host", r.byHost);
