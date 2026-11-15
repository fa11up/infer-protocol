// infer.imdusd.com/supply/<token>/<total|circulating>: a plain decimal number, the convention CoinGecko and
// CoinMarketCap read for supply, and /supply.json with both tokens and the holders left out of circulating.
// One Multicall3 read through /rpc (worker/rpc.js), so it shares the pages' 12-second cache and allowlist.
// Circulating = totalSupply minus the balances of the protocol contracts below (src/infer/supply.ts holds the
// same list and puts these addresses in rpc-allow.json; tests/infer.test.mjs checks the two agree).
import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi } from "viem";
import { handleRpc, MULTICALL3 } from "./rpc.js";

export const SUPPLY = {
  imdusd: {
    token: "0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25",
    decimals: 18,
    notCirculating: [{ holder: "0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc", label: "Treasury" }],
  },
  infer: {
    token: "0x53d0eA0A685220718Dc6a0a6e4617194C6F37921",
    decimals: 18,
    notCirculating: [
      { holder: "0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc", label: "Treasury" },
      { holder: "0x08DC1b5789Aa4951daC6022f2141C646c7F6F9f4", label: "SeasonVault (season rewards not yet paid)" },
      { holder: "0x5E11e627d63755Afa4b01D4c1de1E315EeFdb348", label: "LegacyRedeemer (set aside for legacy redemptions)" },
      { holder: "0x7328Da4251dd6E1f0AAF64F39c5137cbF160b9b3", label: "FounderStream (not yet vested)" },
      { holder: "0x0c1CE09ccfe9243c4ad23C3CAEE0C11D4E8340d3", label: "InferDripper (not yet dripped)" },
    ],
  },
};

const ERC20 = parseAbi(["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
const AGGREGATE3 = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

/** { total, circulating, notCirculating: [{holder, label, balance}] } as decimal strings, or throws. */
async function read(key, env, deps) {
  const t = SUPPLY[key];
  const calls = [
    { target: t.token, allowFailure: false, callData: encodeFunctionData({ abi: ERC20, functionName: "totalSupply" }) },
    ...t.notCirculating.map((h) => ({
      target: t.token,
      allowFailure: false,
      callData: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [h.holder] }),
    })),
  ];
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: MULTICALL3, data: encodeFunctionData({ abi: AGGREGATE3, functionName: "aggregate3", args: [calls] }) }, "latest"],
  };
  const r = await handleRpc(new Request("https://infer.imdusd.com/rpc", { method: "POST", body: JSON.stringify(body) }), env, deps);
  const j = await r.json();
  if (!j.result) throw new Error(j.error?.message ?? "no result");
  const res = decodeFunctionResult({ abi: AGGREGATE3, functionName: "aggregate3", data: j.result });
  const values = res.map((x, i) => decodeFunctionResult({ abi: ERC20, functionName: i ? "balanceOf" : "totalSupply", data: x.returnData }));
  const [total, ...held] = values;
  const out = held.reduce((a, b) => a + b, 0n);
  return {
    total: formatUnits(total, t.decimals),
    circulating: formatUnits(total - out, t.decimals),
    notCirculating: t.notCirculating.map((h, i) => ({ ...h, balance: formatUnits(held[i], t.decimals) })),
  };
}

const headers = (type) => ({
  "Content-Type": type,
  "Cache-Control": "public, max-age=60",
  "Access-Control-Allow-Origin": "*",
});

/** The /supply routes; null for any other path. */
export async function handleSupply(url, env, deps = {}) {
  if (url.pathname === "/supply.json") {
    try {
      const all = {};
      for (const k of Object.keys(SUPPLY)) all[k] = { token: SUPPLY[k].token, ...(await read(k, env, deps)) };
      return new Response(JSON.stringify(all, null, 1) + "\n", { headers: headers("application/json") });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message ?? e) }) + "\n", { status: 502, headers: headers("application/json") });
    }
  }
  const m = url.pathname.match(/^\/supply\/(imdusd|infer)\/(total|circulating)\/?$/);
  if (!m) return url.pathname.startsWith("/supply") ? new Response("not found\n", { status: 404 }) : null;
  try {
    const s = await read(m[1], env, deps);
    return new Response(s[m[2]] + "\n", { headers: headers("text/plain; charset=utf-8") });
  } catch (e) {
    // Never a made-up number: a failed read is an error, not a zero.
    return new Response(`supply unavailable: ${e.message ?? e}\n`, { status: 502, headers: headers("text/plain; charset=utf-8") });
  }
}
