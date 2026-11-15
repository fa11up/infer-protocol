// What infer.imdusd.com/supply/* reports (worker/supply.js), for CoinGecko, CoinMarketCap and anyone else
// who asks: total supply from the token, and circulating supply as total minus the protocol's own holdings.
// Listing the addresses here also puts them in rpc-allow.json (vite.config.ts), so the Worker's reads pass
// /rpc's allowlist. worker/supply.js keeps the same list; tests/infer.test.mjs checks the two agree.
import type { Address } from "viem";

export type SupplyToken = {
  token: Address;
  decimals: number;
  /** Holders whose balance is not circulating: protocol contracts that haven't released it. */
  notCirculating: { holder: Address; label: string }[];
};

export const SUPPLY: Record<"imdusd" | "infer", SupplyToken> = {
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
