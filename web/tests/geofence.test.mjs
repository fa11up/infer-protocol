// The stock-token geofence (worker/geo.js, src/geofence.ts, src/stock-gate.ts, scripts/geofence-check.mjs):
// every restricted code and an unknown country get no stock UI, an allowed one does after the declaration, an
// existing borrower can always unwind, and a stock pane cannot be written without the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { encodeFunctionData, parseAbi, stringToHex } from "viem";
import GEO from "../src/geofence.json" with { type: "json" };
import { countryOf, geoAnswer, handleGeo } from "../worker/geo.js";
import { isStockIlk, readStockIlks, stockAccess, stockSendRefusal } from "../src/geofence.ts";
import { StockGate } from "../src/stock-gate.ts";
import { checkGeofence, gateProblem } from "../scripts/geofence-check.mjs";

const BLOCKED = Object.values(GEO.blocked).flat();
const ALLOWED = ["DE", "SG", "FR", "JP", "BR"];
const req = (country, header) => {
  const r = new Request("https://imdusd.com/geo", { headers: header ? { "cf-ipcountry": header } : {} });
  if (country !== undefined) Object.defineProperty(r, "cf", { value: { country } });
  return r;
};
const pane = (gate) => createElement("section", { id: "stock-pane" }, [...gate.actions].sort().join(","));
const render = (geo, extra = {}) => renderToString(createElement(StockGate, { geo, wallet: "0xabc", ...extra, children: pane }));

test("the table holds the issuer's named countries, the Prohibited Investors and the fail-closed codes", () => {
  for (const c of ["US", "CA", "GB", "CH", "CU", "BY", "IR", "KP", "RU", "SY", "UA", "SS", "SD", "MM", "VE", "PR", "JE", "AE"]) assert.ok(BLOCKED.includes(c), c);
  assert.deepEqual(GEO.failClosed, ["XX", "T1"]);
  assert.match(GEO.issuer.restrictedJurisdictions, /^https:\/\/docs\.robinhood\.com\//);
});

test("/geo: every blocked code, XX, T1 and a missing country say no; allowed codes say yes; never cached", async () => {
  for (const c of [...BLOCKED, ...GEO.failClosed]) assert.equal(geoAnswer(c).stocks, false, c);
  for (const c of ALLOWED) assert.deepEqual(geoAnswer(c), { country: c, stocks: true, reason: "allowed" });
  assert.equal(countryOf(req(undefined)), "");
  assert.equal(countryOf(req(undefined, "de")), "DE");
  assert.equal(countryOf(req("US", "DE")), "US", "cf.country wins over the header");
  assert.equal(countryOf(req("<script>")), "");
  const res = handleGeo(req(undefined));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { country: "", stocks: false, reason: "unknown" });
  assert.equal((await handleGeo(req("T1")).json()).reason, "unknown");
  assert.equal((await handleGeo(req("US")).json()).reason, "restricted");
  assert.equal(handleGeo(new Request("https://imdusd.com/geo", { method: "POST" })).status, 405);
});

test("a restricted or unknown country renders no stock UI; an allowed one renders it after the declaration", () => {
  for (const c of [...BLOCKED, "XX", "T1", ""]) {
    assert.equal(render(geoAnswer(c)), "", c);
  }
  assert.equal(render(null), "", "no answer yet = nothing");
  const allowed = geoAnswer("DE");
  const first = render(allowed);
  assert.doesNotMatch(first, /stock-pane/, "no pane before the declaration");
  assert.match(first, /stock-declaration/);
  assert.equal(stockAccess(allowed, { declared: true }).mode, "full");
  assert.match(render(allowed, { declared: true }), /id="stock-pane">borrow,claim,deposit,repay,take,trade,view,withdraw</);
  for (const c of BLOCKED) assert.equal(render(geoAnswer(c), { declared: true }), "", `declaring does not open ${c}`);
});

test("an existing borrower in a restricted country sees the position read-only with repay / withdraw / claim", () => {
  const html = render(geoAnswer("US"), { hasPosition: true });
  assert.match(html, /id="stock-pane">claim,repay,view,withdraw</);
  assert.match(render(geoAnswer("XX"), { hasPosition: true }), /claim,repay,view,withdraw/);
  // in an allowed country before the declaration, the borrower can still unwind beside the prompt
  assert.match(render(geoAnswer("DE"), { hasPosition: true }), /stock-declaration.*claim,repay,view,withdraw/s);
  assert.deepEqual([...stockAccess(geoAnswer("DE"), { declared: true }).actions].sort(), ["borrow", "claim", "deposit", "repay", "take", "trade", "view", "withdraw"]);
});

