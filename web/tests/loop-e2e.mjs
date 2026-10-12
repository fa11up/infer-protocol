// The Leverage window against the LIVE deployment on a local mainnet fork: a browser whose wallet really signs
// (an impersonated fresh account, every call forwarded to the fork) opens the window, takes the suggested
// maximum, runs two rounds up and one round down, and the chain is read after each. Then the same window with a
// wallet that answers EIP-5792 (wallet_getCapabilities / wallet_sendCalls) runs a round as one batch.
//
//   anvil --fork-url <mainnet rpc> --port 8549
//   node scripts/mainnet-deployment.mjs --record <release>/deploy/mainnet/out/deployment.json --commit b2c7afe --rpc http://127.0.0.1:8549
//   npx vite build && node scripts/manifest.mjs
//   E2E_RPC=http://127.0.0.1:8549 node tests/loop-e2e.mjs        (then git checkout web/deployment-source.json)
//
// Screenshots land in E2E_SHOTS (default: none taken).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPublicClient, http, parseAbi, getAddress, encodeFunctionData } from "viem";
import { encodeSwap, PERMIT2, UNIVERSAL_ROUTER } from "../src/infer/swap.ts";
import { PEG_KEY, UNISWAP, USDC } from "../src/leverage.ts";
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

const chain = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
const rpc = (method, params = []) => chain.request({ method, params });
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
  for (const feed of Object.values(FEEDS)) {
    const [value] = await read(feed, feedAbi, "latestValue");
    await rpc("anvil_setStorageAt", [feed, "0x2", hex(value)]);
    await rpc("anvil_setStorageAt", [feed, "0x3", hex((1n << 64n) + block.timestamp)]);
  }
  await rpc("evm_mine");
}
/** An arbitrageur: buys imdUSD on the peg pool with `usdc` USDC (6 decimals), as anyone would below $1. */
async function arbitrage(usdc) {
  const who = privateKeyToAccount(generatePrivateKey()).address;
  await rpc("anvil_impersonateAccount", [who]);
  await rpc("anvil_setBalance", [who, "0x8AC7230489E80000"]);
  await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
  await sendAs(POOL_MANAGER, USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, usdc] }));
  await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
  const block = await chain.getBlock();
  await sendAs(who, USDC, encodeFunctionData({ abi: erc20, functionName: "approve", args: [UNISWAP.permit2, usdc] }));
  await sendAs(
    who,
    UNISWAP.permit2,
    encodeFunctionData({ abi: PERMIT2, functionName: "approve", args: [USDC, UNISWAP.universalRouter, usdc, Number(block.timestamp + 600n)] }),
  );
  const swap = encodeSwap({ key: PEG_KEY, tokenIn: USDC, amountIn: usdc, minOut: 0n });
  await sendAs(
    who,
    UNISWAP.universalRouter,
    encodeFunctionData({ abi: UNIVERSAL_ROUTER, functionName: "execute", args: [swap.commands, swap.inputs, block.timestamp + 600n] }),
  );
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
const results = [];
const passed = (name) => (results.push(name), console.log("PASS", name));

/** A browser wallet that really signs through the fork. With `batch`, it also answers EIP-5792. */
async function open(account, { batch = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const forked = ["ethereum-rpc.publicnode.com", "eth.drpc.org", "rpc.mevblocker.io", "eth-mainnet.public.blastapi.io"];
  await context.route(/^https:\/\//, async (route) => {
    const req = route.request();
    const host = new URL(req.url()).host;
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
    if (forked.includes(host) && req.method() === "POST") {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: req.postData() });
      return route.fulfill({ status: r.status, body: await r.text(), headers: { "content-type": "application/json", ...cors } });
    }
    if (forked.includes(host) && req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (e) => errors.push(e.message));
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
  await page.getByRole("button", { name: "Leverage loop ↗" }).waitFor();
  return { page, context };
}

/** Open the window in a direction, take the maximum, run one round, wait for "Round done". */
async function round(page, direction, shot) {
  if (!(await page.locator("dialog.loop-dialog[open]").count()))
    await page.getByRole("button", { name: "Leverage loop ↗" }).click();
  const dialog = page.locator("dialog.loop-dialog[open]");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: direction, exact: true }).click();
  const max = dialog.locator("button.balance-use");
  await until("a maximum", async () => (await max.isEnabled()) && /Max [1-9]|Max 0\.[0-9]*[1-9]/.test(await max.textContent()), 240_000).catch(
    async (e) => {
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-no-max.png` });
      throw Error(`${e.message}\nwindow: ${await dialog.innerText().catch(() => "")}`);
    },
  );
  await max.click();
  const start = dialog.getByRole("button", { name: /Start round|Start deleverage|Confirm round in wallet/ });
  await until("the round quoted", () => start.isEnabled());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}.png` });
  const plan = await dialog.locator(".loop-plan").innerText();
  await start.click();
  await until(
    "the round done",
    async () => {
      const note = await dialog.locator('[role="status"].action-note').innerText();
      if (/reverted|stopped|denied|failed|did not go through/i.test(note)) throw fatal(note);
      return /Round done/.test(note);
    },
    180_000,
  ).catch(async (e) => {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-stuck.png` });
    const note = await dialog.locator('[role="status"].action-note').innerText().catch(() => "");
    const footer = await page.locator("footer").innerText().catch(() => "");
    throw Error(`${e.message}\nwindow: ${note}\nfooter: ${footer}`);
  });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-done.png` });
  return plan;
}
const planned = (plan, label) => Number(new RegExp(`${label}\\s+([0-9.]+)%`).exec(plan)?.[1]);

