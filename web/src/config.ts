import { appRoot } from "./site";
import { onChain, setInterface } from "./names";
import archiveRpcs from "./archive-rpc.json";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type EIP1193Provider,
} from "viem";
export type Deployment = {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: {
    name: string;
    address: Address;
    abiHash: string;
    abiPath: string;
  }[];
  assets: { path: string; sha256: string }[];
  network: {
    chainId: number;
    name: string;
    rpcUrls: string[];
    explorer: string;
    testnet?: boolean;
    nativeCurrency: { name: string; symbol: string; decimals: number };
  };
  walletAddChain?: object;
  /** Which names the deployed contracts use; see names.ts. Absent means "maker". */
  interface?: "maker" | "legacy";
  /**
   * The protocol's OracleAsker and the exact oracle.request body each feed's pinned question needs,
   * as hex. Absent until IdentityMD's on-chain Intake is live: the terminal then shows "Buy update"
   * disabled. Each body is checked against the hash the asker itself pins before anything is sent.
   */
  oracleAsker?: { address: Address; requests: Record<string, `0x${string}`> };
};
export type Target = { address: Address; abi: Abi };
/** Multicall3 (same address everywhere): the block it was created in, per chain the terminal runs on. */
const MULTICALL3_CREATED: Record<number, number> = { 1: 14_353_601, 11155111: 751_532 };
/** Hosts whose Worker serves /rpc for the mainnet deployment (worker/index.js). */
const OWN_RPC_HOSTS = ["imdusd.com"];
function sort(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, sort(x)]),
        )
      : v;
}
export async function loadConfig() {
  const get = async (path: string) => {
    const r = await fetch(new URL(path, appRoot()));
    if (!r.ok) throw Error(`Unable to load ${path}. Reload the terminal.`);
    return r;
  };
  const config = (await (
    await get("imd-deployment.json")
  ).json()) as Deployment;
  if (
    config.version !== 1 ||
    !config.network ||
    config.chainId !== config.network.chainId ||
    !config.contracts.length
  )
    throw Error(
      "Deployment configuration is incomplete. Transactions are disabled.",
    );
  setInterface(config.interface);
  if (
    config.oracleAsker &&
    (!/^0x[0-9a-fA-F]{40}$/.test(config.oracleAsker.address) ||
      Object.values(config.oracleAsker.requests ?? {}).some(
        (b) => !/^0x(?:[0-9a-fA-F]{2})+$/.test(b),
      ))
  )
    throw Error("Deployment oracle settings are malformed.");
  const abis: Record<string, Abi> = {};
  const targets: Record<string, Target> = {};
  const loadAbi = async (path: string) => {
    if (!/^abi\/[A-Za-z0-9]+\.json$/.test(path))
      throw Error("Invalid ABI path.");
    const asset = config.assets.find((x) => x.path === path);
    if (!asset) throw Error("ABI is missing from the asset inventory.");
    const bytes = await (await get(path)).arrayBuffer();
    const sha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (sha !== asset.sha256) throw Error("ABI asset integrity check failed.");
    const a = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(a)) throw Error("Invalid ABI array.");
    return a as Abi;
  };
  await Promise.all(
    config.contracts.map(async (c) => {
      const abi = await loadAbi(c.abiPath);
      if (keccak256(toBytes(JSON.stringify(sort(abi)))).slice(2) !== c.abiHash)
        throw Error(`ABI binding failed: ${c.name}`);
      abis[c.name] = abi;
      targets[c.name] = { address: c.address, abi };
    }),
  );
  await Promise.all(
    [
      "ImdUSD",
      "MockIMD",
      "Parameters",
      "Treasury",
      "UsdPriceFeed",
      "MockWorkOracle",
      "SwarmWorkOracle",
    ].map(async (n) => (abis[n] = await loadAbi(`abi/${onChain(n)}.json`))),
  );
  const chain = defineChain({
    id: config.chainId,
    name: config.network.name,
    nativeCurrency: config.network.nativeCurrency,
    rpcUrls: { default: { http: config.network.rpcUrls } },
    // Without it viem cannot bundle reads into Multicall3 and silently sends each one alone.
    ...(MULTICALL3_CREATED[config.chainId] !== undefined && {
      contracts: {
        multicall3: {
          address: "0xcA11bde05977b3631167028862bE2a173976CA11",
          blockCreated: MULTICALL3_CREATED[config.chainId],
        },
      },
    }),
  });
  // On imdusd.com the terminal reads through the site's own RPC first (worker/rpc.js: one upstream call per
  // block however many visitors, keyed providers, the deployment's contracts only), then the public RPCs
  // directly if it is unreachable. JSON-RPC batches (at most 20 calls, the Worker's limit) and Multicall3
  // bundles keep a refresh to a few requests: one browser's unbundled reads were throttled by publicnode
  // (HTTP 403) and would exceed /rpc's per-visitor limits.
  const own =
    config.chainId === 1 && OWN_RPC_HOSTS.includes(location.hostname)
      ? [
          http(new URL("/rpc", location.origin).href, {
            timeout: 8000,
            retryCount: 0,
            batch: { batchSize: 20, wait: 16 },
          }),
        ]
      : [];
  // Old ranges have their own clients. eth_getLogs (every history window reaches 2,000+ blocks back, past what
  // non-archive nodes serve): on imdusd.com /rpc first (its keyed providers, closed windows cached for everyone), then
  // the keyless archive gateways (archive-rpc.json), then the deployment's RPCs that serve old log ranges, skipping
  // the ones known to refuse them; history.ts falls back to Blockscout after that. State at a past block (`archive`):
  // /rpc, the gateways, then every deployment RPC. Off imdusd.com (local dev, previews) the same without /rpc. Reads
  // at the head keep `client` below.
  const ownOld = own.length ? [new URL("/rpc", location.origin).href] : [];
  const gateways: string[] = (archiveRpcs as Record<string, string[]>)[String(config.chainId)] ?? [];
  const serveOld = config.network.rpcUrls.filter((url) => !historyConfig.noArchiveLogs.includes(new URL(url).hostname));
  const old = (urls: string[]) => fallback([...new Set(urls)].map((url) => http(url, { timeout: 15000, retryCount: 0 })));
  const logs = createPublicClient({ chain, transport: old([...ownOld, ...gateways, ...serveOld]) });
  const archive = createPublicClient({ chain, transport: old([...ownOld, ...gateways, ...config.network.rpcUrls]) });
  const client = createPublicClient({
    chain,
    transport: fallback([
      ...own,
      ...config.network.rpcUrls.map((url) =>
        http(url, { timeout: 8000, retryCount: 0 }),
      ),
    ]),
    // Bundles only reads made in the same moment at the same block; a revert in one call still fails only
    // that read. batchSize is calldata bytes and the smallest read is 4 (a bare selector): 256 keeps even a bundle of
    // those at the Worker's 64 calls (512 let 128 through once the snapshot read everything at once).
    batch: { multicall: { batchSize: 256, wait: 16 } },
  });
  return { config, abis, targets, chain, client, logs, archive };
}
export type Runtime = Awaited<ReturnType<typeof loadConfig>>;
export function wallet(r: Runtime, p: EIP1193Provider) {
  return createWalletClient({ chain: r.chain, transport: custom(p) });
}
export async function switchChain(r: Runtime, p: EIP1193Provider) {
  const chainId = `0x${r.config.chainId.toString(16)}`;
  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (
      err.code !== 4902 &&
      !/unknown chain|unrecognized chain|not added/i.test(err.message || "")
    )
      throw e;
    if (!r.config.walletAddChain)
      throw Error("This network has no wallet setup configuration.");
    await p.request({
      method: "wallet_addEthereumChain",
      params: [r.config.walletAddChain as never],
    });
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  }
}
declare global {
  interface Window {
    ethereum?: EIP1193Provider & {
      on?: (event: string, listener: (arg: unknown) => void) => void;
      removeListener?: (
        event: string,
        listener: (arg: unknown) => void,
      ) => void;
    };
  }
}