const SPY = stringToHex("STOCK-SPY", { size: 32 });
const ETH = stringToHex("ETH-A", { size: 32 });
const NEW = stringToHex("ANYTHING-NEW", { size: 32 });

test("stock types come from chain (group 1): a type added later is hidden with no site change", async () => {
  assert.equal(isStockIlk(NEW, 1), true);
  assert.equal(isStockIlk(ETH, 0), false);
  assert.equal(isStockIlk(SPY, undefined), true, "named like a stock = treated as one");
  assert.equal(isStockIlk(stringToHex("SGOV", { size: 32 }), 0), true);
  const groups = new Map([[SPY, 1], [ETH, 0], [NEW, 1]]);
  const ilks = [...groups.keys()];
  const client = {
    async readContract({ functionName, args }) {
      if (functionName === "ilkCount") return BigInt(ilks.length);
      if (functionName === "ilks") return ilks[Number(args[0])];
      return groups.get(args[0]);
    },
  };
  const got = await readStockIlks(client, "0x0000000000000000000000000000000000000001");
  assert.deepEqual([...got].sort(), [NEW, SPY].map((x) => x.toLowerCase()).sort());
});

test("the page refuses to send a stock borrow or take from a restricted country, and lets a repay through", () => {
  const abi = parseAbi([
    "function adjust(bytes32,int256,int256,uint64,address,address,bool)",
    "function repayFor(bytes32,address,uint256)",
    "function take(address,uint256)",
    "function claim(address)",
  ]);
  const Z = "0x0000000000000000000000000000000000000000";
  const ledger = "0x00000000000000000000000000000000000000aa";
  const join = "0x00000000000000000000000000000000000000bb";
  const where = { ledger, stockJoins: new Set([join]), stockIlks: new Set([SPY.toLowerCase()]) };
  const adjust = (ilk, dc, dd) => ({ to: ledger, data: encodeFunctionData({ abi, functionName: "adjust", args: [ilk, dc, dd, 0n, Z, Z, false] }) });
  const us = stockAccess(geoAnswer("US"), { hasPosition: true });
  const none = stockAccess(geoAnswer("US"));
  const de = stockAccess(geoAnswer("DE"), { declared: true });
  assert.match(stockSendRefusal(adjust(SPY, 10n, 5n), where, us), /not offered/);
  assert.match(stockSendRefusal(adjust(SPY, 0n, 1n), where, us), /not offered/);
  assert.equal(stockSendRefusal(adjust(SPY, -10n, -5n), where, us), null, "unwinding is allowed");
  assert.match(stockSendRefusal(adjust(SPY, -10n, -5n), where, none), /not offered/, "no position, no exception");
  assert.equal(stockSendRefusal({ to: ledger, data: encodeFunctionData({ abi, functionName: "repayFor", args: [SPY, Z, 1n] }) }, where, us), null);
  assert.match(stockSendRefusal({ to: join, data: encodeFunctionData({ abi, functionName: "take", args: [Z, 1n] }) }, where, us), /auctions/);
  assert.equal(stockSendRefusal({ to: join, data: encodeFunctionData({ abi, functionName: "claim", args: [Z] }) }, where, us), null);
  assert.equal(stockSendRefusal(adjust(ETH, 10n, 5n), where, none), null, "other types are not judged");
  assert.equal(stockSendRefusal(adjust(SPY, 10n, 5n), where, de), null);
  assert.equal(stockSendRefusal({ to: join, data: encodeFunctionData({ abi, functionName: "take", args: [Z, 1n] }) }, where, de), null);
});

test("a stock pane cannot be written without the gate; today's source passes", async () => {
  assert.deepEqual(await checkGeofence(), []);
  assert.match(gateProblem("StockPane.tsx", `const t = "STOCK-SPY"; export const P = () => <div/>;`), /does not import stock-gate/);
  assert.match(gateProblem("X.tsx", `import { GEO } from "./stock-gate";\n// StockJoin take`), /never renders through/);
  assert.equal(gateProblem("Y.tsx", `import { StockGate } from "./stock-gate";\nconst ilk = "SGOV";`), null);
  assert.equal(gateProblem("Z.tsx", `const eth = "ETH-A";`), null);
});
