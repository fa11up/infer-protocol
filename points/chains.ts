// Per-chain constants for points. Pool managers hold every v4 pool's tokens, so imdUSD sitting in
// one is the LPs', credited to them at the liquidity rate, never to the manager as a holding.
// Addresses from Identity-md/protocol packages/protocol/src/chains.ts (verified there).
export type PegPool = {
  id: string;
  /** Block the pool was initialised (where pool logs start). */
  fromBlock: number;
  /** v4 PositionManager whose positions are keyed by tokenId (the salt). */
  positionManager: string;
  /** Season 1 peg band in ticks, [lower, upper): $0.99005-$1.01005 for imdUSD(18)/USDC(6). */
  bandLower: number;
  bandUpper: number;
  /** token1 raw -> imdUSD-equivalent 1e18 units (USDC: 10^12). */
  token1Scale: bigint;
};

export const PEG_POOLS: Record<string, PegPool> = {
  ethereum: {
    id: "0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035",
    fromBlock: 26_167_383,
    positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
    bandLower: -276424,
    bandUpper: -276224,
    token1Scale: 10n ** 12n,
  },
};

export const CHAINS: Record<string, { chainId: number; blockscout: string; blocksPerDay: number; poolManager: string; pegPool?: string }> = {
  // pegPool: imdUSD/USDC (PegFeeHook), initialised at block 26,167,383; liquidity in it earns the LP rate (lp.ts).
  ethereum: { chainId: 1, blockscout: "eth.blockscout.com", blocksPerDay: 7_200, poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90", pegPool: "0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035" },
  sepolia: { chainId: 11155111, blockscout: "eth-sepolia.blockscout.com", blocksPerDay: 7_200, poolManager: "0xe03a1074c86cfedd5c142c4f04f1a1536e203543" },
};
