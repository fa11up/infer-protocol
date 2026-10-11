// The terminal against a REAL deployment on a local mainnet fork (../../imd/terminal-e2e.sh builds it):
// a browser whose wallet really signs (anvil's unlocked test accounts, forwarded to the fork) drives
// deposit, borrow, repay, withdraw, buy update, redeem, mark and liquidate, and the chain is read after each.
//
//   E2E_RPC=http://127.0.0.1:8546 node tests/mainnet-e2e.mjs
//
// Nothing here is mocked except the wallet's confirmation prompt: every read and every transaction is the
// fork's. Remote https requests are refused, so the run is the deployment file's RPC and nothing else.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createPublicClient, http, parseAbi, getAddress, keccak256, encodeAbiParameters } from "viem";

const RPC = process.env.E2E_RPC ?? "http://127.0.0.1:8546";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC))
  throw Error("E2E_RPC must be a local fork");
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
// E2E_DIST=dist-public tests the launch build (npm run build:launch) instead of the staging one, served with
// the Content-Security-Policy from its own _headers, so a host the policy forgets fails here, not in production.
const dist = resolve(root, process.env.E2E_DIST || "dist");
const csp = await readFile(resolve(dist, "_headers"), "utf8")
  .then((h) => h.match(/Content-Security-Policy: (.*)/)?.[1])
  .catch(() => undefined);
// Served over http on this machine: upgrade-insecure-requests would turn the fork's http RPC into https.
// The fork's origin stands in for the deployment's RPCs, which it replaces in the deployment file.
const servedCsp = csp
  ?.replace(/;\s*upgrade-insecure-requests/, "")
  .replace(
    /connect-src ([^;]*)/,
    (_, list) => `connect-src ${list} ${new URL(RPC).origin}`,
  );
const source = JSON.parse(
  await readFile(resolve(root, "web/deployment-source.json")),
);
const byName = Object.fromEntries(
  source.contracts.map((c) => [c.name, getAddress(c.address)]),
);
const VAULT = byName.ParameterizedVault;
const ASKER = getAddress(source.oracleAsker.address);
const IMD = getAddress("0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7");
const POOL_MANAGER = getAddress("0x000000000004444c5dc75cB358380D2e3dE08A90"); // holds IMD; impersonated on the fork only
// anvil's public test accounts 1 and 2 (0 deployed the stack)
const BORROWER = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
const KEEPER = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");

const chain = createPublicClient({ transport: http(RPC) });
const rpc = (method, params = []) => chain.request({ method, params });
const vaultAbi = parseAbi([
  "function positions(address) view returns (uint256 collateral, uint256 debt)",
  "function debtOf(address) view returns (uint256)",
  "function stablecoin() view returns (address)",
  "function gem() view returns (address)",
  "function mat() view returns (uint256)",
  "function lull() view returns (uint256)",
  "function collateralPriceFeed() view returns (address)",
  "function liquidationMarks(address) view returns (uint256 markedAt, uint256 grace, bool marked, address marker)",
]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
]);
const feedAbi = parseAbi([
  "function latestValue() view returns (uint256, uint256)",
]);
const askerAbi = parseAbi([
  "function feeds(address) view returns (bytes32 bodyHash, bool tracksPool, bool keepAlive, uint64 lastAsk, uint64 armedAt, uint64 inFlightAt, bool treasuryPaid, bytes32 inFlight)",
]);
const read = (address, abi, functionName, args = []) =>
  chain.readContract({ address, abi, functionName, args });
