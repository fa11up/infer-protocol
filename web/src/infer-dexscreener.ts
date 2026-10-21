/** INFER's launch pool (INFER/IMD, Uniswap v4) on DexScreener. The pool, not the token: a stranger's
 * INFER/USDC pool exists, and a token link lets DexScreener pick which pair to show. Shared by imdusd.com (site.tsx)
 * and infer.imdusd.com's masthead ticker, in a module of its own so neither bundle pulls in the other's header. */
export const INFER_DEXSCREENER =
  "https://dexscreener.com/ethereum/0x1f03dd2c202cf17b58305b73ae2f8b3143e9c056ed9c9e8dbd4924b350431e95";
