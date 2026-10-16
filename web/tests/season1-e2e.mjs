// The Points pane through Season 1's phases, against the LIVE deployment on a local mainnet fork: before opening
// (preseason counting), after the Safe executes the real openSeason payload (countdown, preseason frozen at that
// block), and after the start (Season 1 live, a wallet holding imdUSD credited 1 point per imdUSD per day).
// Blockscout cannot know the fork's SeasonOpened, so the test answers the vault's log query with the fork's own logs.
//
//   anvil --fork-url <mainnet rpc> --port 8547
//   node scripts/mainnet-deployment.mjs --record <release>/deploy/mainnet/out/deployment.json --commit b2c7afe --rpc http://127.0.0.1:8547
//   npx vite build && node scripts/manifest.mjs
//   E2E_RPC=http://127.0.0.1:8547 node tests/season1-e2e.mjs [payload.json]   (then git checkout web/deployment-source.json)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPublicClient, http, parseAbi, getAddress, encodeFunctionData } from "viem";
import { USDC } from "../src/leverage.ts";
import { POSITION_MANAGER } from "../src/lp.ts";
import { etherscanLogs } from "../../points/archive.ts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC)) throw Error("E2E_RPC must be a local fork");
const SHOTS = process.env.E2E_SHOTS;
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const dist = resolve(root, "dist");
const source = JSON.parse(await readFile(resolve(root, "web/deployment-source.json")));
const VAULT = getAddress(source.contracts.find((c) => c.name === "ParameterizedVault").address);
const IMD = getAddress("0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7");
const IMDUSD = getAddress("0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25");
const POOL_MANAGER = getAddress("0x000000000004444c5dc75cB358380D2e3dE08A90");
const FEEDS = {
  PriceFeed: "0x070e0603737242B01aBC1D223f7C92D63E86EC97",
  SpotFeed: "0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951",
  NhiFeed: "0x014DabF6F940c9C383D9ef48636F70D842F65D7A",
};
const E18 = 10n ** 18n;
const SEASON_VAULT = "0x08DC1b5789Aa4951daC6022f2141C646c7F6F9f4";
if (!process.env.ETHERSCAN_API_KEY) throw Error("set ETHERSCAN_API_KEY (the harness serves explorer logs for the fork)");
const SAFE = "0xbeFd108085613662356aa26A2466Ad3426DA9C32";