const STABLE = await read(VAULT, vaultAbi, "stablecoin");
const GEM = await read(VAULT, vaultAbi, "gem");
const position = async (who) => {
  const [collateral, debt] = await read(VAULT, vaultAbi, "positions", [who]);
  return {
    collateral,
    debt: (await read(VAULT, vaultAbi, "debtOf", [who])) ?? debt,
  };
};
const bal = (token, who) => read(token, erc20, "balanceOf", [who]);
const E18 = 10n ** 18n;
// Chainlink cannot update on a fork, so a warp past ETH_USD_MAX_AGE (2 h) would leave ETH/USD stale. For the
// grace-period warp only, its proxy gets this stand-in's code: slot 0 holds the last real answer, dated now.
// Source: contract FakeAggregator { int256 public answer; decimals() = 8; latestRoundData() = (1, answer,
// block.timestamp, block.timestamp, 1) }, solc 0.8.26, bytecode_hash none.
const CHAINLINK_ETH_USD = getAddress(
  "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
);
const FAKE_AGGREGATOR =
  "0x608060405234801561000f575f80fd5b506004361061003f575f3560e01c8063313ce5671461004357806385bb7d6914610061578063feaf968c1461007f575b5f80fd5b61004b6100a1565b60405161005891906100e7565b60405180910390f35b6100696100a9565b6040516100769190610118565b60405180910390f35b6100876100ae565b60405161009895949392919061016d565b60405180910390f35b5f6008905090565b5f5481565b5f805f805f60015f5442426001945094509450945094509091929394565b5f60ff82169050919050565b6100e1816100cc565b82525050565b5f6020820190506100fa5f8301846100d8565b92915050565b5f819050919050565b61011281610100565b82525050565b5f60208201905061012b5f830184610109565b92915050565b5f69ffffffffffffffffffff82169050919050565b61014f81610131565b82525050565b5f819050919050565b61016781610155565b82525050565b5f60a0820190506101805f830188610146565b61018d6020830187610109565b61019a604083018661015e565b6101a7606083018561015e565b6101b46080830184610146565b969550505050505056fea164736f6c634300081a000a";

/** An error `until` must not retry past: the page said no. */
const fatal = (message) => Object.assign(Error(message), { fatal: true });
async function until(what, check, ms = 45_000) {
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

// Fund the two test wallets with IMD from the PoolManager (fork only).
await rpc("anvil_impersonateAccount", [POOL_MANAGER]);
await rpc("anvil_setBalance", [POOL_MANAGER, "0x56BC75E2D63100000"]);
for (const who of [BORROWER, KEEPER]) {
  const data = (await import("viem")).encodeFunctionData({
    abi: erc20,
    functionName: "transfer",
    args: [who, 3000n * E18],
  });
  const hash = await rpc("eth_sendTransaction", [
    { from: POOL_MANAGER, to: IMD, data },
  ]);
  await chain.waitForTransactionReceipt({ hash });
}
await rpc("anvil_stopImpersonatingAccount", [POOL_MANAGER]);
for (const who of [BORROWER, KEEPER])
  assert.ok((await bal(IMD, who)) >= 3000n * E18, "funded");

// SwarmFeed storage: slot 2 = value, slot 3 = hasValue << 64 | updatedAt (as rehearsal2.sh seeds it).
/**
 * A calm market on the fork: pin IMD's pool to the median the price feed's question would answer now (13
 * samples over two hours), so the market and a fresh primary agree. The fork carries mainnet's real history,
 * and after a fast move the terminal rightly holds the purchase (a fresh primary would still breach skew);
 * this test is about buying one. Only sqrtPriceX96 (the low 160 bits of slot0) is rewritten; nothing here swaps.
 */
async function calmMarket() {
  const POOL_ID = "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3";
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [POOL_ID, 6n]));
  const extsload = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);
  const head = await chain.getBlockNumber();
  const price = async (blockNumber) => {
    const w = BigInt(await chain.readContract({ address: POOL_MANAGER, abi: extsload, functionName: "extsload", args: [slot], blockNumber }));
    const sq = w & ((1n << 160n) - 1n);
    return ((10n ** 18n) << 192n) / (sq * sq);
  };
  const samples = await Promise.all(Array.from({ length: 13 }, (_, i) => price(head - 600n + (BigInt(i) * 600n) / 12n)));
  const median = samples.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[6];
  // sqrtPriceX96 for `median` wei ETH per 1e18 IMD: sqrt(1e18 · 2^192 / median).
  const target = ((10n ** 18n) << 192n) / median;
  let r = 1n << 96n;
  for (let i = 0; i < 200; i++) r = (r + target / r) >> 1n;
  const word = BigInt(await chain.readContract({ address: POOL_MANAGER, abi: extsload, functionName: "extsload", args: [slot] }));
  const next = (word & ~((1n << 160n) - 1n)) | r;
  await rpc("anvil_setStorageAt", [POOL_MANAGER, slot, "0x" + next.toString(16).padStart(64, "0")]);
  await rpc("evm_mine");
  return median;
}

