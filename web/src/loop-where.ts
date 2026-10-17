// Where the leverage loop and the peg pool window exist, without the code that runs them (Loop.tsx, Liquidity.tsx and
// leverage.ts load when a window opens).
import type { Address } from "viem";
import type { Runtime } from "./config";
import type { Snapshot } from "./state";
import { collateral } from "./collateral.ts";

export const LOOP_CHAIN_ID = 1;
export const IMDUSD: Address = "0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25";
export const IMD: Address = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";

/** The loop exists only where its pools do: mainnet, sIMD collateral over IMD, the imdUSD the peg pool trades. */
export function loopAvailable(r: Runtime, s?: Snapshot) {
  const t = s?.targets;
  return (
    r.config.chainId === LOOP_CHAIN_ID &&
    collateral().share &&
    t?.stablecoin?.address.toLowerCase() === IMDUSD.toLowerCase() &&
    t?.underlying?.address.toLowerCase() === IMD.toLowerCase()
  );
}