const chain = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
const rpc = (method, params = []) => chain.request({ method, params });
// The block the fork was taken at: logs up to it come from Etherscan, after it from the fork.
const forkBlock = Number((await rpc("anvil_nodeInfo")).forkConfig.forkBlockNumber);
const num = async (tag) => (tag === undefined || tag === "latest" ? Number(await chain.getBlockNumber()) : Number(BigInt(tag)));
const history = new Map();
async function forkLogs(f) {
  const from = await num(f.fromBlock ?? "latest"), to = await num(f.toBlock ?? "latest");
  const out = [];
  if (from <= forkBlock) {
    const topics = (f.topics ?? []).map((t) => (Array.isArray(t) ? null : t));
    const addresses = Array.isArray(f.address) ? f.address : [f.address];
    for (const a of addresses) {
      // Each address's pre-fork history is read once (by its AND topics) and windows are sliced from memory.
      const key = `${a.toLowerCase()}|${JSON.stringify(topics)}`;
      if (!history.has(key)) history.set(key, etherscanLogs(a, topics, 26_160_000, forkBlock));
      let logs = (await history.get(key)).filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= Math.min(to, forkBlock));
      // OR-ed topics (arrays) are filtered here, after the AND query without them.
      logs = logs.filter((l) => (f.topics ?? []).every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(l.topics[i]?.toLowerCase()) : t.toLowerCase() === l.topics[i]?.toLowerCase())));
      out.push(...logs.map((l) => ({ ...l, blockNumber: "0x" + BigInt(l.blockNumber).toString(16), logIndex: "0x" + BigInt(l.logIndex).toString(16), transactionIndex: "0x" + BigInt(l.transactionIndex === "0x" ? "0x0" : l.transactionIndex ?? "0x0").toString(16), removed: false })));
    }
  }
  if (to > forkBlock) out.push(...(await rpc("eth_getLogs", [{ ...f, fromBlock: "0x" + Math.max(from, forkBlock + 1).toString(16), toBlock: "0x" + to.toString(16) }])));
  return out;
}
const vaultAbi = parseAbi([
  "function positions(address) view returns (uint256 collateral, uint256 debt)",
  "function debtOf(address) view returns (uint256)",
  "function collateralRatio(address) view returns (uint256)",
  "function lockIMD(uint256 assets)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
]);
const feedAbi = parseAbi(["function latestValue() view returns (uint256, uint256)"]);
const read = (address, abi, functionName, args = []) => chain.readContract({ address, abi, functionName, args });
const fatal = (message) => Object.assign(Error(message), { fatal: true });
async function until(what, check, ms = 90_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await check();
      if (last) return last;
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error(`timed out waiting for: ${what} (${last})`);
}
async function sendAs(from, to, data) {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data }]);
  const receipt = await chain.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
}
/** A fresh account, impersonated: anvil's well-known accounts are EIP-7702-delegated on mainnet. */
async function borrower(imd) {
  const who = privateKeyToAccount(generatePrivateKey()).address;
  await rpc("anvil_impersonateAccount", [who]);
  await rpc("anvil_setBalance", [who, "0x8AC7230489E80000"]);
  await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
  await rpc("anvil_setBalance", [POOL_MANAGER, "0x56BC75E2D63100000"]);
  await sendAs(POOL_MANAGER, IMD, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, imd] }));
  await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
  await sendAs(who, IMD, encodeFunctionData({ abi: erc20, functionName: "approve", args: [VAULT, imd] }));
  await sendAs(who, VAULT, encodeFunctionData({ abi: vaultAbi, functionName: "lockIMD", args: [imd] }));
  return who;
}
/** Re-date the three swarm feeds at their current values (slot 2 value, slot 3 hasValue << 64 | updatedAt). */
async function freshFeeds() {
  const block = await chain.getBlock();
  const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
  // The spot is set to the primary's value: the vault lends only while the two agree within its skew.
  const [primary] = await read(FEEDS.PriceFeed, feedAbi, "latestValue");
  for (const feed of Object.values(FEEDS)) {
    const [own] = await read(feed, feedAbi, "latestValue");
    const value = feed === FEEDS.SpotFeed ? primary : own;
    await rpc("anvil_setStorageAt", [feed, "0x2", hex(value)]);
    await rpc("anvil_setStorageAt", [feed, "0x3", hex((1n << 64n) + block.timestamp)]);
  }
  await rpc("evm_mine");
}
const position = async (who) => {
  const [collateral] = await read(VAULT, vaultAbi, "positions", [who]);
  return {
    collateral,
    debt: await read(VAULT, vaultAbi, "debtOf", [who]),
    cr: await read(VAULT, vaultAbi, "collateralRatio", [who]),
    imdusd: await read(IMDUSD, erc20, "balanceOf", [who]),
  };
};

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (!pathname.startsWith("/preview/")) return res.writeHead(404).end();
    const suffix = decodeURIComponent(pathname.slice(9)) || "index.html";
    const path = resolve(dist, suffix.endsWith("/") ? `${suffix}index.html` : suffix);
    if (!path.startsWith(dist + "/")) throw Error("path");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
    res.setHeader("Content-Type", types[extname(path)] || "application/octet-stream");
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const errors = [];
const failed = [];
const results = [];
const passed = (name) => (results.push(name), console.log("PASS", name));

