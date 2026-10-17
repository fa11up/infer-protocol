// The swap card's pure half (src/swap0x.ts): amounts, the fee rule, best-of routing, the token list and 0x's answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWANCE_HOLDER,
  ETH_ADDRESS,
  IMDUSD_ADDRESS,
  TOKENS,
  USDC_ADDRESS,
  USDT_ADDRESS,
  approvalsFor,
  bestRoute,
  feeApplies,
  feeLine,
  formatAmount,
  isPegPair,
  minReceived,
  parseAmount,
  parseCustomTokens,
  quoteStale,
  readSwapAnswer,
  routeName,
  routeSummary,
  searchTokens,
  swapQuery,
} from "../src/swap0x.ts";
import { zeroXQuery } from "../worker/swap.js";

const IMD = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
const tok = (sym) => TOKENS.find((t) => t.symbol === sym);

test("amounts parse to base units, and anything else is not an amount", () => {
  assert.equal(parseAmount("1.5", 6), 1_500_000n);
  assert.equal(parseAmount(" 2 ", 18), 2n * 10n ** 18n);
  assert.equal(parseAmount(".5", 8), 50_000_000n);
  assert.equal(parseAmount("3.", 6), 3_000_000n);
  assert.equal(parseAmount("0.00000001", 8), 1n);
  for (const bad of ["", "0", "0.0", "-1", "1e3", "1,000", "abc", "1.2.3", "0.000000001"])
    assert.equal(parseAmount(bad, 8), undefined, bad);
});

test("amounts format with enough digits for a small one", () => {
  assert.equal(formatAmount(1_234_567_890n, 6), "1,234.56");
  assert.equal(formatAmount(1_500_000n, 6), "1.5");
  assert.equal(formatAmount(12_345n, 8), "0.00012345");
  assert.equal(formatAmount(10n ** 18n * 3n + 10n ** 14n * 1234n, 18), "3.1234");
  assert.equal(formatAmount(0n, 18), "0");
  assert.equal(formatAmount(undefined, 18), "—");
});

test("the fee rule matches the Worker's: none when either side is imdUSD", () => {
  const pairs = [
    [ETH_ADDRESS, USDC_ADDRESS, true],
    [IMD, USDC_ADDRESS, true],
    [IMDUSD_ADDRESS, USDC_ADDRESS, false],
    [USDC_ADDRESS, IMDUSD_ADDRESS.toLowerCase(), false],
    [ETH_ADDRESS, IMDUSD_ADDRESS, false],
  ];
  for (const [a, b, fee] of pairs) {
    assert.equal(feeApplies(a, b), fee, `${a}>${b}`);
    const q = zeroXQuery("price", new URLSearchParams({ chainId: "1", sellToken: a, buyToken: b, sellAmount: "1" })).query;
    assert.equal(q.get("swapFeeBps") === "10", fee, `worker ${a}>${b}`);
  }
  assert.equal(feeLine(ETH_ADDRESS, USDC_ADDRESS), "0.1% to the imdUSD Treasury");
  assert.equal(feeLine(IMDUSD_ADDRESS, USDC_ADDRESS), "No fee on imdUSD trades");
});

test("the page's query passes the Worker's checks", () => {
  const me = "0x5167d014a056e43883e1bbea5530c3c0dc993281";
  for (const [s, b] of [["ETH", "USDC"], ["USDT", "imdUSD"], ["cbBTC", "INFER"]]) {
    const { error } = zeroXQuery("quote", swapQuery(tok(s), tok(b), 123n, 50, me));
    assert.equal(error, undefined, `${s}>${b}`);
  }
});

test("best of 0x and the peg pool: more wins, the pool on a tie or when 0x has nothing", () => {
  assert.equal(bestRoute(101n, 100n), "0x");
  assert.equal(bestRoute(100n, 101n), "direct");
  assert.equal(bestRoute(100n, 100n), "direct");
  assert.equal(bestRoute(undefined, 5n), "direct");
  assert.equal(bestRoute(5n, undefined), "0x");
  assert.equal(bestRoute(undefined, undefined), undefined);
  assert.equal(routeName("0x"), "Matcha/0x");
  assert.equal(routeName("direct"), "Direct: imdUSD peg pool");
  assert.ok(isPegPair(IMDUSD_ADDRESS, USDC_ADDRESS) && isPegPair(USDC_ADDRESS.toLowerCase(), IMDUSD_ADDRESS));
  assert.ok(!isPegPair(ETH_ADDRESS, USDC_ADDRESS) && !isPegPair(IMDUSD_ADDRESS, USDT_ADDRESS));
});

