// The mainnet contracts imdusd.com/build/ lists for integrators. Every address here must appear on the docs' contracts
// page (content/docs/reference/contracts-and-addresses.md); tests/build-page.test.mjs holds the two together.
export type BuildContract = { name: string; address: string; role: string };

export const BUILD_CONTRACTS: BuildContract[] = [
  { name: "ParameterizedVault", address: "0x0b69F8DA8D8cE521d74Ea69a7A3475B77302EF82", role: "The vault: every position, and the only minter and burner of imdUSD" },
  { name: "ImdUSD", address: "0x61aAF8a992A3143e2B0C9cB0030b9fE702854a25", role: "The stablecoin (ERC-20, 18 decimals)" },
  { name: "PriceFeed", address: "0x070e0603737242B01aBC1D223f7C92D63E86EC97", role: "IMD/ETH over a block window, from swarm attestations" },
  { name: "SpotFeed", address: "0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951", role: "IMD/ETH at a window's last block" },
  { name: "NhiFeed", address: "0x014DabF6F940c9C383D9ef48636F70D842F65D7A", role: "The network health index" },
  { name: "SwarmRelay", address: "0x9AEb55c7A16C11B37DC96BD22a33906D1668e20B", role: "Delivers attestations to the feeds; open to anyone" },
  { name: "OracleAsker", address: "0x00856Bd495941f3b95dA5b7e374c76d822C9059E", role: "Buys price updates from the swarm with Treasury IMD" },
  { name: "Parameters", address: "0x3D96A6Ffada9C2E5B8fF8eb3f8AFB360116dA881", role: "Economic settings, behind a 48-hour timelock" },
  { name: "Treasury", address: "0x6Ac8fF96Fb8DCF5d79A8eF1E59D9AC23f2BD27Bc", role: "Fees, the redemption reserve and the oracle budget" },
  { name: "PegFeeHook", address: "0x33cA5c16208EC08aC97d4f6315aaFA792A916044", role: "The imdUSD/USDC peg pool's Uniswap v4 hook" },
  { name: "sIMD", address: "0x9Efa934D9fAd4AE28c998a40195646b965a97247", role: "The collateral: IdentityMD's staked IMD (24 decimals)" },
];

export const PEG_POOL_ID = "0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035";