// Every run starts from the fork as it was and leaves it that way: a round moves the peg pool.
const snapshot = await rpc("evm_snapshot");
try {
  // ---- Stale prices, as mainnet often is between purchases: the window says what to do instead of failing --
  const a = await borrower(100n * E18);
  const before = await position(a);
  const { page } = await open(a);
  if (await read(FEEDS.PriceFeed, parseAbi(["function isStale() view returns (bool)"]), "isStale")) {
    await page.getByRole("button", { name: "Leverage loop ↗" }).click();
    const dialog = page.locator("dialog.loop-dialog[open]");
    await until("the stale-price refusal", async () => /Update price/.test(await dialog.locator('[role="status"].action-note').innerText()));
    passed("with stale prices the window points to Update price");
  }
  await freshFeeds();
  // ---- One by one ------------------------------------------------------------------------------------------
  let plan = await round(page, "Leverage up", "1-up");
  let after = await position(a);
  assert.ok(after.debt > 0n && after.collateral > before.collateral, "round up borrowed and deposited");
  assert.equal(after.imdusd, 0n, "the whole borrow was swapped");
  assert.ok(Math.abs(Number(after.cr) - planned(plan, "Ratio after round")) <= 2, `CR ${after.cr} vs plan\n${plan}`);
  passed(`round up: debt ${Number(after.debt) / 1e18} imdUSD, CR ${after.cr}% (planned ${planned(plan, "Ratio after round")}%)`);

  // The round left the peg pool at the band's edge: the window must say so rather than sell into it.
  {
    const dialog = page.locator("dialog.loop-dialog[open]");
    await dialog.locator("input[name=loop-amount]").fill("50");
    let note = "";
    await until("the peg refusal", async () => /\$0\.9975/.test((note = await dialog.locator('[role="status"].action-note').innerText())), 180_000).catch(
      async (e) => {
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/peg-refusal-stuck.png` });
        throw Error(`${e.message}\nwindow: ${note}`);
      },
    );
    assert.ok(await dialog.getByRole("button", { name: /Start round|Confirm round/ }).isDisabled());
    await dialog.locator("input[name=loop-amount]").fill("");
    passed("with the peg at the band's edge the window refuses another sale");
  }
  // Arbitrage brings it back, as it would on mainnet (imdUSD under $1 is cheap to buy and repay or redeem with).
  await arbitrage(250n * 10n ** 6n);
  await freshFeeds();
  const mid = after;
  plan = await round(page, "Leverage up", "2-up-again");
  after = await position(a);
  assert.ok(after.debt > mid.debt && after.cr < mid.cr, "a second round adds leverage");
  assert.ok(after.cr >= 180n, "never under minCR + buffer");
  passed(`second round: debt ${Number(after.debt) / 1e18}, CR ${after.cr}%`);

  await freshFeeds();
  const high = after;
  plan = await round(page, "Deleverage", "3-down");
  after = await position(a);
  assert.ok(after.debt < high.debt && after.collateral < high.collateral, "round down withdrew and repaid");
  passed(`round down: debt ${Number(high.debt) / 1e18} -> ${Number(after.debt) / 1e18}, CR ${after.cr}%`);

  // ---- One signature ---------------------------------------------------------------------------------------
  await freshFeeds();
  const b = await borrower(100n * E18);
  const { page: batchPage } = await open(b, { batch: true });
  await batchPage.getByRole("button", { name: "Leverage loop ↗" }).click();
  await batchPage.locator("dialog.loop-dialog[open] .loop-check input").waitFor();
  plan = await round(batchPage, "Leverage up", "4-batch-up");
  const batches = await batchPage.evaluate(() => window.__batches);
  after = await position(b);
  assert.equal(batches, 1, "one wallet_sendCalls for the round");
  assert.ok(after.debt > 0n && after.imdusd === 0n, "batched round borrowed, swapped and deposited");
  passed(`batched round: one signature, debt ${Number(after.debt) / 1e18}, CR ${after.cr}%`);

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log(`\n${results.length} passed`);
} finally {
  await browser.close();
  server.close();
  await rpc("evm_revert", [snapshot]);
}