test("token search: symbol first, names, addresses, and a pasted unknown address", () => {
  assert.equal(searchTokens(TOKENS, "").matches.length, TOKENS.length);
  const usd = searchTokens(TOKENS, "usd").matches.map((t) => t.symbol);
  assert.deepEqual(usd.slice(0, 1), ["USDC"]);
  assert.ok(usd.includes("imdUSD") && usd.includes("USDT"));
  assert.deepEqual(searchTokens(TOKENS, "btc").matches.map((t) => t.symbol), ["WBTC", "cbBTC"]);
  assert.deepEqual(searchTokens(TOKENS, IMD.toLowerCase()).matches.map((t) => t.symbol), ["IMD"]);
  const pasted = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
  assert.deepEqual(searchTokens(TOKENS, ` ${pasted} `), { matches: [], paste: pasted });
  assert.equal(searchTokens(TOKENS, "0x123").paste, undefined);
});

test("custom tokens from storage: malformed entries, duplicates and listed tokens are dropped", () => {
  const dai = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
  const raw = JSON.stringify([
    { address: dai, symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
    { address: dai, symbol: "DUP", name: "dup", decimals: 18 },
    { address: USDC_ADDRESS, symbol: "FAKE", name: "", decimals: 6 },
    { address: "0x12", symbol: "BAD", decimals: 18 },
    { address: "0x1111111111111111111111111111111111111111", symbol: "<img src=x>", name: "n", decimals: 99 },
    { address: "0x2222222222222222222222222222222222222222", symbol: "<b>HI</b>", name: "x".repeat(80), decimals: 6 },
    null,
    "x",
  ]);
  const got = parseCustomTokens(raw);
  assert.deepEqual(got.map((t) => t.symbol), ["DAI", "bHIb"]);
  assert.ok(got.every((t) => t.custom));
  assert.equal(got[1].name.length, 40);
  assert.deepEqual(parseCustomTokens("not json"), []);
  assert.deepEqual(parseCustomTokens(null), []);
  assert.deepEqual(parseCustomTokens('{"a":1}'), []);
});

test("0x's answers: usable, unavailable, no liquidity, or an error", () => {
  assert.equal(readSwapAnswer(200, { liquidityAvailable: true, buyAmount: "5" }).ok, true);
  for (const s of [503, 502, 404]) assert.equal(readSwapAnswer(s, { error: "x" }).unavailable, true, String(s));
  assert.match(readSwapAnswer(200, { liquidityAvailable: false }).error, /liquidity/);
  assert.match(readSwapAnswer(400, { name: "INSUFFICIENT_BALANCE" }).error, /enough/);
  assert.match(readSwapAnswer(400, { name: "TOKEN_NOT_SUPPORTED" }).error, /does not trade/);
  assert.match(readSwapAnswer(429, {}).error, /minute/);
  assert.equal(readSwapAnswer(400, { name: "X" }).unavailable, false);
});

test("route summary, minimum received and quote age", () => {
  const a = {
    route: {
      fills: [
        { from: ETH_ADDRESS, to: USDC_ADDRESS, source: "Uniswap_V4", proportionBps: "7000" },
        { from: ETH_ADDRESS, to: USDC_ADDRESS, source: "Curve", proportionBps: "3000" },
      ],
      tokens: [],
    },
  };
  assert.equal(routeSummary(a), "Uniswap V4 70% · Curve 30%");
  const hop = {
    route: {
      fills: [
        { from: IMD, to: ETH_ADDRESS, source: "Uniswap_V4", proportionBps: "10000" },
        { from: ETH_ADDRESS, to: USDC_ADDRESS, source: "Uniswap_V3", proportionBps: "10000" },
      ],
      tokens: [{ address: ETH_ADDRESS, symbol: "ETH" }],
    },
  };
  assert.equal(routeSummary(hop), "Uniswap V4 · Uniswap V3 via ETH");
  assert.equal(routeSummary({}), "—");
  assert.equal(minReceived(10_000n, 50), 9_950n);
  assert.equal(minReceived(10_000n, 50, "9900"), 9_900n);
  assert.equal(quoteStale(0, 20_000), false);
  assert.equal(quoteStale(0, 20_001), true);
});

test("approvals: exact, only to AllowanceHolder, none for ETH, and USDT's reset to zero", () => {
  const usdc = tok("USDC");
  assert.deepEqual(approvalsFor(usdc, 100n, null), []);
  assert.deepEqual(approvalsFor(usdc, 100n, { actual: "0", spender: ALLOWANCE_HOLDER }), [{ spender: ALLOWANCE_HOLDER, amount: 100n }]);
  assert.deepEqual(approvalsFor(usdc, 100n, { actual: "100", spender: ALLOWANCE_HOLDER }), []);
  assert.deepEqual(approvalsFor(tok("ETH"), 100n, { actual: "0", spender: ALLOWANCE_HOLDER }), []);
  assert.deepEqual(approvalsFor(tok("USDT"), 100n, { actual: "5", spender: ALLOWANCE_HOLDER }), [
    { spender: ALLOWANCE_HOLDER, amount: 0n },
    { spender: ALLOWANCE_HOLDER, amount: 100n },
  ]);
  assert.throws(() => approvalsFor(usdc, 100n, { actual: "0", spender: "0x1111111111111111111111111111111111111111" }), /unexpected/);
});
