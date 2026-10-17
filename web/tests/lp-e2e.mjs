// The peg-pool liquidity window, batched approvals and the after-action preview, against the LIVE deployment on a
// local mainnet fork, from a browser whose wallet really signs (an impersonated fresh account, every call forwarded
// to the fork): add liquidity one step at a time, find the position, take half, close it; add again with a wallet
// that answers EIP-5792 (one batch); deposit with the approval in the same batch; borrow and check that the ratio the
// preview showed is the ratio the vault reports. Blockscout is unreachable here, so positions are found from the ids
// this browser remembered (the explorer-down path).
//
//   anvil --fork-url <mainnet rpc> --port 8549
//   node scripts/mainnet-deployment.mjs --record <release>/deploy/mainnet/out/deployment.json --commit b2c7afe --rpc http://127.0.0.1:8549
//   npx vite build && node scripts/manifest.mjs
//   E2E_RPC=http://127.0.0.1:8549 node tests/lp-e2e.mjs        (then git checkout web/deployment-source.json)
//
// Screenshots land in E2E_SHOTS (default: none taken).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPublicClient, http, parseAbi, getAddress, encodeFunctionData } from "viem";
import { USDC } from "../src/leverage.ts";
import { POSITION_MANAGER } from "../src/lp.ts";
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
  await page
    .getByRole("button", { name: "Loop leverage ↗" })
    .waitFor()
    .catch(async (e) => {
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/open-stuck.png` });
      throw Error(`${e.message}\npage errors: ${errors.join("; ")}\npage: ${(await page.locator("body").innerText()).slice(0, 1500)}`);
    });
  return { page, context };
}


const pmAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** imdUSD and USDC for a liquidity provider, from the PoolManager's balances (as the harness funds IMD). */
async function fund(who, imdusd, usdc) {
  await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
  await rpc("anvil_setBalance", [POOL_MANAGER, "0x56BC75E2D63100000"]);
  await sendAs(POOL_MANAGER, IMDUSD, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, imdusd] }));
  await sendAs(POOL_MANAGER, USDC, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [who, usdc] }));
  await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
}
const nfts = (who) => read(POSITION_MANAGER, pmAbi, "balanceOf", [who]);
const note = (dialog) => dialog.locator('[role="status"].action-note').innerText();
async function waitNote(page, dialog, pattern, shot) {
  return until(
    `window says ${pattern}`,
    async () => {
      const n = await note(dialog);
      if (/reverted|stopped|denied|failed|did not go through|Not ready/i.test(n)) throw fatal(n);
      return pattern.test(n) && n;
    },
    180_000,
  ).catch(async (e) => {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-stuck.png` });
    throw Error(`${e.message}\nfooter: ${await page.locator("footer").innerText().catch(() => "")}`);
  });
}
async function addLiquidity(page, imdusd, shot) {
  await page.getByRole("button", { name: "imdUSD liquidity ↗" }).click();
  const dialog = page.locator("dialog.loop-dialog[open]");
  await dialog.waitFor();
  await until("the pool read", async () => /\$[0-9]/.test(await dialog.locator(".loop-now").innerText()));
  await dialog.locator("input[name=lp-imdusd]").fill(imdusd);
  // The default range is the peg band ($0.99-$1.01). If the fork's pool sits outside it, a band position takes one
  // token only (the USDC box stays empty): this flow needs both, so it uses the wide range then.
  const usdcIn = async () => Number(await dialog.locator("input[name=lp-usdc]").inputValue()) > 0;
  try {
    await until("USDC filled in (peg band)", usdcIn, 6_000);
  } catch {
    await dialog.getByRole("group", { name: "Range for a new position" }).getByRole("button", { name: /^Wide/ }).click();
    await dialog.locator("input[name=lp-imdusd]").fill(imdusd);
    // Under $0.9522 even the wide range takes imdUSD only: the position is one-sided, and that is still a deposit.
    await until("USDC filled in (wide)", usdcIn, 6_000).catch(() => console.log(`  (the pool is under the wide range: a one-sided ${imdusd} imdUSD position)`));
  }
  const usdc = Number(await dialog.locator("input[name=lp-usdc]").inputValue());
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}.png` });
  await dialog.getByRole("button", { name: /Add liquidity|Confirm deposit in wallet/ }).click();
  await waitNote(page, dialog, /^Added/, shot);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${shot}-done.png` });
  return { dialog, usdc };
}

