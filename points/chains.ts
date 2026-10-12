// Per-chain constants for points. Pool managers hold every v4 pool's tokens, so imdUSD sitting in
// one is the LPs', credited to them at the liquidity rate, never to the manager as a holding.
// Addresses from Identity-md/protocol packages/protocol/src/chains.ts (verified there).
export const CHAINS: Record<string, { chainId: number; blockscout: string; blocksPerDay: number; poolManager: string; pegPool?: string }> = {
  // pegPool: imdUSD/USDC (PegFeeHook), initialised at block 26,167,383; liquidity in it earns the LP rate (lp.ts).
  ethereum: { chainId: 1, blockscout: "eth.blockscout.com", blocksPerDay: 7_200, poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90", pegPool: "0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035" },
  sepolia: { chainId: 11155111, blockscout: "eth-sepolia.blockscout.com", blocksPerDay: 7_200, poolManager: "0xe03a1074c86cfedd5c142c4f04f1a1536e203543" },
};
