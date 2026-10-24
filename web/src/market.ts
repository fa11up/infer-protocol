import { useEffect, useState } from "react";
import { encodeAbiParameters, fallback, http, keccak256, parseAbi } from "viem";
import { createReadClient } from "./read-client";
import { mainnet } from "viem/chains";
import rpcUrls from "./ens-rpc.json";
import { ownRpcFirst } from "./own-rpc";

// IMD's live market price, read where the feeds read it: the native-ETH/IMD Uniswap v4 pool on Ethereum
// mainnet (the feeds' data chain on every deployment, testnets included), priced in USD with Chainlink's
// mainnet ETH/USD. It is what the next price update would bring the vault's price towards. It is display
// only: the vault never reads it, and a pool can be pushed within a block, which is why the vault uses
// attested window medians instead.
export const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const IMD_POOL_ID = "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3";
export const ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
const POLL_MS = 30_000;

const client = createReadClient({
  chain: mainnet,
  transport: fallback(ownRpcFirst(rpcUrls, 6000)),
  batch: { multicall: false },
});
const abi = parseAbi([
  "function extsload(bytes32 slot) view returns (bytes32)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

export type Market = { imdEth: bigint; imdUsd: bigint; ethUsd: bigint; readAt: number };

/** The pool's slot0 lives at keccak256(abi.encode(poolId, 6)); its low 160 bits are sqrtPriceX96. */
export const SLOT0 = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [IMD_POOL_ID, 6n]));

export async function readMarket(): Promise<Market> {
  const [word, round] = await Promise.all([
    client.readContract({ address: POOL_MANAGER, abi, functionName: "extsload", args: [SLOT0] }),
    client.readContract({ address: ETH_USD, abi, functionName: "latestRoundData" }),
  ]);
  const sqrt = BigInt(word) & ((1n << 160n) - 1n);
  if (sqrt === 0n) throw Error("IMD's pool is not initialised");
  // currency0 is native ETH and currency1 is IMD, so the raw price is IMD per ETH; invert it.
  const imdEth = (10n ** 18n << 192n) / (sqrt * sqrt);
  const ethUsd = round[1] as bigint; // 8 decimals
  if (ethUsd <= 0n) throw Error("ETH/USD unreadable");
  return { imdEth, ethUsd, imdUsd: (imdEth * ethUsd) / 10n ** 8n, readAt: Date.now() };
}

/** The live market, refreshed every 30 s; undefined until read or while unreadable. */
export function useMarket(): Market | undefined {
  const [m, setM] = useState<Market>();
  useEffect(() => {
    let live = true;
    // A failed read keeps the last good price for two minutes, then shows none rather than an old one.
    const tick = () =>
      readMarket()
        .then((x) => live && setM(x))
        .catch(() => live && setM((old) => (old && Date.now() - old.readAt < 120_000 ? old : undefined)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return m;
}

// WHAT A FRESH PRIMARY WOULD SAY. The price feed's question is the median of N evenly spaced pool samples over
// a window of hours ending at the request (the deployment's request body: window.hours, "samples N"). After a
// fast move that median lags the live pool, and a purchase can land still too far from the spot for the vault
// to act. Reading the same samples tells a buyer before paying. Past blocks need archive state: drpc serves
// it, publicnode does not.
const archive = createReadClient({
  chain: mainnet,
  transport: http("https://eth.drpc.org", { timeout: 8000, retryCount: 1 }),
  batch: { multicall: false },
});
const BLOCKS_PER_HOUR = 300n;

export type Projection = { median: bigint; samples: bigint[]; spacingBlocks: bigint; readAt: number };

/** { hours, samples } from a request body (hex of its JSON bytes), or undefined. */
export function windowOf(body: `0x${string}` | undefined) {
  if (!body) return undefined;
  try {
    const bytes = new Uint8Array((body.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));
    const j = JSON.parse(new TextDecoder().decode(bytes));
    const m = /samples (\d+)/.exec(j.definitions?.recipe ?? "");
    const hours = Number(j.window?.hours);
    return hours && m && Number(m[1]) > 1 ? { hours: BigInt(hours), samples: Number(m[1]) } : undefined;
  } catch {
    return undefined;
  }
}

export function median(values: bigint[]) {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}

export async function readProjection(win: { hours: bigint; samples: number }): Promise<Projection> {
  const head = await archive.getBlockNumber();
  const span = win.hours * BLOCKS_PER_HOUR;
  const n = BigInt(win.samples - 1);
  const samples = await Promise.all(
    Array.from({ length: win.samples }, async (_, i) => {
      const blockNumber = head - span + (BigInt(i) * span) / n;
      const word = await archive.readContract({ address: POOL_MANAGER, abi, functionName: "extsload", args: [SLOT0], blockNumber });
      const sqrt = BigInt(word) & ((1n << 160n) - 1n);
      if (sqrt === 0n) throw Error("IMD's pool is not initialised");
      return (10n ** 18n << 192n) / (sqrt * sqrt);
    }),
  );
  return { median: median(samples), samples, spacingBlocks: span / n, readAt: Date.now() };
}

/** The projected primary, refreshed every two minutes; undefined until read, unreadable, or no window. */
export function useProjection(body: `0x${string}` | undefined): Projection | undefined {
  const [p, setP] = useState<Projection>();
  useEffect(() => {
    const win = windowOf(body);
    if (!win) return;
    let live = true;
    const tick = () =>
      readProjection(win)
        .then((x) => live && setP(x))
        .catch(() => live && setP((old) => (old && Date.now() - old.readAt < 300_000 ? old : undefined)));
    tick();
    const id = setInterval(tick, 120_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [body]);
  return p;
}