const snapshot = await rpc("evm_snapshot");
try {
  await freshFeeds();
  // ---- Liquidity, one step at a time ---------------------------------------------------------------------
  const a = await borrower(50n * E18);
  await fund(a, 200n * E18, 200n * 10n ** 6n);
  const { page } = await open(a);
  const s0 = await read(IMDUSD, erc20, "balanceOf", [a]);
  const { dialog, usdc } = await addLiquidity(page, "50", "lp-1-add");
  const s1 = await read(IMDUSD, erc20, "balanceOf", [a]);
  assert.equal(await nfts(a), 1n, "one position minted");
  assert.ok(s0 - s1 <= 50n * E18 + 1n && s0 - s1 >= 50n * E18 - 10n ** 12n, `took ${s0 - s1} imdUSD wei`);
  passed(`added 50 imdUSD + ${usdc} USDC in five signed steps (two approvals per token, then the mint)`);

  await dialog.getByRole("button", { name: "Your positions", exact: true }).click();
  const row = dialog.locator(".loop-plan").filter({ hasText: "Position #" });
  await until("the position listed", async () => (await row.count()) === 1);
  const listed = await row.innerText();
  assert.match(listed, /49\.\d\d imdUSD|50\.00 imdUSD/, listed);
  passed("the new position is listed with the explorer unreachable (remembered id, checked on chain)");

  await row.getByRole("button", { name: "Take 50%" }).click();
  await waitNote(page, dialog, /^Took 50%/, "lp-2-half");
  const s2 = await read(IMDUSD, erc20, "balanceOf", [a]);
  assert.ok(s2 - s1 >= 24n * E18, `half returned ${s2 - s1}`);
  await until("the position re-read", async () => /2[45]\.\d\d imdUSD/.test(await row.innerText()));
  await row.getByRole("button", { name: "Close" }).click();
  await waitNote(page, dialog, /closed/, "lp-3-close");
  assert.equal(await nfts(a), 0n, "closing burns the NFT");
  const s3 = await read(IMDUSD, erc20, "balanceOf", [a]);
  assert.ok(s0 - s3 <= 10n ** 12n, `left ${s0 - s3} imdUSD wei behind`);
  passed("took half, then closed: the NFT is burned and the imdUSD is back");
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();

  // ---- The after-action preview matches the chain --------------------------------------------------------
  const pos = page.locator(".pane-position");
  await pos.getByRole("button", { name: "Borrow", exact: true }).click();
  await pos.getByLabel("Borrow imdUSD", { exact: true }).fill("10");
  const preview = await pos.locator(".position-after").innerText();
  const predicted = Number(/→\s*(\d+)%/.exec(preview)?.[1]);
  assert.ok(predicted > 0, preview);
  assert.match(preview, /Liquidation price\s+\$[0-9]/);
  await pos.getByRole("button", { name: "Review borrow", exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Confirm in wallet" }).click();
  await until("the borrow confirmed", async () => /Confirmed on chain/.test(await page.locator("footer").innerText()), 120_000);
  const after = await position(a);
  assert.ok(Math.abs(Number(after.cr) - predicted) <= 1, `preview said ${predicted}%, vault says ${after.cr}%`);
  passed(`the borrow preview said ${predicted}%, the vault reports ${after.cr}%`);

  // ---- One signature -------------------------------------------------------------------------------------
  await freshFeeds();
  const b = await borrower(10n * E18);
  await fund(b, 100n * E18, 100n * 10n ** 6n);
  await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
  await sendAs(POOL_MANAGER, IMD, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [b, 5n * E18] }));
  await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
  const { page: batchPage } = await open(b, { batch: true });
  await addLiquidity(batchPage, "20", "lp-4-batch");
  assert.equal(await batchPage.evaluate(() => window.__batches), 1, "one wallet_sendCalls for approvals + mint");
  assert.equal(await nfts(b), 1n);
  passed("with an EIP-5792 wallet, the approvals and the mint are one batch");
  await batchPage.locator("dialog.loop-dialog[open]").getByRole("button", { name: "Close", exact: true }).last().click();

  const held = (await position(b)).collateral;
  const bpos = batchPage.locator(".pane-position");
  await bpos.getByRole("button", { name: "Deposit", exact: true }).click();
  await bpos.getByLabel("Deposit IMD", { exact: true }).fill("5");
  await bpos.getByRole("button", { name: "Review deposit", exact: true }).click();
  const review = batchPage.locator("dialog[open]");
  await until("the steps listed", async () => /Approve exactly 5 IMD/.test(await review.innerText()));
  assert.match(await review.innerText(), /one signature/);
  await review.getByRole("button", { name: "Confirm in wallet" }).click();
  await until("the deposit confirmed", async () => /Confirmed on chain/.test(await batchPage.locator("footer").innerText()), 120_000);
  assert.equal(await batchPage.evaluate(() => window.__batches), 2, "the deposit was the second batch");
  assert.ok((await position(b)).collateral > held, "collateral grew");
  passed("Deposit IMD: approval and lockIMD as one batch from one review");

  // ---- Trade: buy imdUSD with USDC, then sell imdUSD for USDC, on the peg pool ------------------------------
  const trade = async (direction, amount, shot) => {
    await batchPage.getByRole("button", { name: "imdUSD liquidity ↗" }).click();
    const dlg = batchPage.locator("dialog.loop-dialog[open]");
    await dlg.waitFor();
    await dlg.getByRole("group", { name: "Liquidity view" }).getByRole("button", { name: "Trade", exact: true }).click();
    await dlg.getByRole("group", { name: "Trade direction" }).getByRole("button", { name: direction }).click();
    await dlg.locator("input[name=lp-trade]").fill(amount);
    await until("the quote", async () => /You receive/.test(await dlg.innerText()), 60_000);
    const text = await dlg.innerText();
    const num = (label) => Number((new RegExp(`${label}\\s+([\\d,.]+)`).exec(text)?.[1] ?? "").replace(/,/g, ""));
    const quotedOut = num("You receive");
    const least = num("At least");
    assert.ok(quotedOut > 0 && least > 0 && least <= quotedOut, text);
    if (SHOTS) await dlg.screenshot({ path: `${SHOTS}/${shot}.png` });
    const accept = dlg.locator(".loop-check input");
    if (await accept.count()) await accept.check();
    await dlg.getByRole("button", { name: /Confirm swap in wallet|^Swap$/ }).click();
    await waitNote(batchPage, dlg, /^Swapped/, shot);
    const got = Number(/for ([\d,.]+) /.exec(await note(dlg))?.[1].replace(/,/g, ""));
    await dlg.getByRole("button", { name: "Close", exact: true }).last().click();
    return { quotedOut, least, got };
  };
  const u0 = await read(USDC, erc20, "balanceOf", [b]);
  const i0 = await read(IMDUSD, erc20, "balanceOf", [b]);
  const buy = await trade("Buy imdUSD with USDC", "20", "lp-5-buy");
  const u1 = await read(USDC, erc20, "balanceOf", [b]);
  const i1 = await read(IMDUSD, erc20, "balanceOf", [b]);
  assert.equal(u0 - u1, 20n * 10n ** 6n, "paid exactly 20 USDC");
  const bought = Number(i1 - i0) / 1e18;
  assert.ok(bought >= buy.least && Math.abs(bought - buy.quotedOut) / buy.quotedOut < 0.005, `bought ${bought}, quoted ${buy.quotedOut}, at least ${buy.least}`);
  passed(`Trade: 20 USDC bought ${bought.toFixed(4)} imdUSD (quoted ${buy.quotedOut}, at least ${buy.least})`);
  const sell = await trade("Sell imdUSD for USDC", "10", "lp-6-sell");
  const u2 = await read(USDC, erc20, "balanceOf", [b]);
  const i2 = await read(IMDUSD, erc20, "balanceOf", [b]);
  assert.equal(i1 - i2, 10n * E18, "sold exactly 10 imdUSD");
  const received = Number(u2 - u1) / 1e6;
  assert.ok(received >= sell.least && Math.abs(received - sell.quotedOut) / sell.quotedOut < 0.005, `received ${received}, quoted ${sell.quotedOut}, at least ${sell.least}`);
  passed(`Trade: 10 imdUSD sold for ${received.toFixed(4)} USDC (quoted ${sell.quotedOut}, at least ${sell.least})`);

  assert.deepEqual(errors.filter((e) => !/blockscout/i.test(e)), [], `page errors: ${errors.join("; ")}`);
  console.log(`\n${results.length} passed`);
} finally {
  await browser.close();
  server.close();
  await rpc("evm_revert", [snapshot]);
}
