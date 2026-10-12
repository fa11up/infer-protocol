import { appRoot } from "./site";
import { onChain, setInterface } from "./names";
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
  const client = createPublicClient({
    chain,
    transport: fallback([
      ...own,
      ...config.network.rpcUrls.map((url) =>
        http(url, { timeout: 8000, retryCount: 0 }),
      ),
    ]),
    // Bundles only reads made in the same moment at the same block; a revert in one call still fails only
    // that read. batchSize is calldata bytes: 512 keeps a bundle under the Worker's 64 calls.
    batch: { multicall: { batchSize: 512, wait: 16 } },
  });
  return { config, abis, targets, chain, client };
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
 * `startBlock` / `endBlock` undefined = from the stablecoin's deployment / up to the latest block: the
 * season ends at the swarm's mainnet launch and our token launch, when `endBlock` is pinned here.
 * `lpLive` stays false until the pool exists and its LP reader is built: liquidity then earns nothing
 * here and the pane says so rather than showing a boost nobody can get.
 */
export const pointsConfig = {
  blocksPerDay: 7_200,
  lpBps: 30_000,
  liquidationCreditDays: 3,
  startBlock: undefined as number | undefined,
  endBlock: undefined as number | undefined,
  lpLive: false,
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
  chunkSize: 2000n,
  maxChunks: 10000,
  maxPages: 2000,
  overlap: 12n,
};
