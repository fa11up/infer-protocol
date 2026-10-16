// Screenshots of the terminal's newer features for the Season 1 article, against the LIVE deployment on a local
// mainnet fork with a funded test wallet (nothing touches mainnet). Writes PNGs (2x) to E2E_SHOTS.
//
//   anvil --fork-url <mainnet rpc> --port 8547
//   node scripts/mainnet-deployment.mjs --record <release>/deploy/mainnet/out/deployment.json --commit b2c7afe --rpc http://127.0.0.1:8547
//   npx vite build && node scripts/manifest.mjs
//   E2E_RPC=http://127.0.0.1:8547 E2E_SHOTS=<dir> node tests/article-shots.mjs     (then git checkout web/deployment-source.json)
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
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
    // The explorer is read-only: let it answer (the fork's test wallet simply has no positions there).
    if (host === "eth.blockscout.com") return route.continue();
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
  await page.getByRole("button", { name: "Loop leverage ↗" }).waitFor({ timeout: 90_000 });
  return { page, context };
}



async function fund(who, imdusd, usdc) {
  await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
  await rpc("anvil_setBalance", [POOL_MANAGER, "0x56BC75E2D63100000"]);
  await sendAs(POOL_MANAGER, IMDUSD, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, imdusd] }));
  await sendAs(POOL_MANAGER, USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, usdc] }));
  await sendAs(POOL_MANAGER, IMD, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, 20n * E18] }));
  await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
}
const shot = async (locator, name) => {
  await locator.screenshot({ path: `${SHOTS}/${name}.png` });
  console.log("shot", name);
};
if (!SHOTS) throw Error("set E2E_SHOTS");
const snapshot = await rpc("evm_snapshot");
try {
  // A peg at $1, as the article describes the normal case: buyers restore it on the fork.
  for (let i = 0; i < 60; i++) {
    const [now] = await read("0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227", parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"]), "getSlot0", ["0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035"]);
    // Stop inside Season 1's band ($0.99-$1.01), buying in smaller steps close to it so it does not overshoot.
    const usd = (Number(now) / 2 ** 96) ** 2 * 1e12;
    console.log("peg", usd.toFixed(4));
    if (usd >= 0.997) break;
    await arbitrage((usd < 0.985 ? 1_000n : 150n) * 10n ** 6n);
  }
  await freshFeeds();
  const a = await borrower(100n * E18);
  await fund(a, 300n * E18, 300n * 10n ** 6n);
  const { page } = await open(a, { batch: true });
  const pos = page.locator(".pane-position");

  // 1. Position preview under the action, and the batched approval in the review.
  await pos.getByRole("button", { name: "Borrow", exact: true }).click();
  await pos.getByLabel("Borrow imdUSD", { exact: true }).fill("150");
  await pos.locator(".position-after").waitFor();
  await shot(page.locator(".pane-position .desk-body"), "1-position-preview");
  await pos.getByRole("button", { name: "Deposit", exact: true }).click();
  await pos.getByLabel("Deposit IMD", { exact: true }).fill("10");
  await pos.locator(".position-after").waitFor();
  await pos.getByRole("button", { name: "Review deposit", exact: true }).click();
  const review = page.locator("dialog[open]").first();
  await until("the steps", async () => /Approve exactly 10 IMD/.test(await review.innerText()));
  await shot(review, "2-batched-review");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();

  // 2. Loop leverage: pick 2x, the plan appears.
  await page.getByRole("button", { name: "Loop leverage ↗" }).click();
  const loop = page.locator("dialog.loop-dialog[open]");
  await loop.getByRole("button", { name: "2×", exact: true }).click();
  await until("a plan", async () => (await loop.locator(".loop-plan").count()) > 0, 120_000);
  await shot(loop, "3-loop-leverage-plan");
  await loop.getByRole("button", { name: "Close", exact: true }).click();

  // 3. Pool liquidity: add, then the position under "Your positions".
  await page.getByRole("button", { name: "Pool liquidity ↗" }).click();
  const lp = page.locator("dialog.loop-dialog[open]");
  await until("the pool read", async () => /\$[0-9]/.test(await lp.locator(".loop-now").innerText()));
  await lp.locator("input[name=lp-imdusd]").fill("100");
  await until("USDC filled in", async () => Number(await lp.locator("input[name=lp-usdc]").inputValue()) > 0);
  await page.waitForTimeout(500);
  await shot(lp, "4-pool-liquidity-add");
  await lp.getByRole("button", { name: /Add liquidity|Confirm deposit in wallet/ }).click();
  await until("added", async () => /^Added/.test(await lp.locator('[role="status"].action-note').innerText()), 180_000);
  await lp.getByRole("button", { name: "Your positions", exact: true }).click();
  await until("listed", async () => (await lp.locator(".loop-plan").filter({ hasText: "Position #" }).count()) === 1, 120_000);
  await shot(lp, "5-pool-liquidity-positions");
  await lp.getByRole("button", { name: "Close", exact: true }).last().click();

  // 4. The whole terminal, Position tab, for context.
  await page.mouse.move(5, 5);
  await shot(page.locator("body"), "6-terminal-position");
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
} finally {
  await browser.close();
  server.close();
  await rpc("evm_revert", [snapshot]);
}