/** A browser wallet that really signs through the fork. With `batch`, it also answers EIP-5792. */
async function open(account, { batch = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const forked = ["ethereum-rpc.publicnode.com", "eth.drpc.org", "rpc.mevblocker.io", "eth-mainnet.public.blastapi.io", new URL(RPC).host];
  await context.route((url) => url.protocol === "https:" || url.href.startsWith(RPC), async (route) => {
    const req = route.request();
    const host = new URL(req.url()).host;
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
    if (forked.includes(host) && req.method() === "POST") {
      // eth_getLogs reaching before the fork point is answered from Etherscan (the fork's upstream refuses history);
      // everything else goes to the fork.
      const body = JSON.parse(req.postData());
      const one = async (q) => {
        const res = q.method === "eth_getLogs" ? { jsonrpc: "2.0", id: q.id, result: await forkLogs(q.params[0]) } : await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) })).json();
        if (res.error) failed.push(`rpc ${q.method} ${JSON.stringify(q.params).slice(0, 160)} -> ${res.error.message?.slice(0, 120)}`);
        return res;
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      return route.fulfill({ status: 200, body: JSON.stringify(out), headers: { "content-type": "application/json", ...cors } });
    }
    if (forked.includes(host) && req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    // An explorer for the fork: an address's logs from Etherscan up to the fork point, then the fork's own blocks.
    const explorerLogs = new URL(req.url()).pathname.match(/^\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})\/logs$/);
    if (host === "eth.blockscout.com" && explorerLogs) {
      const address = explorerLogs[1];
      const before = await etherscanLogs(address, [], 26_160_000, forkBlock);
      const after = await rpc("eth_getLogs", [{ address, fromBlock: "0x" + (forkBlock + 1).toString(16), toBlock: "latest" }]);
      const items = [...before, ...after].map((l) => ({ address: { hash: l.address }, topics: l.topics, data: l.data, block_number: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex)), transaction_hash: l.transactionHash }));
      items.sort((x, y) => y.block_number - x.block_number || y.index - x.index);
      return route.fulfill({ json: { items, next_page_params: null }, headers: cors });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (q) => failed.push(`${q.method()} ${q.url().slice(0, 140)}`));
  await page.addInitScript(
    ({ account, rpc, batch }) => {
      let connected = false;
      let id = 0;
      const batches = {};
      const forward = async (method, params) => {
        const r = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
        });
        const j = await r.json();
        if (j.error) throw Object.assign(Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j.result;
      };
      const receipt = async (hash) => {
        for (;;) {
          const r = await forward("eth_getTransactionReceipt", [hash]);
          if (r) return r;
          await new Promise((d) => setTimeout(d, 200));
        }
      };
      window.ethereum = {
        isMetaMask: true,
        on: () => {},
        removeListener: () => {},
        request: async ({ method, params }) => {
          if (method === "eth_accounts") return connected ? [account] : [];
          if (method === "eth_requestAccounts") return (connected = true), [account];
          if (method === "eth_chainId") return "0x1";
          if (method === "eth_sendTransaction") return forward(method, [{ ...params[0], from: account }]);
          if (method === "wallet_getCapabilities") {
            if (!batch) throw Object.assign(Error("Method not supported"), { code: 4200 });
            return { "0x1": { atomic: { status: "supported" } } };
          }
          if (method === "wallet_sendCalls") {
            if (!batch) throw Object.assign(Error("Method not supported"), { code: 4200 });
            // Stand-in: the calls one after another (anvil has no atomic batch); the page sees one id and one status.
            window.__batches = (window.__batches ?? 0) + 1;
            const bid = "0x" + (++id).toString(16).padStart(64, "0");
            batches[bid] = (async () => {
              const receipts = [];
              for (const c of params[0].calls) {
                const hash = await forward("eth_sendTransaction", [{ from: account, to: c.to, data: c.data, value: c.value }]);
                const r = await receipt(hash);
                receipts.push(r);
                if (r.status !== "0x1") break;
              }
              return receipts;
            })();
            return { id: bid };
          }
          if (method === "wallet_getCallsStatus") {
            const receipts = await batches[params[0]];
            const ok = receipts.every((r) => r.status === "0x1");
            return { version: "2.0.0", id: params[0], chainId: "0x1", atomic: true, status: ok ? 200 : 500, receipts };
          }
          return forward(method, params);
        },
      };
    },
    { account, rpc: RPC, batch },
  );
  await page.goto(`${url}terminal/`);
  await page.getByRole("button", { name: "Refresh state", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Position", exact: true }).click();
  await page.locator('button[aria-label="Disconnected: connect a wallet"]:visible').first().click();
  await page
    .getByRole("button", { name: "Loop leverage ↗" })
    .waitFor()
    .catch(async (e) => {
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/open-stuck.png` });
      throw Error(`${e.message}\npage errors: ${errors.join("; ")}\npage: ${(await page.locator("body").innerText()).slice(0, 1500)}`);
    });
  return { page, context };
}



const payload = JSON.parse(await readFile(process.argv[2] ?? "/Users/azp/a11/infer-token/launch/out/season-1-open.json"));
const openData = payload.transactions[0].data;
const svAbi = parseAbi(["function opened() view returns (uint256)", "function season(uint256) view returns ((uint64 start, uint64 rootSetAt, bool expired, uint256 pot, bytes32 formula, bytes32 root, uint256 total, uint256 registered, uint256 paid, bytes32 pendingRoot, uint256 pendingTotal, uint64 pendingEta))"]);
async function fund(who, imdusd) {
  await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
  await rpc("anvil_setBalance", [POOL_MANAGER, "0x56BC75E2D63100000"]);
  await sendAs(POOL_MANAGER, IMDUSD, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, imdusd] }));
  await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
}
const pane = (page) => page.locator(".pane-points");
async function refresh(page) {
  await page.getByRole("button", { name: "Refresh state", exact: true }).click();
  await page.waitForTimeout(1500);
}
const hero = async (page) => Number((await pane(page).locator(".hero-stat strong").innerText()).replace(/,/g, ""));

const snapshot = await rpc("evm_snapshot");
try {
  await freshFeeds();
  const who = privateKeyToAccount(generatePrivateKey()).address;
  await rpc("anvil_impersonateAccount", [who]);
  await rpc("anvil_setBalance", [who, "0x8AC7230489E80000"]);
  await fund(who, 1000n * E18);
  const { page } = await open(who);
  await page.getByRole("tab", { name: "Points", exact: true }).click();
  await until("the board", async () => /Season 1 is yet to start/.test(await pane(page).innerText()), 180_000);
  passed("before opening: the preseason banner, counting");

  // The Safe executes the real payload.
  await rpc("anvil_impersonateAccount", [SAFE]);
  await rpc("anvil_setBalance", [SAFE, "0x56BC75E2D63100000"]);
  const hash = await rpc("eth_sendTransaction", [{ from: SAFE, to: SEASON_VAULT, data: openData }]);
  const receipt = await chain.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  const opened = Number(receipt.blockNumber);
  const s = await read(SEASON_VAULT, svAbi, "season", [0n]);
  const start = Number(s.start);
  await refresh(page);
  await until("the countdown", async () => /Season 1 starts/.test(await pane(page).innerText()), 240_000).catch(async (e) => {
    throw Error(`${e.message}\npane: ${(await pane(page).innerText()).slice(0, 600)}\nfooter: ${await page.locator("footer").innerText()}\nerrors: ${errors.join("; ")}\nfailed: ${[...new Set(failed.map((f) => f.replace(/\[.*?\] ->/, "->").slice(0, 120)))].join("\n  ")}`);
  });
  const text = await pane(page).innerText();
  assert.match(text, new RegExp(`closed at block ${opened.toLocaleString("en-US")}`), text);
  assert.match(text, /\(final\)/);
  const frozen = await hero(page);
  await rpc("anvil_mine", ["0x32", "0xc"]);
  await refresh(page);
  await page.waitForTimeout(3000);
  assert.equal(await hero(page), frozen, "the preseason total no longer moves");
  passed(`after opening at block ${opened}: countdown to the start, preseason frozen at ${frozen} points`);

  // Past the start: the wallet has held 1,000 imdUSD throughout.
  await rpc("evm_setNextBlockTimestamp", ["0x" + (start + 12).toString(16)]);
  await rpc("evm_mine");
  const startBlock = Number(await rpc("eth_blockNumber"));
  await rpc("anvil_mine", ["0xc8", "0xc"]);
  await freshFeeds();
  await refresh(page);
  await until("Season 1 live", async () => /Season 1 is live/.test(await pane(page).innerText()), 180_000);
  const head = Number(await rpc("eth_blockNumber"));
  const expected = (1000 * (head - startBlock)) / 7200;
  await page.waitForTimeout(2000);
  const got = await hero(page);
  assert.ok(Math.abs(got - expected) <= Math.max(0.6, expected * 0.03), `Season 1 points ${got}, expected about ${expected.toFixed(2)} (1,000 imdUSD x ${head - startBlock} blocks)`);
  const live = await pane(page).innerText();
  assert.match(live, /Your Season 1 points/);
  assert.match(live, /Est\. INFER\s+≈ [\d,]+ INFER/);
  if (SHOTS) await page.locator(".pane-points").screenshot({ path: `${SHOTS}/season1-live.png` });
  passed(`after the start: Season 1 live, ${got} points for 1,000 imdUSD over ${head - startBlock} blocks (expected ${expected.toFixed(2)}), with an INFER estimate`);

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log(`\n${results.length} passed`);
} finally {
  await browser.close();
  server.close();
  await rpc("evm_revert", [snapshot]);
}
