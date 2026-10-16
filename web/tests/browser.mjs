import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import {
  fixture,
  rpc,
  sent,
  installWallet,
  config,
  candidate,
  account,
  blockscout,
  ensRpc,
  ensRpcUrls,
  askerBody,
  askerPrice,
  fixtureDeploymentDir,
} from "./fixture.mjs";
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = resolve(root, "docs/frontend");
await mkdir(evidence, { recursive: true });
// imd-deployment.json as scripts/manifest.mjs writes it (the source plus a sha256 inventory, which config.ts checks
// every ABI against), built from tests/fixture-deployment; and the ABIs themselves.
const fixtureAbis = new URL("abi/", fixtureDeploymentDir);
const fixtureManifest = await (async () => {
  const { readdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const assets = [];
  for (const f of (await readdir(fixtureAbis)).sort())
    assets.push({ path: `abi/${f}`, sha256: createHash("sha256").update(await readFile(new URL(f, fixtureAbis))).digest("hex") });
  return Buffer.from(JSON.stringify({ ...config, assets }));
})();
async function fixtureAsset(suffix) {
  const name = suffix.split("/").at(-1);
  if (name === "imd-deployment.json") return fixtureManifest;
  const abi = suffix.match(/(?:^|\/)abi\/([A-Za-z0-9]+\.json)$/);
  return abi ? readFile(new URL(abi[1], fixtureAbis)).catch(() => undefined) : undefined;
}
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (!pathname.startsWith("/preview/")) {
      res.writeHead(404).end();
      return;
    }
    const suffix = decodeURIComponent(pathname.slice(9)) || "index.html";
    // The fixture's deployment and ABIs stand in for the build's (fixture.mjs), wherever the page asks for them.
    const fixtureFile = await fixtureAsset(suffix);
    if (fixtureFile) {
      res.setHeader("Content-Type", "application/json");
      res.end(fixtureFile);
      return;
    }
    // A directory serves its index.html, as any static host does for /terminal/ and /docs/.
    const file = suffix.endsWith("/") ? `${suffix}index.html` : suffix;
    const path = resolve(root, "dist", file);
    if (!path.startsWith(resolve(root, "dist") + "/")) throw Error("path");
    const bytes = await readFile(path);
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
      }[extname(path)] || "application/octet-stream",
    );
    res.end(bytes);
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
const errors = [];
let context;
function passed(name, detail) {
  results.push({ name, status: "passed", detail });
  console.log("PASS", name);
}
async function setup({
  wallet = true,
  atomic = false,
  chain = "0x1",
  state = {},
  deployment,
} = {}) {
  if (context) await context.close();
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const s = Object.assign(fixture(), state);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  // The console's "Failed to load resource" names no URL: record which one.
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await context.route(/^https:\/\//, async (route) => {
    const request = route.request();
    if (
      request.url().startsWith("https://eth-sepolia.blockscout.com/api/v2/")
    ) {
      await route.fulfill({
        json: blockscout(s, request.url()),
        headers: { "access-control-allow-origin": "*" },
      });
      return;
    }
    if (ensRpcUrls.some((u) => request.url().startsWith(u))) {
      const body = request.postDataJSON();
      await route.fulfill({
        json: Array.isArray(body) ? body.map(ensRpc) : ensRpc(body),
        headers: { "access-control-allow-origin": "*" },
      });
      return;
    }
    if (!config.network.rpcUrls.some((u) => request.url().startsWith(u)))
      throw Error("Unexpected remote request " + request.url());
    const body = request.postDataJSON();
    const result = Array.isArray(body)
      ? body.map((b) => rpc(s, b))
      : rpc(s, body);
    await route.fulfill({
      json: result,
      headers: { "access-control-allow-origin": "*" },
    });
  });
  // A deployment variant, served in place of the built one (e.g. one that names an OracleAsker).
  if (deployment)
    await context.route("**/imd-deployment.json", async (route) => {
      const json = await (await route.fetch()).json();
      await route.fulfill({ json: deployment(json) });
    });
  if (wallet) {
    await page.exposeFunction("__sendFixture", (tx) => sent(s, tx));
    await installWallet(page, { chain, atomic });
  }
  await page.goto(`${url}terminal/`);
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .waitFor();
  await tab(page, "work");
  await page
    .locator(".pane-work")
    .getByText("Faucet mode", { exact: true })
    .waitFor();
  return { page, s };
}
const deskLabels = {
  position: "Position",
  redemption: "Redeem",
  work: "Work",
  keeper: "Keeper",
  governance: "Govern",
};
const monitorLabels = {
  loans: "Loan book",
  oracle: "Oracle",
  backing: "Backing",
  points: "Points",
};
// Site-drawn dropdowns: open by the labelled button, then pick the option by its text.
async function choose(page, scope, label, text) {
  await scope.getByRole("button", { name: label }).click();
  await page.getByRole("option", { name: text, exact: true }).click();
}
const paneText = {
  loans: "Loan book",
  position: "Position",
  redemption: "Redeem",
  work: "Work",
  keeper: "Keeper",
  governance: "Govern",
  oracle: "Oracle",
  backing: "Backing",
};
async function pickPane(page, id) {
  await choose(page, page.locator(".mobile-nav"), "View pane", paneText[id]);
}
// Desktop switches desk tabs; below 1100px the same panes are reached through the pane picker.
async function tab(page, id) {
  const t = page.getByRole("tab", {
    name: deskLabels[id] ?? monitorLabels[id],
    exact: true,
  });
  if (await t.isVisible()) await t.click();
  else await pickPane(page, id);
}
/** The terminal has no connect button: an amount box's "Disconnected" label is the way in. The Position
 * desk always has one. */
