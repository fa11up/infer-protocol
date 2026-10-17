// Manual check of the Trade tab's 0x route with REAL quotes. Sends no transaction and signs nothing: it asks for
// prices only (no taker) and prints the route and the fee fields 0x echoes back.
//
//   node tests/swap0x-live.mjs                          # through the deployed Worker: https://imdusd.com/swap/price
//   SWAP_BASE=http://127.0.0.1:8787 node tests/swap0x-live.mjs    # through `wrangler dev`
//   ZEROX_API_KEY=... node tests/swap0x-live.mjs --direct          # straight to 0x with worker/swap.js's query
//
// Expected: ETH -> USDC and IMD -> USDC carry swapFeeBps 10 to the Treasury (an integratorFee in USDC);
// imdUSD -> USDC carries none. The key is never printed.
import { zeroXQuery, ZEROX, TREASURY } from "../worker/swap.js";
import { TOKENS, routeSummary, formatAmount } from "../src/swap0x.ts";

const BASE = process.env.SWAP_BASE ?? "https://imdusd.com";
const direct = process.argv.includes("--direct");
if (direct && !process.env.ZEROX_API_KEY) throw Error("--direct needs ZEROX_API_KEY in the environment");
const tok = (s) => TOKENS.find((t) => t.symbol === s);
const cases = [
  ["ETH", "USDC", 10n ** 17n], // 0.1 ETH
  ["IMD", "USDC", 10n * 10n ** 18n], // 10 IMD
  ["imdUSD", "USDC", 25n * 10n ** 18n], // 25 imdUSD
];

let failed = 0;
for (const [s, b, amount] of cases) {
  const sell = tok(s);
  const buy = tok(b);
  const page = new URLSearchParams({ chainId: "1", sellToken: sell.address, buyToken: buy.address, sellAmount: String(amount), slippageBps: "50" });
  let res;
  if (direct) {
    const { query, error } = zeroXQuery("price", page);
    if (error) throw Error(error);
    res = await fetch(`${ZEROX}price?${query}`, { headers: { "0x-api-key": process.env.ZEROX_API_KEY, "0x-version": "v2" } });
  } else res = await fetch(`${BASE}/swap/price?${page}`, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  console.log(`\n${s} -> ${b}: ${formatAmount(amount, sell.decimals)} ${s}  [HTTP ${res.status}]`);
  if (!res.ok || !body.buyAmount) {
    console.log("  ", JSON.stringify(body).slice(0, 400));
    failed++;
    continue;
  }
  const fee = body.fees?.integratorFee;
  console.log(`  buyAmount       ${formatAmount(BigInt(body.buyAmount), buy.decimals)} ${b}`);
  console.log(`  minBuyAmount    ${body.minBuyAmount ? formatAmount(BigInt(body.minBuyAmount), buy.decimals) : "—"} ${b}`);
  console.log(`  route           ${routeSummary(body)}`);
  console.log(`  integratorFee   ${fee ? `${fee.amount} of ${fee.token} (${fee.type ?? ""})` : "none"}`);
  console.log(`  zeroExFee       ${JSON.stringify(body.fees?.zeroExFee ?? null)}`);
  console.log(`  allowance spender ${body.issues?.allowance?.spender ?? "(no taker: not checked)"}`);
  const wantFee = s !== "imdUSD" && b !== "imdUSD";
  const ok = wantFee ? !!fee && fee.token.toLowerCase() === buy.address.toLowerCase() : !fee;
  console.log(`  fee rule        ${ok ? "OK" : "MISMATCH"} (expected ${wantFee ? `0.1% to ${TREASURY}` : "no fee"})`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} case(s) need a look` : "\nall three answered as expected");
process.exit(failed ? 1 : 0);