async function setFeed(feed, value) {
  const block = await chain.getBlock();
  const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
  await rpc("anvil_setStorageAt", [feed, "0x2", hex(value)]);
  await rpc("anvil_setStorageAt", [
    feed,
    "0x3",
    hex((1n << 64n) + block.timestamp),
  ]);
  await rpc("evm_mine");
}

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (!pathname.startsWith("/preview/")) return res.writeHead(404).end();
    const suffix = decodeURIComponent(pathname.slice(9)) || "index.html";
    const file = suffix.endsWith("/") ? `${suffix}index.html` : suffix;
    const path = resolve(dist, file);
    if (!path.startsWith(dist + "/")) throw Error("path");
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
    };
    res.setHeader(
      "Content-Type",
      types[extname(path)] || "application/octet-stream",
    );
    if (servedCsp && extname(path) === ".html")
      res.setHeader("Content-Security-Policy", servedCsp);
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${server.address().port}/preview/`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const results = [];
const remote = new Set();
const errors = [];
const passed = (name) => (results.push(name), console.log("PASS", name));

/** A browser wallet that really signs: anvil's unlocked account, every call forwarded to the fork. */
async function open(account) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  // The page's own mainnet readers (market price, ENS) use public RPCs: those answer from the fork, so
  // nothing leaves this machine. Everything else remote is refused and listed.
  const forked = [
    "ethereum-rpc.publicnode.com",
    "eth.drpc.org",
    "rpc.mevblocker.io",
    "eth-mainnet.public.blastapi.io",
  ];
  await context.route(/^https:\/\//, async (route) => {
    const req = route.request();
    const host = new URL(req.url()).host;
    if (forked.includes(host) && req.method() === "POST") {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: req.postData(),
      });
      return route.fulfill({
        status: r.status,
        body: await r.text(),
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
      });
    }
    if (forked.includes(host) && req.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "POST",
        },
      });
    remote.add(host);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on(
    "console",
    (m) =>
      /Content.Security.Policy|Refused to/i.test(m.text()) &&
      errors.push(`CSP: ${m.text()}`),
  );
  // The page's clock follows the fork's: a warp moves block time, and the desk times grace by Date.now.
  await page.addInitScript(() => {
    const real = Date.now.bind(Date);
    window.__clockOffset = 0;
    Date.now = () => real() + window.__clockOffset;
  });
  await page.addInitScript(
    ({ account, rpc }) => {
      const listeners = {};
      let connected = false;
      let id = 0;
      const forward = async (method, params) => {
        const r = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method,
            params: params ?? [],
          }),
        });
        const j = await r.json();
        if (j.error)
          throw Object.assign(Error(j.error.message), {
            code: j.error.code,
            data: j.error.data,
          });
        return j.result;
      };
      window.ethereum = {
        isMetaMask: true,
        on: (n, cb) => (listeners[n] = cb),
        removeListener: (n) => delete listeners[n],
        request: async ({ method, params }) => {
          if (method === "eth_accounts") return connected ? [account] : [];
          if (method === "eth_requestAccounts")
            return ((connected = true), [account]);
          if (method === "eth_chainId") return "0x1";
          if (
            method === "wallet_switchEthereumChain" ||
            method === "wallet_addEthereumChain"
          )
            return null;
          if (method === "eth_sendTransaction")
            return forward(method, [{ ...params[0], from: account }]);
          return forward(method, params);
        },
      };
    },
    { account, rpc: RPC },
  );
  await page.goto(`${url}terminal/`);
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .waitFor();
  const field = page.locator(
    'button[aria-label="Disconnected: connect a wallet"]:visible',
  );
  await tab(page, "Position");
  await field.first().click();
  await page.locator(".pane-position .balance-use").first().waitFor();
  return { page, context };
}
async function tab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
}
async function choose(scope, text) {
  await scope.getByRole("button", { name: text, exact: true }).click();
}
async function refresh(page) {
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .waitFor();
}
/** Click the action, confirm in the dialog, and wait for the receipt the terminal reports. */
async function send(page, label) {
  const button = page.getByRole("button", {
    name: label,
    exact: typeof label === "string",
  });
  await until(`"${label}" enabled`, () => button.first().isEnabled());
  await button.first().click();
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Confirm in wallet" }).click();
  await until(`"${label}" confirmed`, async () => {
    const alert = await page.locator("footer").textContent();
    if (
      /fail|revert|error/i.test(alert ?? "") &&
      !/Confirmed on chain/.test(alert)
    )
      throw fatal(alert);
    return (
      (await page.locator("dialog[open]").count()) === 0 &&
      /Confirmed on chain/.test(alert ?? "")
    );
  });
}

let exit = 0;
try {
  // ---------- the borrower ----------
  const { page: a } = await open(BORROWER);
  await a.locator(".topbar .chip", { hasText: "Mainnet · live" }).waitFor();
  assert.equal(
    await a.getByText(/testnet/i).count(),
    0,
    "no testnet wording on a mainnet deployment",
  );
  passed("The terminal names the network: Mainnet · live, no testnet wording");
  const pos = a.locator(".pane-position");
  await tab(a, "Position");
  const imdStart = await bal(IMD, BORROWER);
  await pos.getByLabel("Deposit IMD", { exact: true }).fill("2000");
  await send(a, "Approve IMD");
  await send(a, "Review deposit");
  let p = await until("collateral recorded", async () => {
    const x = await position(BORROWER);
    return x.collateral > 0n && x;
  });
  assert.equal(
    imdStart - (await bal(IMD, BORROWER)),
    2000n * E18,
    "exactly 2,000 IMD left the wallet",
  );
  passed(
    `Deposit 2,000 IMD (approve + lockIMD): ${p.collateral} raw sIMD collateral recorded`,
  );

  // Borrow half of what the price allows.
  const [cPrice] = await read(
    await read(VAULT, vaultAbi, "collateralPriceFeed"),
    feedAbi,
    "latestValue",
  );
  const mat = await read(VAULT, vaultAbi, "mat");
  const most = (((p.collateral * cPrice) / E18) * 100n) / mat;
  const borrow = most / 2n / E18;
  assert.ok(borrow > 10n, `room to borrow (${most})`);
  await choose(pos, "Borrow");
  await pos.getByLabel(/^Borrow /).fill(String(borrow));
  await send(a, "Review borrow");
  await until(
    "imdUSD minted",
    async () => (await bal(STABLE, BORROWER)) === borrow * E18,
  );
  passed(`Borrow ${borrow} imdUSD (draw): wallet holds exactly that`);

  await choose(pos, "Repay");
  await pos.getByLabel(/^Repay /).fill("10");
  const debtBefore = (await position(BORROWER)).debt;
  await send(a, "Review repayment");
  await until(
    "debt reduced",
    async () => (await bal(STABLE, BORROWER)) === (borrow - 10n) * E18,
  );
  const debtAfter = (await position(BORROWER)).debt;
  assert.ok(
    debtBefore - debtAfter >= 9n * E18 && debtBefore - debtAfter <= 10n * E18,
    `debt fell by ~10 (${debtBefore - debtAfter})`,
  );
  passed("Repay 10 imdUSD (wipe): burned from the wallet, debt down");

  await choose(pos, "Withdraw");
  const withdraw = p.collateral / 20n; // 5% of the collateral, in sIMD
  const human = (withdraw * 10_000n) / 10n ** 24n; // sIMD has 24 decimals: four places
  await pos.getByLabel(/^Withdraw /).fill((Number(human) / 10_000).toString());
  const before = await bal(GEM, BORROWER);
  await send(a, "Review withdrawal");
  await until("sIMD returned", async () => (await bal(GEM, BORROWER)) > before);
  const after = await position(BORROWER);
  assert.ok(after.collateral < p.collateral, "collateral fell");
  assert.equal(
    p.collateral - after.collateral,
    (await bal(GEM, BORROWER)) - before,
    "exactly what left the vault arrived",
  );
  passed(
    `Withdraw ${Number(human) / 10_000} sIMD (free): left the vault and arrived in the wallet`,
  );
  p = after;

  // ---------- buy an update through the OracleAsker (pays the live Intake v2 on the fork) ----------
  // The button appears only when the market has moved away from the vault's price AND a fresh primary (the
  // window's median) would agree with a fresh spot. Calm the market at the median, then walk both feeds 15% under
  // it, as a fall in the feed's last answer would leave them.
  const median = await calmMarket();
  for (const f of [byName.PriceFeed, byName.SpotFeed]) await setFeed(f, (median * 85n) / 100n);
  await refresh(a);
  await tab(a, "Oracle");
  const panel = a.locator(".pane-oracle .price-status");
  const imdBefore = await bal(IMD, BORROWER);
  const approve = panel.getByRole("button", {
    name: /^Approve .* IMD · Update price$/,
  });
  await approve.waitFor();
  await send(a, /^Approve .* IMD · Update price$/);
  await send(a, "Update price");
  const inFlight = await until("requests in flight", async () => {
    const [, , , , , , , pr] = await read(ASKER, askerAbi, "feeds", [
      byName.PriceFeed,
    ]);
    const [, , , , , , , sp] = await read(ASKER, askerAbi, "feeds", [
      byName.SpotFeed,
    ]);
    return (
      pr !== "0x" + "0".repeat(64) && sp !== "0x" + "0".repeat(64) && [pr, sp]
    );
  });
  const paid = imdBefore - (await bal(IMD, BORROWER));
  assert.ok(paid > 0n, "IMD paid");
  passed(
    `Update price (askPaidMany on the real Intake v2): price + spot in flight, ${Number(paid) / 1e18} IMD paid`,
  );
  void inFlight;

  // ---------- the keeper: its own position for imdUSD, then redeem, mark, liquidate ----------
  const { page: k } = await open(KEEPER);
  const kpos = k.locator(".pane-position");
  await tab(k, "Position");
  await kpos.getByLabel("Deposit IMD", { exact: true }).fill("2000");
  await send(k, "Approve IMD");
  await send(k, "Review deposit");
  await until(
    "keeper collateral",
    async () => (await position(KEEPER)).collateral > 0n,
  );
  // The keeper borrows to ~200%: inside the redeemable band (170% to the 220% ceiling).
  const kp = await position(KEEPER);
  const [cNow] = await read(
    await read(VAULT, vaultAbi, "collateralPriceFeed"),
    feedAbi,
    "latestValue",
  );
  const kBorrow = (((kp.collateral * cNow) / E18) * 100n) / 200n / E18;
  await choose(kpos, "Borrow");
  await kpos.getByLabel(/^Borrow /).fill(String(kBorrow));
  await send(k, "Review borrow");
  await until(
    "keeper imdUSD",
    async () => (await bal(STABLE, KEEPER)) === kBorrow * E18,
  );

  // The borrower redeems against the keeper's position (the Treasury holds no reserve on day one).
  await refresh(a);
  await tab(a, "Redeem");
  const red = a.locator(".pane-redemption");
  await red.getByLabel(/^Redeem /).fill("20");
  await red.getByLabel(/Candidate position/).fill(KEEPER);
  const seen = new Set();
  a.on("console", (m) =>
    seen.add(`console.${m.type()}: ${m.text().slice(0, 200)}`),
  );
  await a.evaluate(() => {
    const t0 = performance.now();
    window.__qlog = [];
    const pane = document.querySelector(".pane-redemption");
    new MutationObserver(() => {
      const b = pane.querySelector("button[type=submit]")?.textContent;
      const q = !!pane.querySelector(".quote");
      const f = pane.querySelector("#redemption-feedback")?.textContent ?? "";
      const last = window.__qlog.at(-1);
      const line = `${b}|quote=${q}|fb=${f.slice(0, 120)}`;
      if (!last || last.line !== line)
        window.__qlog.push({ t: Math.round(performance.now() - t0), line });
    }).observe(pane, { subtree: true, childList: true, characterData: true });
  });
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await until(
    "a quote",
    async () => {
      seen.add(
        "button: " + (await red.locator("button[type=submit]").textContent()),
      );
      if (await red.locator(".quote").count()) return true;
      const err = red.locator(
        '[role="alert"], .fading-error, #redemption-feedback',
      );
      const t = (await err.allTextContents()).join(" ").trim();
      if (t && !/Quoting/.test(t)) throw fatal(`quote refused: ${t}`);
    },
    30_000,
  ).catch(async (e) => {
    const btn = red.getByRole("button", { name: /Quote|Quoting/ });
    throw Error(
      `${e.message}; button "${await btn.textContent()}" disabled=${await btn.isDisabled()}; candidate="${await red.getByLabel(/Candidate position/).inputValue()}"; seen: ${[...seen].join(" | ")}; log: ${JSON.stringify(await a.evaluate(() => window.__qlog))}`,
    );
  });
  const aGem = await bal(GEM, BORROWER);
  const stableBefore = await bal(STABLE, BORROWER);
  const kDebt = (await position(KEEPER)).debt;
  await send(a, "Review redemption");
  await until(
    "redeemed",
    async () => (await bal(STABLE, BORROWER)) === stableBefore - 20n * E18,
  );
  const got = (await bal(GEM, BORROWER)) - aGem;
  assert.ok(got > 0n, "sIMD paid out");
  assert.ok((await position(KEEPER)).debt < kDebt, "the candidate's debt fell");
  passed(
    `Redeem 20 imdUSD (cash) against a position at ~200%: burned, ${got} raw sIMD paid out, candidate's debt down`,
  );

  // The price falls 60%: the borrower's position goes under 170%.
  for (const f of [byName.PriceFeed, byName.SpotFeed]) {
    const [v] = await read(f, feedAbi, "latestValue");
    await setFeed(f, (v * 40n) / 85n);
  }
  await refresh(k);
  await tab(k, "Keeper");
  const keeper = k.locator(".pane-keeper");
  await keeper.getByLabel("Borrower address").fill(BORROWER);
  const markBtn = keeper.getByRole("button", { name: /^Mark .* →$/ });
  await markBtn.waitFor();
  await markBtn.click();
  await send(k, "Review mark");
  await until("marked", async () => {
    const [, , active] = await read(VAULT, vaultAbi, "liquidationMarks", [
      BORROWER,
    ]);
    return active;
  });
  passed("Mark (bark): the position under 170% is marked from the keeper desk");

  // Past the mark's own grace (set from NHI when marked), with every feed fresh again at the fallen price.
  const [markedAt, grace] = await read(VAULT, vaultAbi, "liquidationMarks", [
    BORROWER,
  ]);
  const [, ethUsd] = await read(
    CHAINLINK_ETH_USD,
    parseAbi([
      "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
    ]),
    "latestRoundData",
  );
  await rpc("anvil_setCode", [CHAINLINK_ETH_USD, FAKE_AGGREGATOR]);
  await rpc("anvil_setStorageAt", [
    CHAINLINK_ETH_USD,
    "0x0",
    "0x" + BigInt(ethUsd).toString(16).padStart(64, "0"),
  ]);
  const head = (await chain.getBlock()).timestamp;
  await rpc("evm_increaseTime", [Number(markedAt + grace - head) + 60]);
  await rpc("evm_mine");
  const skew = Number((await chain.getBlock()).timestamp) * 1000 - Date.now();
  await k.evaluate((ms) => (window.__clockOffset = ms), skew);
  for (const f of [byName.PriceFeed, byName.SpotFeed, byName.NhiFeed]) {
    const [v] = await read(f, feedAbi, "latestValue");
    await setFeed(f, v);
  }
  await refresh(k);
  await tab(k, "Keeper");
  await choose(keeper, "Inspect");
  await keeper.getByLabel("Borrower address").fill("");
  await keeper.getByLabel("Borrower address").fill(BORROWER);
  const liq = keeper.getByRole("button", { name: /^Liquidate .* →$/ });
  await liq.waitFor();
  await liq.click();
  const debtPre = (await position(BORROWER)).debt;
  const kGem2 = await bal(GEM, KEEPER);
  await keeper.getByLabel(/^Repay borrower /).fill("50");
  await send(k, "Review liquidation");
  await until(
    "liquidated",
    async () => (await position(BORROWER)).debt < debtPre,
  );
  const seized = (await bal(GEM, KEEPER)) - kGem2;
  assert.ok(seized > 0n, "the keeper received sIMD");
  passed(
    `Liquidate (bite) 50 imdUSD of the borrower's debt: debt down, keeper received ${seized} raw sIMD`,
  );

  await tab(k, "Loan book");
  passed("Loan book opens on the mainnet deployment");
} catch (e) {
  exit = 1;
  console.error("FAIL", e?.message ?? e);
  for (const [i, ctx] of browser.contexts().entries())
    for (const pg of ctx.pages()) {
      await mkdir(resolve(root, "web/test-results"), { recursive: true });
      await pg
        .screenshot({
          path: resolve(root, `web/test-results/e2e-fail-${i}.png`),
          fullPage: true,
        })
        .catch(() => {});
      console.error(
        `  footer[${i}]:`,
        (
          await pg
            .locator("footer")
            .textContent()
            .catch(() => "")
        )?.slice(0, 300),
      );
    }
} finally {
  if (remote.size) console.log("refused remote hosts:", [...remote].join(", "));
  if (errors.length) console.log("page errors:", errors.slice(0, 5));
  const cspErrors = errors.filter((e) => e.startsWith("CSP:"));
  if (!exit && cspErrors.length) {
    exit = 1;
    console.error(
      "FAIL the Content-Security-Policy refused:",
      cspErrors.slice(0, 5),
    );
  }
  if (servedCsp)
    console.log(`served with ${dist.split("/").pop()}/_headers CSP`);
  console.log(`${results.length} passed${exit ? ", 1 failed" : ""}`);
  await mkdir(resolve(root, "web/test-results"), { recursive: true }).catch(
    () => {},
  );
  await writeFile(
    resolve(root, "web/test-results/mainnet-e2e.json"),
    JSON.stringify({ results, remote: [...remote], errors }, null, 2),
  ).catch(() => {});
  await browser.close();
  server.close();
  process.exit(exit);
}