async function connectButton(page) {
  const visible = page.locator('button[aria-label="Disconnected: connect a wallet"]:visible');
  if ((await visible.count()) === 0) await tab(page, "position");
  return visible.first();
}
async function connect(page) {
  await (await connectButton(page)).click();
  if (
    await page
      .getByRole("button", { name: "Switch to Sepolia", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Switch to Sepolia", exact: true })
      .click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".pane-redemption button[type=submit]").disabled,
  );
}
async function refresh(page) {
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .waitFor();
}
async function openFeed(page, name) {
  await tab(page, "oracle");
  const toggle = page.locator(".pane-oracle .feed-toggle", { hasText: name });
  if ((await toggle.getAttribute("aria-expanded")) !== "true")
    await toggle.click();
}
async function expectText(locator, text) {
  try {
    await locator.getByText(text, { exact: false }).first().waitFor();
  } catch (e) {
    // Say what was there instead, so a reworded figure reads as drift and not as a hang.
    const el = typeof locator.first === "function" ? locator.first() : locator.locator("body"); // a page has no first()
    const shown = (await el.innerText({ timeout: 1000 }).catch(() => "(not rendered)")).replace(/\s+/g, " ");
    throw Error(`expected ${JSON.stringify(text)}; the element read: ${shown.slice(0, 1200)}`, { cause: e });
  }
}
async function review(page, label) {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.locator("dialog[open]").waitFor();
}
async function cancel(page) {
  await page
    .locator("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
}
try {
  let { page, s } = await setup({ wallet: false });
  await (await connectButton(page)).click();
  await expectText(page, "No browser wallet found");
  await tab(page, "redemption");
  assert.equal(
    await page.getByRole("button", { name: "Quote redemption" }).isEnabled(),
    false,
  );
  passed("Missing wallet explanation and disconnected transaction gates");
  // The landing page: live figures from the same contracts, and links into the terminal and docs.
  await page.goto(url);
  await page
    .getByRole("heading", { level: 1, name: /A dollar the swarm/ })
    .waitFor();
  const live = page.locator(".live-panel");
  await expectText(live, "Reserves");
  await expectText(live, "$\u00a01K");
  await expectText(live, "$\u00a010K");
  await expectText(live, "Price actions");
  assert.equal(
    await page.locator('.site-nav a[aria-current="page"]').count(),
    0,
  );
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      width,
      `landing scrolls sideways at ${width}px`,
    );
    await page.screenshot({
      path: `${evidence}/landing-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axeHome = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  assert.deepEqual(
    axeHome.violations.map((v) => v.id),
    [],
    axeHome.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`).join("; "),
  );
  await page.locator(".site-nav").getByRole("link", { name: "Docs" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Documentation" })
    .waitFor();
  assert.equal(
    await page.locator('.site-nav a[aria-current="page"]').textContent(),
    "Docs",
  );
  const axeDocs = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  assert.deepEqual(
    axeDocs.violations.map((v) => v.id),
    [],
    axeDocs.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")}`).join("; "),
  );
  await page
    .locator(".site-nav")
    .getByRole("link", { name: "Terminal" })
    .click();
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .waitFor();
  assert.equal(
    await page.locator('.site-nav a[aria-current="page"]').textContent(),
    "Terminal",
  );
  await page.getByRole("link", { name: "imdUSD home" }).click();
  await page
    .getByRole("heading", { level: 1, name: /A dollar the swarm/ })
    .waitFor();
  passed(
    "Landing reads live figures and links to the terminal and docs; both pages pass axe and never scroll sideways",
  );
  ({ page, s } = await setup());
  await page.evaluate(() => (window.__wallet.reject = true));
  await (await connectButton(page)).click();
  await expectText(page, "Wallet request rejected");
  await page.evaluate(() => (window.__wallet.reject = false));
  await connect(page);
  const requests = await page.evaluate(() => window.__wallet.requests);
  const methods = requests
    .filter((x) => x.method.includes("EthereumChain"))
    .map((x) => x.method);
  assert.deepEqual(methods, [
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
  ]);
  assert.deepEqual(
    requests.find((x) => x.method === "wallet_addEthereumChain").params[0],
    config.walletAddChain,
  );
  passed(
    "Connect rejection recovery, wrong chain and exact add-chain fallback",
  );
  // Connected, the header gains only the disconnect box: no address, no name, no connect button.
  await page.locator(".topbar .disconnect-box").waitFor();
  assert.match(
    await page.locator(".topbar .disconnect-box").getAttribute("aria-label"),
    /^Disconnect 0x[0-9a-fA-F]{40}$/,
  );
  assert.equal(await page.locator(".topbar .account").count(), 0, "no account text in the header");
  // No native dropdowns remain: their open list is drawn by the OS and cannot match the site.
  assert.equal(await page.locator("select").count(), 0);
  passed(
    "Connected, the header holds only the disconnect box; dropdowns use the site's own style",
  );
  const red = page.locator(".pane-redemption");
  await tab(page, "redemption");
  await red.getByLabel("Redeem COMP", { exact: true }).fill("10");
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red, "Served by");
  assert.equal(
    await red.locator(".quote").getByText("Reserve", { exact: true }).count(),
    1,
  );
  await expectText(red, "Your fee");
  passed("Reserve-only quote includes net output, fee, source and minimum");
  const sizes = await red.locator(".curve-row strong").allTextContents();
  assert.deepEqual(sizes, ["0.75%", "1.75%", "3%"]);
  passed("Size comparison reads on-chain fees for 1%, 5%, 10% supply", sizes);
  await red.getByLabel("Redeem COMP", { exact: true }).fill("11");
  assert.equal(await red.locator(".quote").count(), 0);
  passed("Changing an input invalidates a quote");
  s.reserve = 2n * 10n ** 18n;
  await refresh(page);
  await red.getByLabel("Redeem COMP", { exact: true }).fill("100");
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red, "Enter a candidate position");
  await red.getByLabel("Candidate position", { exact: false }).fill(candidate);
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red.locator(".quote"), "Reserve + position");
  await review(page, "Review redemption");
  // QA-03 regression: the review dialog is named by its heading.
  await page.getByRole("dialog", { name: "Review transaction" }).waitFor();
  // QA-04 regression: cancelling returns focus to the control that opened the review.
  await cancel(page);
  await page.waitForFunction(() =>
    /Review redemption/.test(document.activeElement?.textContent ?? ""),
  );
  await review(page, "Review redemption");
  await expectText(page.locator("dialog"), "Receive at least");
  await cancel(page);
  passed("Mixed quote requires a candidate and uses a transaction review");
  s.reserve = 0n;
  await refresh(page);
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red.locator(".quote"), "Position");
  passed("Position-only route");
  s.candidateCR = 200n;
  await refresh(page);
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red, "at/above the eligibility ceiling");
  assert.equal(await red.locator(".quote").count(), 0);
  passed("Candidate at derived ceiling is rejected");
  s.candidateCR = 180n;
  s.rejectSimulation = true;
  await refresh(page);
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red, "collateral ratio would fall");
  passed("Full redemption simulation translates the ratio guard revert");
  s.rejectSimulation = false;
  await refresh(page);
  await expectText(red, "Par (backing unavailable)");
  await tab(page, "backing");
  await expectText(page.locator(".pane-backing"), "Not reported");
  await openFeed(page, "IMD / ETH primary");
  await expectText(page.locator(".pane-oracle"), "Not reported");
  passed("A vault and feeds without the newer views degrade per field");
  s.backing = (8n * 10n ** 18n) / 10n;
  s.pinned = true;
  await refresh(page);
  await expectText(red, "cap binds");
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await expectText(red.locator(".quote"), "(backing cap)");
  await tab(page, "backing");
  await expectText(page.locator(".pane-backing"), "Cap binds");
  // Oracle and Backing list figures only; every explanation lives behind an info icon.
  assert.equal(
    await page
      .locator(
        ".pane-oracle .micro:not(.chart-unavailable), .pane-oracle .notice, .pane-backing .micro:not(.chart-unavailable), .pane-backing .notice",
      )
      .count(),
    0,
  );
  const tip = page.getByRole("button", { name: "About Backing ratio" });
  await tip.hover();
  const tooltip = page
    .getByRole("tooltip")
    .filter({ hasText: "point-in-time" });
  await tooltip.waitFor();
  await tip.focus();
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "hidden" });
  // QA-02 regression: the pointer can move from the icon onto the window without it closing.
  await page.mouse.move(5, 5);
  await tip.hover();
  await tooltip.waitFor();
  const box = await tooltip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 4,
  });
  await page.waitForTimeout(300);
  assert.equal(await tooltip.isVisible(), true);
  await page.mouse.move(5, 5);
  await tooltip.waitFor({ state: "hidden" });
  passed(
    "Oracle and Backing carry no prose; info windows open on hover and focus, close on Escape; the pointer can rest on them",
  );
  await openFeed(page, "IMD / ETH primary");
  await expectText(page.locator(".pane-oracle"), "Pinned · 0x2b2b2b2b");
  await expectText(page.locator(".pane-oracle"), "26,121,526");
  passed("Backing below par caps the quote; pinned questions are shown");
  s.governor = "0x0000000000000000000000000000000000000c33";
  await refresh(page);
  await tab(page, "governance");
  assert.equal(
    await page.locator(".pane-governance").getByLabel("Operation").count(),
    0,
  );
  await expectText(page.locator(".pane-governance"), "Review apply pending");
  // A pending change is shown to everyone, inline: the changing row reads current → proposed, and one
  // status row says what it is and when it applies.
  const govPane = page.locator(".pane-governance");
  await govPane.locator(".gov-change", { hasText: "60 ratio points" }).waitFor();
  await expectText(govPane.locator(".gov-from"), "50 ratio points");
  await expectText(govPane.locator(".gov-status"), "Redemption spread · ready to apply");
  passed("A pending governance change shows its kind, current → proposed values and when anyone may apply it");
  s.governor = account;
  await refresh(page);
  await page.locator(".pane-governance").getByLabel("Operation").waitFor();
  passed("Operator controls appear only for the connected governor");
  await tab(page, "position");
  await expectText(page.locator(".pane-position"), "Liquidation price");
  await expectText(page.locator(".pane-position"), "25% above it");
  passed("Position shows its liquidation price and cushion from spot");
  await tab(page, "redemption");
  s.backing = undefined;
  s.pinned = false;
  s.stale = true;
  await refresh(page);
  assert.equal(
    await red.getByRole("button", { name: "Quote redemption" }).isEnabled(),
    false,
  );
  passed("Stale feeds disable price-sensitive actions");
  s.stale = false;
  s.mode = "attested";
  await refresh(page);
  await tab(page, "work");
  await expectText(page.locator(".pane-work"), "10,000");
  await expectText(page.locator(".pane-work"), "not an on-chain proof");
  await expectText(page.locator(".pane-work"), "980");
  passed(
    "Attested oracle task tally, age, per-task rate, earned/consumed/remaining rights",
  );
  // A wallet that cannot batch: one confirm sends the exact approval, then the deposit, one prompt each, and the
  // allowance is refetched after confirmation.
  const pos = page.locator(".pane-position");
  await tab(page, "position");
  await pos.getByLabel("Deposit IMD", { exact: true }).fill("5");
  await expectText(pos.locator(".position-after"), "Liquidation price");
  await review(page, "Review deposit");
  await expectText(page.locator("dialog"), "Approve exactly 5 IMD for the vault");
  await expectText(page.locator("dialog"), "Your wallet asks 2 times");
  await page.evaluate(() => (window.__wallet.reject = true));
  await page
    .locator("dialog")
    .getByRole("button", { name: "Confirm in wallet" })
    .click();
  await expectText(page.locator("dialog"), "Wallet request rejected");
  assert.equal(s.sent.length, 0);
  await page.evaluate(() => (window.__wallet.reject = false));
  await page
    .locator("dialog")
    .getByRole("button", { name: "Confirm in wallet" })
    .click();
  await expectText(page.locator("footer"), "Confirmed on chain.");
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].functionName, "approve");
  assert.equal(s.sent[0].args[1], 5n * 10n ** 18n);
  assert.equal(s.sent[1].functionName, "depositCollateral");
  await pos
    .getByRole("button", { name: "Review deposit", exact: true })
    .waitFor();
  await review(page, "Review deposit");
  assert.equal(await page.locator("dialog .loop-steps").count(), 0, "allowance covers it now: no approval step");
  await cancel(page);
  passed(
    "Exact approval sent with the deposit from one confirm, rejected signing retry, receipt waits and refreshed allowance",
  );
  // Walk all prior panes and prepare primary transactions with mock simulation.
  for (const [choice, label, input, value] of [
    ["Borrow", "Review borrow", "Borrow COMP", "1"],
    ["Repay", "Review repayment", "Repay COMP", "1"],
    ["Withdraw", "Review withdrawal", "Withdraw IMD", "1"],
  ]) {
    await pos.getByRole("button", { name: choice, exact: true }).click();
    await pos.getByLabel(input, { exact: true }).fill(value);
    await review(page, label);
    await cancel(page);
  }
  await tab(page, "work");
  await page
    .locator(".pane-work")
    .getByLabel("Mint earned COMP", { exact: true })
    .fill("1");
  await review(page, "Review work mint");
  await cancel(page);
  const keeper = page.locator(".pane-keeper");
  await tab(page, "keeper");
  s.candidateCR = 140n;
  await keeper.getByLabel("Borrower address").fill(candidate);
  // A complete address inspects itself; the button then carries the position to Act.
  await expectText(keeper, "140%");
  assert.equal(await keeper.getByText("Review mark").count(), 0);
  await keeper.getByRole("button", { name: "Liquidate keeper.eth →" }).click();
  assert.equal(await keeper.getByLabel("Borrower address").count(), 0);
  await review(page, "Review mark");
  await cancel(page);
  await keeper.getByLabel("Repay borrower COMP").fill("1");
  await review(page, "Review liquidation");
  await cancel(page);
  await review(page, "Review clear mark");
  await cancel(page);
  // Operator controls live on the Govern desk tab; the monitor holds no actions.
  const gov = page.locator(".pane-governance");
  await tab(page, "governance");
  await choose(page, gov, "Operation", "Sync a reserve token");
  await gov.getByLabel("Token to sync").fill(config.contracts[0].address);
  await review(page, "Review reserve sync");
  await cancel(page);
  await review(page, "Review apply pending");
  await cancel(page);
  await choose(page, gov, "Operation", "Propose redemption spread");
  await gov.getByLabel("Spread (25–100 ratio points)").fill("55");
  await review(page, "Review spread proposal");
  await cancel(page);
  const oracle = gov;
  await choose(page, gov, "Operation", "Reporter fallback");
  await oracle
    .getByRole("button", { name: "Check reporter permission" })
    .click();
  await expectText(oracle, "Reporter permission confirmed.");
  await oracle.getByLabel("Value (18-decimal units)").fill("0.001");
  await review(page, "Review feed report");
  await cancel(page);
  passed(
    "Position, work mint, keeper, backing, governance and oracle controls simulate their intended calls",
  );
  // Settle visual state, test all sizes at the static-host subpath.
  await page
    .locator("details[open]")
    .evaluateAll((nodes) => nodes.forEach((n) => (n.open = false)));
  s.reserve = 100n * 10n ** 18n;
  s.candidateCR = 180n;
  await refresh(page);
  await tab(page, "redemption");
  await red.getByLabel("Redeem COMP", { exact: true }).fill("10");
  await red.getByLabel("Candidate position", { exact: false }).fill("");
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await red.locator(".quote").waitFor();
  await review(page, "Review redemption");
  await page
    .locator("dialog")
    .getByRole("button", { name: "Confirm in wallet" })
    .click();
  await expectText(page.locator("footer"), "Confirmed on chain.");
  assert.equal(s.sent.at(-1).functionName, "redeem");
  assert.equal(s.sent.at(-1).args[0], 10n * 10n ** 18n);
  assert.ok(s.sent.at(-1).args[1] > 0n);
  passed(
    "Redemption signing request carries exact burn amount, nonzero minimum and candidate; mocked receipt confirms",
  );
  await red.getByRole("button", { name: "Quote redemption" }).click();
  await red.locator(".quote").waitFor();
  const viewports = [];
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
    [900, 900],
    [390, 844],
    [320, 740],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const dimensions = await page.evaluate(() => ({
      w: innerWidth,
      h: innerHeight,
      sw: document.documentElement.scrollWidth,
      sh: document.documentElement.scrollHeight,
      bw: document.body.scrollWidth,
      bh: document.body.scrollHeight,
    }));
    if (dimensions.sh !== height || dimensions.sw !== width) {
      await page.screenshot({ path: `${evidence}/overflow-debug.png` });
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll("body *")]
            .map((el) => ({
              tag: el.tagName,
              cls: el.className,
              rect: el.getBoundingClientRect().toJSON(),
              position: getComputedStyle(el).position,
            }))
            .filter(
              (e) => e.rect.bottom > innerHeight && e.position === "absolute",
            )
            .slice(0, 25),
        ),
      );
    }
    assert.equal(dimensions.sw, width);
    assert.equal(dimensions.sh, height);
    assert.equal(dimensions.bw, width);
    assert.equal(dimensions.bh, height);
    await page
      .locator(".pane-body")
      .evaluateAll((nodes) => nodes.forEach((n) => (n.scrollTop = 0)));
    await page.screenshot({ path: `${evidence}/terminal-${width}.png` });
    viewports.push(dimensions);
    if (width > 1100) {
      // The desk never scrolls: every tab, the redemption quote included, fits its panel.
      for (const id of Object.keys(deskLabels)) {
        await tab(page, id);
        const fit = await page
          .locator(`.pane-${id} .desk-body`)
          .evaluate((n) => ({ content: n.scrollHeight, box: n.clientHeight }));
        assert.ok(
          fit.content <= fit.box + 1,
          `${id} desk tab overflows at ${width}x${height}: ${fit.content} > ${fit.box}`,
        );
      }
      await openFeed(page, "IMD / ETH primary");
      for (const id of Object.keys(monitorLabels)) {
        await tab(page, id);
        const fit = await page
          .locator(`.pane-${id} .monitor-body`)
          .evaluate((n) => ({ content: n.scrollHeight, box: n.clientHeight }));
        assert.ok(
          fit.content <= fit.box + 1,
          `${id} monitor tab overflows at ${width}x${height}: ${fit.content} > ${fit.box}`,
        );
      }
      await tab(page, "loans");
      await tab(page, "redemption");
    }
    if (width <= 760) {
      for (const pane of [
        "loans",
        "position",
        "work",
        "oracle",
        "keeper",
        "backing",
        "governance",
        "redemption",
      ]) {
        await pickPane(page, pane);
        assert.equal(await page.locator(`.pane-${pane}`).isVisible(), true);
      }
    }
  }
  // A laptop browser window: every tab, both keeper modes and a live quote still fit.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(150);
  const fits = async (selector, what) => {
    const fit = await page
      .locator(selector)
      .evaluate((n) => ({ content: n.scrollHeight, box: n.clientHeight }));
    assert.ok(
      fit.content <= fit.box + 1,
      `${what} overflows at 1280x720: ${fit.content} > ${fit.box}`,
    );
  };
  for (const id of Object.keys(deskLabels)) {
    await tab(page, id);
    if (id === "keeper") {
      for (const mode of ["Inspect", "Act"]) {
        await page
          .locator(".pane-keeper")
          .getByRole("button", { name: mode, exact: true })
          .click();
        await fits(".pane-keeper .desk-body", `keeper ${mode}`);
      }
    } else await fits(`.pane-${id} .desk-body`, `${id} desk tab`);
  }
  for (const id of Object.keys(monitorLabels)) {
    await tab(page, id);
    await fits(`.pane-${id} .monitor-body`, `${id} monitor tab`);
  }
  await tab(page, "loans");
  await tab(page, "redemption");
  await page.setViewportSize({ width: 320, height: 740 });
  // QA-01 regression: on a phone exactly one pane is displayed, whatever desktop tab was last open.
  await page.setViewportSize({ width: 1440, height: 900 });
  await tab(page, "backing");
  await page.setViewportSize({ width: 320, height: 740 });
  await pickPane(page, "redemption");
  const displayed = await page
    .locator(".workspace .pane")
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => getComputedStyle(n).display !== "none")
        .map((n) => n.className),
    );
  assert.equal(
    displayed.length,
    1,
    `panes displayed on mobile: ${displayed.join(" | ")}`,
  );
  assert.match(displayed[0], /pane-redemption/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await tab(page, "loans");
  await tab(page, "redemption");
  await page.setViewportSize({ width: 320, height: 740 });
  passed(
    "One viewport; every desk and monitor tab fits without scrolling; all mobile panes reachable",
    viewports,
  );
  // The chart re-stacks its loan markers on resize asynchronously; axe run before that settles saw two
  // markers overlapping at 320px and failed target-size intermittently.
  await page.waitForTimeout(500);
  const axeMobile = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  assert.deepEqual(
    axeMobile.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.length,
      target: v.nodes.map((n) => n.target.join(" ")).join(" | "),
    })),
    [],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const axeDesktop = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  assert.deepEqual(
    axeDesktop.violations.map((v) => ({
      id: v.id,
      help: v.help,
      nodes: v.nodes.length,
      target: v.nodes.map((n) => n.target.join(" ")).join(" | "),
    })),
    [],
  );
  passed(
    "Axe scan: no automated WCAG A/AA violations on desktop and 320px redemption",
  );
  await page.keyboard.press("Tab");
  await page.getByLabel("Redeem COMP", { exact: true }).focus();
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    name: document.activeElement.getAttribute("name"),
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  assert.equal(focus.outline, "solid");
  await page.screenshot({ path: `${evidence}/keyboard-focus.png` });
  passed("Keyboard tab progression and visible focus CSS", focus);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await page
    .getByRole("button", { name: "Quote redemption" })
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  assert.equal(motion, "0s");
  passed("Reduced motion disables transitions");
  const contrast = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tokens = Object.fromEntries(
      ["--bg", "--surface", "--text", "--muted", "--control"].map((k) => [
        k,
        root.getPropertyValue(k).trim(),
      ]),
    );
    const l = (hex) => {
      if (hex.length === 4)
        hex = "#" + [...hex.slice(1)].map((c) => c + c).join("");
      const c = hex
        .slice(1)
        .match(/../g)
        .map((x) => parseInt(x, 16) / 255)
        .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const c = (a, b) =>
      (Math.max(l(a), l(b)) + 0.05) / (Math.min(l(a), l(b)) + 0.05);
    return {
      tokens,
      body: c(tokens["--text"], tokens["--surface"]),
      secondary: c(tokens["--muted"], tokens["--surface"]),
      inputBorder: c(tokens["--control"], tokens["--bg"]),
    };
  });
  assert.ok(
    contrast.body >= 4.5 &&
      contrast.secondary >= 4.5 &&
      contrast.inputBorder >= 3,
  );
  passed("Computed rendered token contrast", contrast);
  await red.getByLabel("Redeem COMP", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("12");
  await page.keyboard.press("Tab"); // the wallet balance button
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await red.locator(".quote").waitFor();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.locator("dialog[open]").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog[open]").count(), 0);
  assert.match(
    await page.evaluate(() => document.activeElement.textContent),
    /Review redemption/,
  );
  passed(
    "Keyboard-only redemption quote/review, Escape cancellation and focus return",
  );
  s.rpcFail = true;
  await refresh(page);
  await expectText(page.locator(".statusbar"), "RPC unavailable");
  assert.equal(
    await red.getByRole("button", { name: "Quote redemption" }).isEnabled(),
    false,
  );
  s.rpcFail = false;
  await refresh(page);
  await page.waitForFunction(
    () =>
      !document.querySelector(".pane-redemption button[type=submit]").disabled,
  );
  passed("RPC failure disables transactions and refresh recovers");
  // Code once seen is remembered for the page's life (state.ts hasCode: these contracts cannot self-destruct), so
  // the check is made on a fresh load.
  s.codeMissing = true;
  await page.reload();
  await expectText(page, "No deployed code");
  s.codeMissing = false;
  await page.reload();
  await page.getByRole("button", { name: "Refresh state", exact: true }).waitFor();
  passed("Missing deployed code fails closed");
  await page.route("**/abi/PriceFeed.json", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.reload();
  await expectText(page, "ABI asset integrity check failed");
  assert.equal(
    await page.getByRole("button", { name: "Disconnected: connect a wallet" }).count(),
    0,
  );
  await page.unroute("**/abi/PriceFeed.json");
  await page.getByRole("button", { name: "Retry configuration" }).click();
  await page
    .getByRole("button", { name: "Refresh state", exact: true })
    .waitFor();
  passed(
    "Runtime ABI integrity failure blocks the terminal; corrected asset can be retried",
  );
  // Charts: exercise the exported bundle against deliberately irregular and failing history.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await tab(page, "loans");
  await page.locator(".loan-mark").first().waitFor();
  assert.equal(await page.locator(".loan-mark").count(), 3);
  // No names on the chart; a loan's name shows in a popup on hover or focus.
  assert.equal(await page.locator(".strip-plot .loan-label").count(), 0);
  assert.equal(await page.locator(".loan-pop").count(), 0);
  // Area is debt against the MEDIAN loan: the two 1,000-debt loans are the median and draw at 20px, the
  // 250-debt loan at half that area, 10px.
  const dots = await page
    .locator(".loan-dot")
    .evaluateAll((nodes) => nodes.map((n) => parseFloat(n.style.width)));
  assert.deepEqual(
    [...dots].sort((a, b) => a - b),
    [10, 20, 20],
  );
  await page.locator(".loan-mark").first().hover();
  await page.locator(".loan-pop").waitFor();
  const names = [await page.locator(".loan-pop b").textContent()];
  assert.match(await page.locator(".loan-pop").textContent(), /%.*·/);
  assert.match(
    await page.locator(".loan-mark").first().getAttribute("aria-label"),
    /0x[0-9a-fA-F]{40}/,
  );
  await page.mouse.move(0, 0);
  await page.locator(".loan-pop").waitFor({ state: "detached" });
  await page.locator(".loan-mark").first().focus();
  await page.keyboard.press("Enter");
  assert.match(
    await page.locator(".selected-loan").textContent(),
    /0x[0-9a-fA-F]{40}/,
  );
  // A circle picked while a search hides its row clears the search and highlights that row in view.
  const search = page.getByLabel("Search positions by name or address");
  await search.fill("no such borrower");
  await expectText(page.locator(".loan-feed"), "No positions match");
  const picked = page.locator(".loan-mark").nth(1);
  const pickedOwner = (await picked.getAttribute("aria-label")).match(/0x[0-9a-fA-F]{40}/)[0];
  await picked.click();
  await page.locator(".selected-loan").waitFor();
  assert.equal(await search.inputValue(), "");
  assert.equal(await page.locator(".selected-loan").getAttribute("data-owner"), pickedOwner);
  assert.equal(await page.locator(".selected-loan").isVisible(), true);
  // ENS names replace the readable labels where they resolve, and search finds either.
  const loans = page.locator(".pane-loans");
  await expectText(loans.locator(".loan-feed"), "keeper.eth");
  await expectText(loans.locator(".loan-feed"), "Golden Sovereign");
  await loans.getByLabel("Search positions by name or address").fill("keeper");
  assert.equal(await loans.locator(".loan-feed li").count(), 1);
  await loans
    .getByLabel("Search positions by name or address")
    .fill("copper penny");
  await expectText(loans.locator(".loan-feed"), "miyagod.eth");
  await loans.getByLabel("Search positions by name or address").fill("");
  // The zone filter is a site-drawn listbox driven by the keyboard like a native one.
  await loans.getByRole("button", { name: "Filter by zone" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expectText(
    loans.getByRole("button", { name: "Filter by zone" }),
    "Liquidatable",
  );
  await choose(page, loans, "Filter by zone", "All zones");
  // QA-06 regression: the keyboard-active option carries an outline, not just a faint fill.
  await loans.getByRole("button", { name: "Filter by zone" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("End");
  // The active option is re-rendered after the key; read its outline once it is there, not a frame early.
  const activeOption = page.locator(".select-list li.is-active");
  await activeOption.waitFor();
  await page.waitForTimeout(100);
  assert.equal(
    await activeOption.evaluate((n) => getComputedStyle(n).outlineStyle),
    "solid",
  );
  await page.keyboard.press("Escape");
  // QA-05 regression: a search that changes the list announces its count.
  await loans.getByLabel("Search positions by name or address").fill("keeper");
  await expectText(loans.getByRole("status"), "1 of 3 positions shown");
  await loans.getByLabel("Search positions by name or address").fill("");
  // A loan-book row opens that borrower in Keeper, already inspected.
  await loans.locator(".loan-feed button", { hasText: "keeper.eth" }).click();
  const opened = page.locator(".pane-keeper");
  await expectText(opened, "keeper.eth");
  await expectText(opened.getByRole("status"), "Inspected keeper.eth");
  assert.equal(
    await opened.getByLabel("Borrower address").inputValue(),
    candidate,
  );
  await expectText(opened, "Liquidation price");
  passed(
    "Deposit owners deduplicated, zero-debt owner excluded, debt area ratio 4:1; hover, keyboard and touch-readable addresses",
    names,
  );
  const initialWidth = await page
    .locator(".liquidatable-band")
    .evaluate((n) => parseFloat(n.style.width));
  s.minCR = 200n;
  await refresh(page);
  await page.waitForFunction(() =>
    // The axis runs from 100%: a 200% minimum on a 100–300% axis sits halfway.
    document.querySelector(".liquidatable-band")?.style.width.startsWith("50"),
  );
  assert.ok((await page.locator(".loan-mark.is-danger").count()) >= 2);
  const updatedWidth = await page
    .locator(".liquidatable-band")
    .evaluate((n) => parseFloat(n.style.width));
  assert.ok(updatedWidth > initialWidth);
  const oldLeft = await page
    .getByRole("button", { name: /^miyagod\.eth,/ })
    .evaluate((n) => n.style.left);
  s.priceMultiplier = 0.9;
  await refresh(page);
  await page.waitForFunction(
    (previous) =>
      [...document.querySelectorAll(".loan-mark")].find((n) =>
        n.textContent.includes("miyagod.eth"),
      )?.style.left !== previous,
    oldLeft,
  );
  assert.match(
    await page
      .locator(".loan-mark")
      .first()
      .evaluate((n) => getComputedStyle(n).transitionProperty),
    /left/,
  );
  s.minCR = 150n;
  s.priceMultiplier = 1;
  await refresh(page);
  passed(
    "Live minCR moves the risk band and changes position classification; price updates move existing marks",
  );
  await openFeed(page, "IMD / ETH primary");
  const cadence = page.locator(".pane-oracle .cadence-chart").first();
  await cadence.locator("circle").first().waitFor({ state: "attached" });
  assert.equal(await cadence.locator("circle").count(), 4);
  const xs = await cadence
    .locator("circle")
    .evaluateAll((nodes) => nodes.map((n) => Number(n.getAttribute("cx"))));
  assert.ok((xs[2] - xs[1]) / (xs[1] - xs[0]) > 20);
  assert.equal(await cadence.locator(".limit-line").count(), 1);
  s.extraPoint = true;
  await refresh(page);
  await page.waitForFunction(
    () =>
      document
        .querySelector(".pane-oracle .cadence-chart")
        ?.querySelectorAll("circle").length === 5,
  );
  assert.equal(
    await cadence
      .locator(".spark-point")
      .last()
      .evaluate((n) => getComputedStyle(n).animationName),
    "add-point",
  );
  assert.equal(await page.locator(".supply-chart .collateral-fill").count(), 1);
  assert.equal(await page.locator(".supply-chart .work-fill").count(), 1);
  assert.equal(await page.locator(".supply-chart .par-marker").count(), 1);
  assert.equal(await page.locator(".supply-chart .backing-marker").count(), 1);
  assert.equal(await page.locator(".work-chart .bar-marker").count(), 1);
  passed(
    "Every accepted value is a point at its irregular timestamp; expiry marked and a new point appends; composition, backing/par and work-ceiling bars rendered",
    { xs },
  );
  s.workCeiling = 10n * 10n ** 18n;
  s.maxDivergenceBps = 500n;
  s.spotMultiplier = 1.1;
  await refresh(page);
  await page.locator(".work-chart .over-limit").waitFor({ state: "attached" });
  await tab(page, "oracle");
  await expectText(page.locator(".pane-oracle"), "Breached");
  await expectText(page.locator(".pane-oracle"), "/ 5%");
  assert.match(
    await page.locator(".work-chart").textContent(),
    /10 COMP over ceiling/,
  );
  s.workCeiling = 1250n * 10n ** 18n;
  s.maxDivergenceBps = 2000n;
  s.spotMultiplier = 1;
  await refresh(page);
  passed(
    "Live workCeiling and maxDivergenceBps updates redraw limits and explicitly label breaches",
  );
  s.logMode = "empty";
  await refresh(page);
  await tab(page, "loans");
  await expectText(page.locator(".loan-coverage"), "Blockscout");
  assert.equal(await page.locator(".loan-mark").count(), 3);
  // A failed refresh keeps the last good book on screen (Charts.tsx), says so, and names the block it was read at.
  const stale = page.locator(".pane-loans").getByText("Could not refresh the loan book");
  s.explorerEmpty = true;
  await refresh(page);
  await expectText(page.locator(".pane-loans"), "Could not refresh the loan book");
  await expectText(page.locator(".pane-loans"), "Showing the book as read at block");
  assert.equal(await page.locator(".loan-mark").count(), 3, "the last good book stays");
  s.explorerEmpty = false;
  s.logMode = "rpc";
  await refresh(page);
  await stale.waitFor({ state: "detached" });
  s.ownerReadFail = true;
  await refresh(page);
  await expectText(page.locator(".pane-loans"), "Could not refresh the loan book");
  assert.equal(await page.locator(".loan-mark").count(), 3, "a partial owner failure keeps the last good book too");
  s.ownerReadFail = false;
  await refresh(page);
  await stale.waitFor({ state: "detached" });
  passed(
    "Silent empty RPC uses paginated Blockscout fallback; an empty fallback or partial owner failure keeps the last good book with its error, and a refresh clears it",
  );
  await tab(page, "points");
  const pointsPane = page.locator(".pane-points");
  await page.locator(".points-feed li").first().waitFor();
  await expectText(pointsPane, "Preview on");
  // Preseason is over (pointsConfig.endBlock): the notice shows, and no rate or per-day figure is offered.
  await expectText(pointsPane, "Season 1 is yet to start");
  assert.match(await pointsPane.textContent(), /capped distribution/);
  assert.doesNotMatch(await pointsPane.textContent(), /\/day|Per day/);
  assert.match(await pointsPane.textContent(), /do not count/);
  const rows = await page.locator(".points-feed li").allTextContents();
  assert.equal(
    rows.length,
    2,
    "the Treasury's stability-fee imdUSD earns nothing",
  );
  assert.match(
    rows[0],
    /34\.47/,
    "holding plus three days of liquidation credit",
  );
  assert.match(rows[1], /3\.62/);
  // The fixture runs on Sepolia, where no peg pool is configured (Points.tsx: pointsConfig.pegPools).
  assert.match(await pointsPane.textContent(), /no pool on this network/);
  assert.match(await pointsPane.textContent(), /3 days per imdUSD/);
  await page.screenshot({ path: `${evidence}/points-1440.png` });
  s.logMode = "empty";
  s.explorerEmpty = true;
  await refresh(page);
  // A failed refresh keeps the last board and says so beneath it (Points.tsx).
  await expectText(pointsPane, "Could not refresh the points history");
  assert.equal(await page.locator(".points-feed li").count(), 2, "the last board stays");
  s.explorerEmpty = false;
  s.logMode = "rpc";
  await pointsPane.getByRole("button", { name: "Retry", exact: true }).click();
  await pointsPane.getByText("Could not refresh the points history").waitFor({ state: "detached" });
  passed(
    "Points: holders ranked from imdUSD transfers, Treasury excluded, liquidation credit, testnet label, LP boost shown as no pool on Sepolia; a failed refresh keeps the board with its error, never an empty board",
  );
  // System default, live OS change, explicit persistence, theme-color, and both palettes.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "dark",
  );
  await page.getByRole("button", { name: "Use light theme" }).click();
  await page.reload();
  await page.locator(".loan-mark").first().waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "light",
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("comp-terminal-theme")),
    "light",
  );
  passed(
    "OS theme follows live changes; explicit theme survives reload and overrides OS",
  );
  const variants = [];
  for (const theme of ["light", "dark"]) {
    if (
      (await page.evaluate(() => document.documentElement.dataset.theme)) !==
      theme
    )
      await page.getByRole("button", { name: `Use ${theme} theme` }).click();
    assert.equal(
      await page
        .locator('meta[name="theme-color"]')
        .first()
        .getAttribute("content"),
      theme === "light" ? "#f7f5ef" : "#111",
    );
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [900, 900],
      [390, 844],
      [320, 740],
    ]) {
      await page.setViewportSize({ width, height });
      await page
        .locator(".pane-body")
        .evaluateAll((nodes) => nodes.forEach((n) => (n.scrollTop = 0)));
      if (width <= 760) await pickPane(page, "loans");
      await page.waitForTimeout(200);
      const dims = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        sw: document.documentElement.scrollWidth,
        sh: document.documentElement.scrollHeight,
      }));
      assert.equal(dims.sw, width);
      assert.equal(dims.sh, height);
      // The loan book's circles never overlap, at any size.
      const circles = await page
        .locator(".strip-plot .loan-dot")
        .evaluateAll((nodes) =>
          nodes.map((n) => n.getBoundingClientRect().toJSON()),
        );
      for (let i = 0; i < circles.length; i++)
        for (let j = i + 1; j < circles.length; j++) {
          const a = circles[i],
            b = circles[j];
          const d = Math.hypot(
            a.x + a.width / 2 - (b.x + b.width / 2),
            a.y + a.height / 2 - (b.y + b.height / 2),
          );
          assert.ok(
            d + 0.5 >= (a.width + b.width) / 2,
            `Loan circles overlap at ${width}px`,
          );
        }
      if (width === 1440 || width === 1280 || width === 390)
        await page.screenshot({
          path: `${evidence}/charts-${theme}-${width}.png`,
        });
      variants.push({ theme, ...dims });
      if (width <= 760) {
        for (const pane of [
          "loans",
          "position",
          "oracle",
          "keeper",
          "backing",
          "governance",
          "redemption",
          "work",
        ]) {
          await pickPane(page, pane);
          assert.equal(await page.locator(`.pane-${pane}`).isVisible(), true);
        }
        await pickPane(page, "loans");
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await pickPane(page, "oracle");
    await page
      .locator(".pane-oracle .pane-body")
      .evaluate((n) => (n.scrollTop = 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${evidence}/cadence-${theme}-390.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    const pairs = await page.evaluate(() => {
      // A computed colour as 0-255 channels and an alpha: rgb()/rgba(), or color(srgb r g b / a) with
      // 0-1 channels, which is what a color-mix() background computes to.
      const parse = (value) => {
        const m = value.match(/[\d.]+/g).map(Number);
        const unit = value.startsWith("color(") ? 255 : 1;
        return { c: m.slice(0, 3).map((v) => v * unit), a: m.length > 3 ? m[3] : 1 };
      };
      // The pane is translucent while the vibe is on: what the eye sees is the pane over the page.
      const over = (fg, bg) =>
        `rgb(${fg.c.map((v, i) => Math.round(v * fg.a + bg.c[i] * (1 - fg.a))).join(", ")})`;
      const rgb = (value) =>
        value
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number);
      const luminance = (value) =>
        rgb(value)
          .map((v) => v / 255)
          .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) =>
        (Math.max(luminance(a), luminance(b)) + 0.05) /
        (Math.min(luminance(a), luminance(b)) + 0.05);
      const background = getComputedStyle(
        document.documentElement,
      ).backgroundColor;
      const surface = over(
        parse(getComputedStyle(document.querySelector(".pane")).backgroundColor),
        parse(background),
      );
      const text = getComputedStyle(document.documentElement).color;
      const muted = getComputedStyle(
        document.querySelector(".book-heading .muted"),
      ).color;
      const healthy = getComputedStyle(
        document.querySelector(".loan-mark.is-healthy"),
      ).color;
      const band = getComputedStyle(
        document.querySelector(".redeemable-band"),
      ).backgroundColor;
      return {
        surface,
        background,
        text,
        muted,
        healthy,
        band,
        body: ratio(text, surface),
        secondary: ratio(muted, surface),
        markOnBand: ratio(healthy, band),
        markOnSurface: ratio(healthy, surface),
      };
    });
    assert.ok(
      pairs.body >= 4.5 &&
        pairs.secondary >= 4.5 &&
        pairs.markOnBand >= 3 &&
        pairs.markOnSurface >= 3,
    );
    passed(`Measured rendered ${theme} text and chart-mark contrast`, pairs);
    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    assert.deepEqual(
      scan.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
    );
  }
  passed(
    "Both themes fit all five viewport sizes; all nine mobile panes reachable; desktop axe reports no violations",
    variants,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const selector of [
    ".loan-mark",
    ".ratio-band",
    ".spark-point",
    ".spark-path",
    ".bar-fill",
  ]) {
    const styles = await page
      .locator(selector)
      .first()
      .evaluate((n) => ({
        transition: getComputedStyle(n).transitionDuration,
        animation: getComputedStyle(n).animationName,
      }));
    assert.equal(styles.transition, "0s");
    assert.equal(styles.animation, "none");
  }
  passed(
    "Reduced motion disables all chart transitions, line drawing and point entrances",
  );
  // sIMD collateral: the mainnet shape. 24 decimals, IMD or sIMD deposits, payouts unstaked by hand.
  {
    const { page, s } = await setup({ state: { share: true } });
    await connect(page);
    await tab(page, "position");
    const pos = page.locator(".pane-position");
    await expectText(pos, "800 sIMD ≈ 1,000 IMD");
    await expectText(pos, "10,000 IMD / 8,000 sIMD");
    await expectText(pos, "$\u00a01.5 / IMD");
    await expectText(pos, "1 sIMD = 1.25 IMD");
    passed(
      "sIMD collateral reads in its own 24 decimals, with its IMD value and a per-IMD liquidation price",
    );
    // Default deposit token is IMD: approve IMD, then lockIMD stakes it, from one confirm.
    await pos.getByLabel("Deposit IMD", { exact: true }).fill("5");
    await review(page, "Review deposit");
    await page
      .locator("dialog")
      .getByRole("button", { name: "Confirm in wallet" })
      .click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.equal(s.sent.at(-2).name, "underlying");
    assert.equal(s.sent.at(-2).functionName, "approve");
    assert.equal(s.sent.at(-2).args[1], 5n * 10n ** 18n);
    assert.equal(s.sent.at(-1).functionName, "lockIMD");
    assert.deepEqual(s.sent.at(-1).args, [5n * 10n ** 18n]);
    passed(
      "Depositing IMD approves IMD for exactly the amount, then stakes it through lockIMD",
    );
    // sIMD deposits go straight to lock, parsed at 24 decimals.
    await pos.getByRole("button", { name: "sIMD", exact: true }).click();
    await pos.getByLabel("Deposit sIMD", { exact: true }).fill("2");
    await review(page, "Review deposit");
    await page
      .locator("dialog")
      .getByRole("button", { name: "Confirm in wallet" })
      .click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.equal(s.sent.at(-2).name, "imdToken");
    assert.equal(s.sent.at(-2).args[1], 2n * 10n ** 24n);
    assert.equal(s.sent.at(-1).functionName, "depositCollateral");
    assert.deepEqual(s.sent.at(-1).args, [2n * 10n ** 24n]);
    passed("Depositing sIMD approves sIMD and locks it, at 24 decimals");
    // Withdrawals are sIMD; unstaking is the staking vault's redeem, to and from this wallet.
    await pos.getByRole("button", { name: "Withdraw", exact: true }).click();
    await pos.getByLabel("Withdraw sIMD", { exact: true }).fill("1");
    await review(page, "Review withdrawal");
    await page
      .locator("dialog")
      .getByRole("button", { name: "Confirm in wallet" })
      .click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.deepEqual(s.sent.at(-1).args, [10n ** 24n]);
    await pos.getByRole("button", { name: "Unstake", exact: true }).click();
    assert.equal(
      await pos.getByRole("button", { name: "Test IMD", exact: true }).count(),
      0,
    );
    await pos.getByLabel("Unstake sIMD", { exact: true }).fill("1");
    await review(page, "Review unstake");
    await page
      .locator("dialog")
      .getByRole("button", { name: "Confirm in wallet" })
      .click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.equal(s.sent.at(-1).name, "imdToken");
    assert.equal(s.sent.at(-1).functionName, "redeem");
    assert.deepEqual(s.sent.at(-1).args, [10n ** 24n, account, account]);
    passed(
      "Withdrawals parse sIMD at 24 decimals; Unstake redeems on the staking vault to this wallet; no test faucet",
    );
    await tab(page, "redemption");
    await expectText(page.locator(".pane-redemption"), "sIMD");
    passed("The redemption desk speaks sIMD for the reserve and the payout");
  }
  {
    // The price panel: the vault's price, when it was updated, the live market and what an update does.
    // Buying is disabled with an explanation until the deployment names an asker.
    const { page } = await setup();
    await connect(page);
    await tab(page, "oracle");
    const panel = page.locator(".pane-oracle .price-status");
    // Three prices: the primary the vault uses, the attested spot check, and the live market.
    const hero = panel.locator(".price-hero");
    for (const label of ["Primary", "Spot", "Market"]) await expectText(hero, label);
    await expectText(hero, "$\u00a02.00"); // primary and spot agree in the fixture
    await expectText(hero, "$\u00a02.20"); // the fixture's pool sits 10% above the primary feed
    await expectText(hero, "0% off");
    await expectText(hero, "10% vs primary");
    // The sentence shown beside the button is the one about the viewer's own position.
    await panel.locator(".price-status-line", { hasText: "Your collateral ratio would go from" }).waitFor();

    assert.equal(
      await panel.getByRole("button", { name: "Update price", exact: true }).isDisabled(),
      true,
    );
    await panel.getByRole("button", { name: "About Update price" }).first().hover();
    await page
      .getByRole("tooltip")
      .filter({ hasText: "on-chain request contract is live" })
      .waitFor();
    await tab(page, "position");
    await expectText(page.locator(".pane-position .price-hero"), "▲ 10%");
    passed(
      "The price panel shows the vault's price, its age, the live market and what an update does; buying waits for the Intake",
    );
  }
  {
    // Amount boxes show what they can take: "Disconnected" with no wallet, the wallet's balance once
    // connected (a click fills the exact amount, every decimal), "No <symbol>" with none.
    const { page } = await setup();
    await tab(page, "position");
    const field = page.locator(".pane-position .field").first();
    await expectText(field, "Disconnected");
    // There is no connect button in the header: the label is the only way in.
    assert.equal(await page.getByRole("button", { name: "Connect wallet" }).count(), 0, "no connect box");
    await field.getByRole("button", { name: "Disconnected: connect a wallet" }).click();
    await page.locator(".pane-position .balance-use").first().waitFor();
    if (
      await page.getByRole("button", { name: "Switch to Sepolia", exact: true }).isVisible()
    )
      await page.getByRole("button", { name: "Switch to Sepolia", exact: true }).click();
    await tab(page, "position");
    const use = page.locator(".pane-position .balance-use").first();
    await use.waitFor();
    assert.match(await use.textContent(), /^[\d,]+(\.\d{1,2})? \S+$/, "the amount to two decimals and the symbol");
    const exact = (await use.getAttribute("title")).split(" ")[0];
    await use.click();
    assert.equal(await page.locator('.pane-position input[name="deposit-amount"]').inputValue(), exact);
    passed("Amount boxes show the wallet balance and fill the exact amount on click; Disconnected without a wallet, and it connects");
    // The box disconnects: it draws itself out and nothing takes its place, the label is back, and a
    // reload does not silently reconnect.
    await page.locator(".topbar .disconnect-box").click();
    await page.locator(".topbar .disconnect-slot").waitFor({ state: "detached" });
    await expectText(page.locator(".pane-position .field").first(), "Disconnected");
    await page.reload();
    await page.locator(".pane-position .field").first().waitFor();
    await expectText(page.locator(".pane-position .field").first(), "Disconnected");
    assert.equal(await page.locator(".topbar .disconnect-box").count(), 0, "a reload stays disconnected");
    passed("The disconnect box disconnects, leaves nothing in its place, and a reload stays disconnected");
  }
  {
    // Repaying a borrower is capped at what they owe: the hint offers the debt (not the larger wallet
    // balance), and more is refused before anything is sent.
    const { page } = await setup();
    await connect(page);
    await tab(page, "loans");
    const loansPane = page.locator(".pane-loans");
    await loansPane.locator(".loan-feed button", { hasText: "keeper.eth" }).click();
    const opened = page.locator(".pane-keeper");
    await expectText(opened.getByRole("status"), "Inspected keeper.eth");
    await opened.getByRole("button", { name: "Act", exact: true }).click();
    const repay = opened.getByLabel(/^Repay borrower/);
    const owed = opened.locator(".balance-use").filter({ hasText: /^1,000(\.\d+)? / });
    await owed.waitFor();
    await repay.fill("1000.000000000000000001");
    await opened.getByRole("button", { name: "Review liquidation" }).click();
    await expectText(opened.getByRole("alert"), "This borrower owes");
    const shownAt = Date.now();
    assert.equal(await page.locator("dialog[open]").count(), 0, "nothing sent");
    // An action's error clears itself after ten seconds, swiping out to the left.
    let sawLeaving = false;
    while ((await opened.locator(".fading-error").count()) > 0 && Date.now() - shownAt < 14_000) {
      if ((await opened.locator(".fading-error.is-leaving").count()) > 0) sawLeaving = true;
      await page.waitForTimeout(100);
    }
    const lived = Date.now() - shownAt;
    assert.ok(sawLeaving, "it swiped out rather than vanishing");
    assert.ok(lived >= 9_500 && lived < 12_000, `the error lived ${lived} ms`);
    await owed.click();
    assert.equal(await repay.inputValue(), "1000");
    passed("Repaying a borrower is capped at their debt: the hint offers it and more is refused before sending; the error swipes away after 10 s");
  }
  {
    // Once configured: approve IMD for exactly the two answers and buy the primary and the spot together
    // (askPaidMany) with the pinned bodies, as ONE wallet batch (an EIP-5792 wallet here). The spot is added only
    // when it would disagree with the new primary (priceUpdate), so it sits 15% under the primary here: inside skew
    // now, well off the market the new primary will reflect (10% above the primary).
    const { page, s } = await setup({
      atomic: true,
      state: { spotMultiplier: 0.85 },
      deployment: (d) => ({
        ...d,
        oracleAsker: {
          address: "0x0000000000000000000000000000000000000019",
          requests: {
            PriceFeed: askerBody,
            NhiFeed: askerBody,
            SpotFeed: askerBody,
          },
        },
      }),
    });
    await connect(page);
    await tab(page, "oracle");
    const panel = page.locator(".pane-oracle .price-status");
    assert.equal(await panel.getByRole("button", { name: /Update spot check/ }).count(), 0, "one button, not two");
    await panel.getByRole("button", { name: "Update price", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await expectText(page.locator("dialog"), "one all-or-nothing batch: one signature");
    await page
      .locator("dialog")
      .getByRole("button", { name: "Confirm in wallet" })
      .click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.deepEqual(await page.evaluate(() => window.__wallet.batches), [2], "one batch of two calls");
    assert.equal(s.sent.at(-2).name, "payToken");
    assert.deepEqual(s.sent.at(-2).args, [
      "0x0000000000000000000000000000000000000019",
      2n * askerPrice,
    ]);
    assert.equal(s.sent.at(-1).name, "asker");
    assert.equal(s.sent.at(-1).functionName, "askPaidMany");
    assert.equal(s.sent.at(-1).args[0].length, 2, "the primary and the spot");
    assert.deepEqual(s.sent.at(-1).args[1], [askerBody, askerBody]);
    assert.equal(s.sent.at(-1).args[2], askerPrice);
    passed(
      "Update price approves exactly two answers and buys the primary and the spot in one wallet batch with the pinned requests",
    );
  }
  {
    // When the asker's own rules let the Treasury pay (ask simulates cleanly), the button sends ask for the primary:
    // no approval, no IMD from the wallet, the pinned body.
    const { page, s } = await setup({
      state: { askerFree: true },
      deployment: (d) => ({
        ...d,
        oracleAsker: {
          address: "0x0000000000000000000000000000000000000019",
          requests: { PriceFeed: askerBody, NhiFeed: askerBody, SpotFeed: askerBody },
        },
      }),
    });
    await connect(page);
    await tab(page, "oracle");
    const panel = page.locator(".pane-oracle .price-status");
    assert.equal(await panel.getByRole("button", { name: /^Approve/ }).count(), 0, "nothing to approve");
    await panel.getByRole("button", { name: "About Update price" }).first().hover();
    await expectText(page.locator("body"), "The Treasury pays for the price update now");
    await panel.getByRole("button", { name: "Update price", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await page.locator("dialog").getByRole("button", { name: "Confirm in wallet" }).click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.equal(s.sent.at(-1).name, "asker");
    assert.equal(s.sent.at(-1).functionName, "ask");
    assert.deepEqual(s.sent.at(-1).args[1], askerBody);
    assert.ok(!s.sent.some((t) => t.name === "payToken"), "no IMD approval was sent");
    passed("Update price sends the Treasury-paid ask, with no approval, when the asker's rules allow it");
  }
  {
    // The oracle top-up: hidden while the asker holds 2 IMD or more, offered below it as a plain IMD transfer.
    const asker = {
      address: "0x0000000000000000000000000000000000000019",
      requests: { PriceFeed: askerBody, NhiFeed: askerBody, SpotFeed: askerBody },
    };
    let { page, s } = await setup({ state: { askerHeld: 2n * 10n ** 18n }, deployment: (d) => ({ ...d, oracleAsker: asker }) });
    await connect(page);
    await tab(page, "oracle");
    await page.locator(".pane-oracle .price-status").waitFor();
    assert.equal(await page.locator(".oracle-topup").count(), 0, "no top-up at 2 IMD");
    ({ page, s } = await setup({ state: { askerHeld: 15n * 10n ** 17n }, deployment: (d) => ({ ...d, oracleAsker: asker }) }));
    await connect(page);
    await tab(page, "oracle");
    const topUp = page.locator(".oracle-topup");
    await expectText(topUp, "enough for 3 more Treasury-paid updates");
    await page.locator(".pane-oracle").screenshot({ path: `${evidence}/oracle-topup-1440.png` });
    await topUp.getByLabel("IMD to send").fill("1");
    await review(page, "Review top-up");
    await page.locator("dialog").getByRole("button", { name: "Confirm in wallet" }).click();
    await expectText(page.locator("footer"), "Confirmed on chain.");
    assert.equal(s.sent.at(-1).name, "payToken");
    assert.equal(s.sent.at(-1).functionName, "transfer");
    assert.deepEqual(s.sent.at(-1).args, [asker.address, 10n ** 18n]);
    passed("Oracle top-up: hidden at 2 IMD, offered below it, and sends exactly the IMD entered to the asker");
  }
  {
    // sIMD is priced from IMD: with the vault's collateral feed unreadable, the terminal derives the same
    // figure from IMD / USD and the exchange rate, so the position still reads the same.
    const { page } = await setup({
      state: { share: true, collateralFeedFail: true },
    });
    await connect(page);
    await tab(page, "position");
    const pos = page.locator(".pane-position");
    await expectText(pos, "$\u00a01.5 / IMD");
    await expectText(pos, "800 sIMD ≈ 1,000 IMD");
    passed(
      "An unreadable collateral feed falls back to IMD / USD times the exchange rate",
    );
  }
  {
    // With no good book yet, an unverifiable history reads as unknown, not as an empty book; retry restores it.
    const { page, s } = await setup({ state: { logMode: "empty", explorerEmpty: true } });
    await tab(page, "loans");
    await expectText(page.locator(".pane-loans"), "Could not read loan book");
    assert.equal(await page.locator(".loan-mark").count(), 0);
    assert.match(await page.locator(".pane-loans").textContent(), /position count is unknown/);
    s.explorerEmpty = false;
    s.logMode = "rpc";
    await page.getByRole("button", { name: "Retry history", exact: true }).click();
    await page.locator(".loan-mark").first().waitFor();
    passed("With no book yet, unverifiable history reads as unknown and Retry history restores it");
    // The same for points: with no board yet, unreadable history is an error, never an empty board.
    s.logMode = "empty";
    s.explorerEmpty = true;
    await page.reload();
    await page.getByRole("tab", { name: "Points", exact: true }).click();
    await expectText(page.locator(".pane-points"), "not the same as nobody holding imdUSD");
    assert.equal(await page.locator(".points-feed li").count(), 0);
    passed("With no board yet, unreadable points history is an error, never an empty board");
  }
  assert.deepEqual(errors, [], JSON.stringify(errors.slice(0, 10)));
  passed(
    "No browser console errors or uncaught exceptions in mocked workflows",
  );
  await writeFile(
    `${evidence}/browser-results.json`,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url: "local /preview/ subpath",
        browser: await browser.version(),
        mode: "mocked RPC and wallet; no broadcasts",
        results,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
} catch (e) {
  await writeFile(`${evidence}/browser-failure.txt`, e.stack + "\n");
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