// Public history service and bounded browser read policy; no indexer is operated by this app.
/**
 * Genesis points (points/engine.ts). 1 point = 1 imdUSD held for 1 day (7,200 blocks); liquidity in the
 * imdUSD/USDC pool earns `lpBps`/10000 x; liquidators earn debt repaid x `liquidationCreditDays`.
 * `startBlock` / `endBlock` undefined = from the stablecoin's deployment / up to the latest block (still counting
 * after INFER's launch, user 2026-10-12); pin `endBlock` here to close it. Liquidity is read from the peg pool's
 * ModifyLiquidity transactions (points/lp.ts) on chains listed in `pegPools`.
 */
export const pointsConfig = {
  blocksPerDay: 7_200,
  lpBps: 30_000,
  liquidationCreditDays: 3,
  startBlock: undefined as number | undefined,
  /** Points stop accruing at this block (none while preseason runs; set when Season 1 opens). A freeze at
   * 26206625 (16 Oct 2026 17:34 UTC) was lifted the same day: preseason resumed with no gap. */
  // The preseason's last block: Season 1 was opened here (Safe tx 0x3267a5ad…4664, 2026-10-17 00:03:11 UTC), and
  // rules/season-1.md section 3 ends the preseason at the block openSeason executed in. Pinned so the pane needs no
  // explorer to find it.
  endBlock: 26_208_562 as number | undefined,
  /** When endBlock was mined, for the pane. */
  endedAt: "17 Oct 2026 00:03 UTC" as string | undefined,
  /** Season 1 has not opened: the pane says points so far count towards a capped preseason distribution. */
  preseason: true,
  /**
   * The imdUSD/USDC peg pool per chain: liquidity in it earns `lpBps` (points/lp.ts reads its ModifyLiquidity
   * transactions from `fromBlock`, the block it was initialised in). A chain without one shows no LP rate.
   */
  pegPools: {
    1: {
      poolId: "0x3cb8cc9c22f7da5c3169d4059131ddba9e61f68230977797c03a2f1214992035",
      fromBlock: 26_167_383,
      // Season 1's liquidity reader (points/season1.ts), used from `lpSwitchBlock`: positions are keyed by the
      // PositionManager's tokenId; depth counts inside the peg band [$0.99005, $1.01005) in ticks.
      positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
      bandLower: -276424,
      bandUpper: -276224,
      token1Scale: 10n ** 12n,
    },
  } as Record<
    number,
    { poolId: `0x${string}`; fromBlock: number; positionManager?: string; bandLower?: number; bandUpper?: number; token1Scale?: bigint }
  >,
  /**
   * From this block, liquidity earns by Season 1's reader (depth at the peg, only while in range and at peg,
   * one-day hold) instead of imdUSD deposited x lpBps (user, 2026-10-16, after ~48k borrowed imdUSD was parked
   * above a pushed-down price). 26,206,625 is where the preseason was first frozen. Holding is unchanged.
   */
  lpSwitchBlock: 26_206_625 as number | undefined,
  /** INFER's SeasonVault per chain: Season 1 (index 0) as opened there (src/season.ts). A chain without one shows
   * the preseason only. */
  seasonVaults: { 1: "0x08DC1b5789Aa4951daC6022f2141C646c7F6F9f4" } as Record<number, string>,
  /** The preseason's share of the Season 1 pot (rules/season-1.md section 4); Season 1 points share the rest. */
  preseasonShareBps: 500,
  /** Uniswap v4 PoolManager per chain: the pool's imdUSD is its LPs', never a holding of the manager. */
  poolManagers: {
    1: "0x000000000004444c5dc75cb358380d2e3de08a90",
    11155111: "0xe03a1074c86cfedd5c142c4f04f1a1536e203543",
  } as Record<number, string>,
  /** Any other protocol contract that holds imdUSD. The vault and Treasury are added automatically. */
  excluded: [] as string[],
};

