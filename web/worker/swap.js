// imdusd.com/swap/price and /swap/quote: the terminal's Trade tab asks 0x's Swap API (the engine behind Matcha)
// through here, so the API key stays a Worker secret (ZEROX_API_KEY) and never reaches the page.
// * Only the fields the Trade tab sends are passed on, each checked; anything else is refused, not forwarded.
// * The fee is set HERE, never by the page: 0.1% to the imdUSD Treasury, taken in the token bought, on every swap
//   where neither side is imdUSD. imdUSD trades carry none.
// * Same-origin only (no CORS headers), and rate-limited per IP like /rpc.

export const ZEROX = "https://api.0x.org/swap/allowance-holder/";
export const TREASURY = "0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc";
export const IMDUSD = "0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25";
export const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const FEE_BPS = 10;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ALLOWED = {
  price: ["chainId", "sellToken", "buyToken", "sellAmount", "slippageBps", "taker"],
  quote: ["chainId", "sellToken", "buyToken", "sellAmount", "slippageBps", "taker"],
};

/** True when no fee applies: either side is imdUSD. */
export const feeFree = (sellToken, buyToken) =>
  [sellToken, buyToken].some((t) => String(t).toLowerCase() === IMDUSD.toLowerCase());

/**
 * The query 0x is asked, from the page's query: `{ query }` (a URLSearchParams) or `{ error }`. Pure, so the
 * rules are unit-tested (tests/swap0x.worker.test.mjs).
 */
export function zeroXQuery(kind, params) {
  const allowed = ALLOWED[kind];
  if (!allowed) return { error: "Unknown swap route." };
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  for (const k of p.keys()) if (!allowed.includes(k)) return { error: `${k} is not accepted.` };
  for (const k of new Set(p.keys())) if (p.getAll(k).length > 1) return { error: `${k} is given twice.` };
  if (p.get("chainId") !== "1") return { error: "Only Ethereum mainnet (chainId=1) is served." };
  const sellToken = p.get("sellToken") ?? "";
  const buyToken = p.get("buyToken") ?? "";
  if (!ADDRESS.test(sellToken)) return { error: "sellToken must be a token address." };
  if (!ADDRESS.test(buyToken)) return { error: "buyToken must be a token address." };
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) return { error: "sellToken and buyToken are the same." };
  const sellAmount = p.get("sellAmount") ?? "";
  if (!/^[1-9][0-9]{0,77}$/.test(sellAmount)) return { error: "sellAmount must be a positive whole number of base units." };
  const taker = p.get("taker");
  if (kind === "quote" && taker === null) return { error: "A quote needs the taker's address." };
  if (taker !== null && (!ADDRESS.test(taker) || /^0x0{40}$/.test(taker))) return { error: "taker must be an address." };
  const slippage = p.get("slippageBps");
  if (slippage !== null && !(/^[0-9]{2,3}$/.test(slippage) && Number(slippage) >= 10 && Number(slippage) <= 300))
    return { error: "slippageBps must be a whole number from 10 to 300." };

  const query = new URLSearchParams({ chainId: "1", sellToken, buyToken, sellAmount });
  if (taker !== null) query.set("taker", taker);
  if (slippage !== null) query.set("slippageBps", slippage);
  if (!feeFree(sellToken, buyToken)) {
    query.set("swapFeeRecipient", TREASURY);
    query.set("swapFeeBps", String(FEE_BPS));
    query.set("swapFeeToken", buyToken);
  }
  return { query };
}

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

async function under(binding, key) {
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

/** A request from another site: a browser says so in Sec-Fetch-Site or Origin. */
function crossSite(request, url) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return true;
  const origin = request.headers.get("origin");
  return !!origin && origin !== url.origin;
}

export async function handleSwap(request, env, deps = {}) {
  const fetcher = deps.fetch ?? fetch;
  const url = new URL(request.url);
  const kind = url.pathname === "/swap/price" ? "price" : url.pathname === "/swap/quote" ? "quote" : null;
  if (!kind) return json(404, { error: "Not found." });
  if (request.method !== "GET") return json(405, { error: "GET only." }, { allow: "GET" });
  if (crossSite(request, url)) return json(403, { error: "Same-origin only." });
  const who = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await under(env.SWAP_REQUESTS, who)))
    return json(429, { error: "Too many swap quotes from this address. Try again in a minute." }, { "retry-after": "60" });
  const { query, error } = zeroXQuery(kind, url.searchParams);
  if (error) return json(400, { error });
  if (!env.ZEROX_API_KEY) return json(503, { error: "Swaps are temporarily unavailable.", reason: "unconfigured" });
  let res;
  try {
    res = await fetcher(`${ZEROX}${kind}?${query}`, {
      headers: { "0x-api-key": env.ZEROX_API_KEY, "0x-version": "v2", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return json(502, { error: "The swap router could not be reached." });
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(502, { error: `The swap router answered ${res.status} without JSON.` });
  }
  // An upstream 401/403 means the key is wrong: say "unavailable", never echo anything about the key.
  if (res.status === 401 || res.status === 403) {
    console.log(`swap: 0x refused the key (${res.status})`);
    return json(503, { error: "Swaps are temporarily unavailable.", reason: "upstream" });
  }
  return json(res.status, body);
}
