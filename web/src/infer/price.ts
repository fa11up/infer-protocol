// INFER's market price in USD and its market cap, for the /buy/ card. Three reads, all on mainnet over
// the launch RPCs: the launch pool's slot0 (INFER in its pair), IMD's own native-ETH/IMD v4 pool (IMD in
// ETH, the pool the vault's feeds read; src/market.ts reads the same one for imdusd.com), and Chainlink's
// ETH/USD. Display only, like the trade pane's price: a pool can be pushed within a block.
import { useEffect, useState } from "react";
import { encodeAbiParameters, keccak256, parseAbi, type Hex } from "viem";
import { client, ERC20 } from "./chain";
import { LAUNCH, LIVE } from "./config";
import { NATIVE, priceFromSlot0, slot0Slot } from "./swap";
import { everyVisible } from "./visible";

const IMD = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
const IMD_POOL_ID: Hex =
  "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3";
const ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
/** Chainlink's heartbeat for ETH/USD is an hour; a round older than two is not a price. */
const ETH_USD_MAX_AGE_S = 2n * 3600n;
const POLL_MS = 60_000;
const KEEP_MS = 180_000;

const CHAINLINK = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

export type InferMarket = {
  /** USD per INFER, 1e18-scaled. */
  priceUsd: bigint;
  /** USD, 1e18-scaled: price × total supply. INFER is minted once, so this is also the FDV. */
  marketCapUsd: bigint;
  readAt: number;
};

const slot = (word: Hex | undefined) => {
  if (!word || (BigInt(word) & ((1n << 160n) - 1n)) === 0n)
    throw Error("pool is not initialised");
  return word;
};

/** USD per one whole pair token, 1e18-scaled: IMD through its ETH pool, or ETH itself. */
async function pairUsd(ethUsd: bigint): Promise<bigint> {
  const pair = LAUNCH.contracts.pair.toLowerCase();
  if (pair === NATIVE) return ethUsd * 10n ** 10n;
  if (pair !== IMD.toLowerCase())
    throw Error("no USD route for the pair token");
  const word = slot(
    await client.getStorageAt({
      address: LAUNCH.contracts.poolManager,
      slot: keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "uint256" }],
          [IMD_POOL_ID, 6n],
        ),
      ),
    }),
  );
  // currency0 is native ETH and currency1 is IMD, so ETH per IMD is the inverse.
  return (priceFromSlot0(word, true) * ethUsd) / 10n ** 8n;
}

export async function readInferMarket(): Promise<InferMarket> {
  const key = LAUNCH.poolKey,
    infer = LAUNCH.contracts.infer;
  if (!LIVE || !key || !infer) throw Error("INFER is not launched");
  const [word, round, supply, block] = await Promise.all([
    client.getStorageAt({
      address: LAUNCH.contracts.poolManager,
      slot: slot0Slot(key),
    }),
    client.readContract({
      address: ETH_USD,
      abi: CHAINLINK,
      functionName: "latestRoundData",
    }),
    client.readContract({ address: infer, abi: ERC20, functionName: "totalSupply" }),
    client.getBlock(),
  ]);
  const ethUsd = round[1];
  if (ethUsd <= 0n || block.timestamp - round[3] > ETH_USD_MAX_AGE_S)
    throw Error("ETH/USD is stale");
  // pair per INFER: slot0 gives currency1 per currency0, so invert when INFER is currency1.
  const inferPair = priceFromSlot0(
    slot(word),
    infer.toLowerCase() === key.currency1.toLowerCase(),
  );
  const priceUsd = (inferPair * (await pairUsd(ethUsd))) / 10n ** 18n;
  return {
    priceUsd,
    marketCapUsd: (priceUsd * supply) / 10n ** 18n,
    readAt: Date.now(),
  };
}

/** The market, refreshed every 60 s; undefined until read, before launch, or while unreadable. A
 * failed read keeps the last good figure for three minutes, then shows none rather than an old one. */
export function useInferMarket(): InferMarket | undefined {
  const [m, setM] = useState<InferMarket>();
  useEffect(() => {
    if (!LIVE) return;
    let live = true;
    const tick = () =>
      readInferMarket()
        .then((x) => live && setM(x))
        .catch(
          () =>
            live &&
            setM((old) =>
              old && Date.now() - old.readAt < KEEP_MS ? old : undefined,
            ),
        );
    tick();
    const stop = everyVisible(tick, POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return m;
}

/** A USD price to four significant figures: "$8.498", "$0.01234", "$0.000004321". */
export function usdPrice(v: bigint): string {
  const n = Number(v) / 1e18;
  if (n === 0) return "$0";
  if (n >= 1000)
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${Number(n.toPrecision(4)).toString()}`;
}

/** A USD amount in short form: "$12.3K", "$4.56M", "$1.20B". */
export function usdCompact(v: bigint): string {
  const n = Number(v) / 1e18;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