export const historyConfig = {
  /** Blockscout's v2 API per chain: the log fallback when an RPC refuses or silently empties a range. */
  blockscoutApis: {
    1: "https://eth.blockscout.com/api/v2/",
    11155111: "https://eth-sepolia.blockscout.com/api/v2/",
  } as Record<number, string>,
  /**
   * Per deployment (launchId): a block no earlier than which none of its contracts emitted anything, so history
   * starts there instead of binary-searching each contract's deployment block (~25 archive eth_getCode calls per
   * contract on every page load). Mainnet: the first stage-one block (26165887, SwarmRelay, unchanged since);
   * every contract the terminal reads was deployed at or after it.
   */
  historyFloor: { "imdusd-mainnet-26166417": 26165887n } as Record<string, bigint>,
  /**
   * eth_getLogs windows, aligned to multiples of this so closed ones are cache-identical across visitors (/rpc keeps
   * a window wholly 64 blocks below the head for 30 days, keyed by the request body). One request names every
   * history contract (history.ts historyGroup). /rpc allows spans under 10,000 (worker/rpc.js MAX_LOG_SPAN), but
   * 5,000 is the largest every viable archive endpoint accepts (Pocket caps getLogs at 5,000 blocks; Infura and MEV
   * Blocker cap results at 10,000 logs; the history contracts emit ~25 logs per 1,000 blocks). Measured 2026-10-17:
   * MEV Blocker answers multi-address ranges up to 10,000 blocks; publicnode (403 without a token), dRPC's free plan
   * (400) and Blast (10 blocks) refuse old ranges whatever the span.
   */
  windowSize: 5000n,
  /** The open window (up to the head) reaches back at least this far, so it is rarely empty (an empty answer is
   * unverified and sends the read to Blockscout). */
  tailSize: 2000n,
  /** Public RPCs that refuse eth_getLogs over old ranges (above): the log client skips them, so a window /rpc could
   * not serve goes to a provider that can, or to Blockscout, instead of being walked through each refusal. */
  noArchiveLogs: ["ethereum-rpc.publicnode.com", "eth.drpc.org", "eth-mainnet.public.blastapi.io"],
  /** Log reads at once, per runtime (history.ts limited()). */
  parallel: 6,
  maxChunks: 10000,
  maxPages: 2000,
  overlap: 12n,
};
