// Chain access for the INFER page: public reads over the configured RPCs, writes through the injected
// wallet. The ABIs are the few members the page uses, written out so they are reviewable here; the
// contracts are the reference implementations in fa11up/infer-token (SeasonVault, LegacyRedeemer,
// StakedInfer), which the swarm builds to the same interface.
import {
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  parseAbi,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { LAUNCH } from "./config";
import { createReadClient } from "../read-client";

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const SEASON_VAULT = parseAbi([
  "function SEASON() view returns (uint256)",
  "function SEASONS() view returns (uint256)",
  "function REGISTRATION() view returns (uint256)",
  "function opened() view returns (uint256)",
  "function endOf(uint256 s) view returns (uint256)",
  "function season(uint256 s) view returns ((uint64 start, uint64 rootSetAt, bool expired, uint256 pot, bytes32 formula, bytes32 root, uint256 total, uint256 registered, uint256 paid, bytes32 pendingRoot, uint256 pendingTotal, uint64 pendingEta))",
  "function entitlements(uint256 s, address account) view returns (uint256 amount, uint256 paid)",
  "function releasable(uint256 s, address account) view returns (uint256)",
  "function claim(uint256 s, address account, uint256 amount, bytes32[] proof) returns (uint256)",
  "function release(uint256 s, address account) returns (uint256)",
]);

export const LEGACY_REDEEMER = parseAbi([
  "function legacyA() view returns (address)",
  "function legacyB() view returns (address)",
  "function rateA() view returns (uint256)",
  "function rateB() view returns (uint256)",
  "function allocationA() view returns (uint256)",
  "function allocationB() view returns (uint256)",
  "function redeemed(address legacy) view returns (uint256)",
  "function closesAt() view returns (uint64)",
  "function redeem(address legacy, uint256 amount) returns (uint256)",
  "function advanceClock(address legacy, uint256 steps)",
]);

export const STAKED_INFER = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

export const chain = defineChain({
  id: LAUNCH.chainId,
  name: "Ethereum",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: LAUNCH.rpc } },
  // Multicall3 (same address on every chain), so the page's reads go out as one call per refresh.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", blockCreated: 14353601 } },
});

/**
 * The site's own RPC (worker/rpc.js: cached per block, keyed upstreams, an allowlist of our contracts) first,
 * then the public RPCs directly if it is unreachable (a local dev server has no /rpc).
 */
const OWN_RPC = typeof location !== "undefined" ? [new URL("/rpc", location.origin).href] : [];

// Only the read actions the pages call (../read-client.ts): createPublicClient would bring signature and typed-data
// verification and their curve libraries into every page's first load.
export const client = createReadClient({
  chain,
  batch: { multicall: true },
  transport: fallback(
    [...OWN_RPC, ...LAUNCH.rpc].map((url) => http(url, { timeout: 8000, retryCount: 0 })),
  ),
});

export const wallet = (p: EIP1193Provider) =>
  createWalletClient({ chain, transport: custom(p) });

export const DRIPPER = parseAbi([
  "function releasable() view returns (uint256)",
  "function lastDripAt() view returns (uint256)",
]);

/** The leaf file a season's Merkle root was built from: one entry per account, lowercase keys. */
export type LeafFile = {
  season: number;
  root: Hex;
  total: string;
  claims: Record<string, { amount: string; proof: Hex[] }>;
};

export async function leafFile(season: number): Promise<LeafFile | null> {
  const url = LAUNCH.claims.files[season];
  if (!url) return null;
  const r = await fetch(url);
  if (!r.ok)
    throw Error(
      `Could not load the season ${season + 1} claim file (HTTP ${r.status}).`,
    );
  const file = (await r.json()) as LeafFile;
  if (file.season !== season || typeof file.claims !== "object")
    throw Error("The claim file does not match this season.");
  return file;
}

export function message(e: unknown): string {
  const m =
    (e as { shortMessage?: string; message?: string })?.shortMessage ??
    (e as { message?: string })?.message ??
    String(e);
  return m.length > 240 ? `${m.slice(0, 240)}…` : m;
}
