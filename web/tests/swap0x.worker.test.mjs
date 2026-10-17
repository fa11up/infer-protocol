// worker/swap.js: what /swap/price and /swap/quote pass to 0x, and the Treasury fee it adds (never the page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroXQuery, handleSwap, feeFree, TREASURY, IMDUSD, ETH } from "../worker/swap.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const IMD = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
const ME = "0x5167d014a056e43883e1bbea5530c3c0dc993281";
const q = (o) => new URLSearchParams(o);
const base = { chainId: "1", sellToken: ETH, buyToken: USDC, sellAmount: "1000000000000000000" };

test("a swap with no imdUSD side carries 0.1% to the Treasury, in the token bought", () => {
  const { query, error } = zeroXQuery("price", q(base));
  assert.equal(error, undefined);
  assert.equal(query.get("swapFeeRecipient"), TREASURY);
  assert.equal(query.get("swapFeeBps"), "10");
  assert.equal(query.get("swapFeeToken"), USDC);
  const other = zeroXQuery("price", q({ ...base, sellToken: IMD })).query;
  assert.equal(other.get("swapFeeToken"), USDC);
});

test("imdUSD on either side, in any letter case, carries no fee", () => {
  for (const pair of [
    { sellToken: IMDUSD, buyToken: USDC },
    { sellToken: USDC, buyToken: IMDUSD.toLowerCase() },
    { sellToken: ETH, buyToken: IMDUSD.toUpperCase().replace("0X", "0x") },
  ]) {
    const { query } = zeroXQuery("quote", q({ ...base, ...pair, taker: ME }));
    assert.ok(query, JSON.stringify(pair));
    for (const k of ["swapFeeRecipient", "swapFeeBps", "swapFeeToken"]) assert.equal(query.get(k), null, k);
  }
  assert.equal(feeFree(USDC, ETH), false);
});

test("the page cannot set or override the fee, or pass any other field", () => {
  for (const k of ["swapFeeRecipient", "swapFeeBps", "swapFeeToken", "buyAmount", "excludedSources", "txOrigin"])
    assert.match(zeroXQuery("price", q({ ...base, [k]: "1" })).error, /not accepted/, k);
  assert.match(zeroXQuery("price", new URLSearchParams("chainId=1&chainId=1&sellToken=" + ETH)).error, /twice/);
});

test("every field is checked", () => {
  const bad = [
    [{ chainId: "8453" }, /mainnet/],
    [{ chainId: undefined }, /mainnet/],
    [{ sellToken: "ETH" }, /sellToken/],
    [{ buyToken: "0x123" }, /buyToken/],
    [{ buyToken: ETH.toLowerCase() }, /same/],
    [{ sellAmount: "0" }, /sellAmount/],
    [{ sellAmount: "1.5" }, /sellAmount/],
    [{ sellAmount: "-1" }, /sellAmount/],
    [{ sellAmount: "1e18" }, /sellAmount/],
    [{ slippageBps: "9" }, /slippage/],
    [{ slippageBps: "301" }, /slippage/],
    [{ slippageBps: "50.5" }, /slippage/],
    [{ taker: "0x0000000000000000000000000000000000000000" }, /taker/],
  ];
  for (const [patch, why] of bad) {
    const o = { ...base, ...patch };
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    assert.match(zeroXQuery("price", q(o)).error ?? "", why, JSON.stringify(patch));
  }
  assert.match(zeroXQuery("quote", q(base)).error, /taker/);
  for (const s of ["10", "50", "300"]) assert.equal(zeroXQuery("price", q({ ...base, slippageBps: s })).query.get("slippageBps"), s);
  assert.match(zeroXQuery("swap", q(base)).error, /Unknown/);
});

const req = (path, headers = {}, method = "GET") =>
  new Request(`https://imdusd.com${path}`, { method, headers: { "sec-fetch-site": "same-origin", ...headers } });

test("no key: 503 with a JSON error, and 0x is never called", async () => {
  let called = 0;
  const res = await handleSwap(req(`/swap/price?${q(base)}`), {}, { fetch: async () => (called++, new Response("{}")) });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /temporarily unavailable/);
  assert.equal(called, 0);
});

test("with a key: the key and version go in headers, the fee in the query, and the answer comes back", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url: new URL(url), headers: init.headers };
    return new Response(JSON.stringify({ buyAmount: "123", liquidityAvailable: true }), { status: 200 });
  };
  const res = await handleSwap(req(`/swap/quote?${q({ ...base, taker: ME, slippageBps: "50" })}`), { ZEROX_API_KEY: "k" }, { fetch });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).buyAmount, "123");
  assert.equal(seen.url.origin + seen.url.pathname, "https://api.0x.org/swap/allowance-holder/quote");
  assert.equal(seen.headers["0x-api-key"], "k");
  assert.equal(seen.headers["0x-version"], "v2");
  assert.equal(seen.url.searchParams.get("swapFeeRecipient"), TREASURY);
  assert.equal(seen.url.searchParams.get("taker"), ME);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("0x refusing the key reads as unavailable and says nothing about the key", async () => {
  const res = await handleSwap(req(`/swap/price?${q(base)}`), { ZEROX_API_KEY: "secret-k" }, {
    fetch: async () => new Response(JSON.stringify({ message: "invalid api key secret-k" }), { status: 401 }),
  });
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /secret-k/);
});

test("cross-site, wrong method, unknown path, bad query and rate limit are refused before 0x", async () => {
  let called = 0;
  const deps = { fetch: async () => (called++, new Response("{}")) };
  const env = { ZEROX_API_KEY: "k" };
  const at = `/swap/price?${q(base)}`;
  assert.equal((await handleSwap(req(at, { "sec-fetch-site": "cross-site" }), env, deps)).status, 403);
  assert.equal((await handleSwap(req(at, { origin: "https://evil.example" }), env, deps)).status, 403);
  assert.equal((await handleSwap(req(at, {}, "POST"), env, deps)).status, 405);
  assert.equal((await handleSwap(req("/swap/other"), env, deps)).status, 404);
  assert.equal((await handleSwap(req(`/swap/price?${q({ ...base, chainId: "10" })}`), env, deps)).status, 400);
  const limited = { ...env, SWAP_REQUESTS: { limit: async () => ({ success: false }) } };
  assert.equal((await handleSwap(req(at), limited, deps)).status, 429);
  assert.equal(called, 0);
  // Same origin passes.
  assert.equal((await handleSwap(req(at, { origin: "https://imdusd.com" }), env, deps)).status, 200);
});

test("the site Worker routes /swap/* to it", async () => {
  const { default: worker } = await import("../worker/index.js");
  const res = await worker.fetch(req(`/swap/price?${q(base)}`), { ASSETS: { fetch: async () => new Response("asset") } });
  assert.equal(res.status, 503);
});
