import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeEventTopics,
  encodeAbiParameters,
  encodeFunctionResult,
  encodeErrorResult,
  parseEther,
  zeroAddress,
  maxUint256,
  parseAbi,
  parseAbiParameters,
  keccak256,
} from "viem";
// The mocked suite's own deployment: the Sepolia test deployment (legacy names, faucet work oracle) and its ABIs,
// kept in tests/fixture-deployment so the suite does not follow web/deployment-source.json, which is mainnet's
// since 5ba2182. tests/browser.mjs serves these in place of the build's imd-deployment.json and abi/.
export const fixtureDeploymentDir = new URL("./fixture-deployment/", import.meta.url);
export const config = JSON.parse(
  readFileSync(new URL("deployment-source.json", fixtureDeploymentDir)),
);
export const abi = Object.fromEntries(
  [
    "ParameterizedVault",
    "PriceFeed",
    "NhiFeed",
    "SpotFeed",
    "CompToken",
    "MockIMD",
    "Parameters",
    "Treasury",
    "UsdPriceFeed",
    "SwarmWorkOracle",
    "MockWorkOracle",
  ].map((n) => [
    n,
    JSON.parse(
      readFileSync(new URL(`abi/${n}.json`, fixtureDeploymentDir)),
    ),
  ]),
);
// Views newer than the pinned ABIs; the app reads them through inline fragments.
const optional = parseAbi([
  "function backingPerComp() view returns (uint256)",
  "function expectedQuestionHash(uint64 fromBlock, uint64 toBlock) pure returns (bytes32)",
  "function lastToBlock() view returns (uint64)",
]);
for (const n of ["ParameterizedVault", "PriceFeed", "NhiFeed", "SpotFeed"])
  abi[n] = [...abi[n], ...optional];
// sIMD collateral (share mode): the collateral token is an ERC-4626 share of IMD with 24 decimals,
// and the vault prices it through its own collateralPriceFeed. Off by default (launch 688 is plain IMD).
abi.ShareToken = [
  ...abi.MockIMD,
  ...parseAbi([
    "function asset() view returns (address)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  ]),
];
abi.ParameterizedVault = [
  ...abi.ParameterizedVault,
  ...parseAbi([
    "function collateralPriceFeed() view returns (address)",
    "function lockIMD(uint256 assets)",
  ]),
];
// The protocol's OracleAsker (asker mode): price, pay token, pinned request hashes, ask (Treasury-paid), askPaid.
abi.asker = parseAbi([
  "function price() view returns (uint256)",
  "function payToken() view returns (address)",
  "function feeds(address) view returns (bytes32 bodyHash, bool tracksPool, bool keepAlive, uint64 lastAsk, uint64 armedAt, uint64 inFlightAt, bool treasuryPaid, bytes32 inFlight)",
  "function ask(address feed, bytes body) returns (bytes32)",
  "function askPaid(address feed, bytes body, uint256 maxPrice) returns (bytes32)",
  "function askPaidMany(address[] feeds, bytes[] bodies, uint256 maxPriceEach) returns (bytes32[])",
]);
/** The request body the fixture's asker pins for every feed, and the price of one update. */
export const askerBody = "0x7b2271223a2270726963652d756e6976342d7633227d";
export const askerPrice = 5n * 10n ** 17n;
/** IMD raw units per 1e18 raw sIMD units: one whole sIMD (1e24) is worth 1.25 IMD. */
export const RATE = 125n * 10n ** 10n;
export const account = "0x0000000000000000000000000000000000000a11";
export const candidate = "0x0000000000000000000000000000000000000b22";
export const addresses = {
  ...Object.fromEntries(config.contracts.map((c) => [c.name, c.address])),
  imdToken: "0x0000000000000000000000000000000000000011",
  compToken: "0x0000000000000000000000000000000000000012",
  parameters: "0x0000000000000000000000000000000000000013",
  treasury: "0x0000000000000000000000000000000000000014",
  usdPriceFeed: "0x0000000000000000000000000000000000000015",
  oracle: "0x0000000000000000000000000000000000000016",
  underlying: "0x0000000000000000000000000000000000000017",
  collateralPriceFeed: "0x0000000000000000000000000000000000000018",
  asker: "0x0000000000000000000000000000000000000019",
  payToken: "0x0000000000000000000000000000000000000020",
};
const W = 10n ** 18n;
export const txHash = "0x" + "ab".repeat(32);
const blockHash = "0x" + "cd".repeat(32);
export const fixture = () => ({
  minCR: 150n,
  workCeiling: 1250n * W,
  maxDivergenceBps: 2000n,
  spotMultiplier: 1,
  priceMultiplier: 1,
  logMode: "rpc",
  explorerEmpty: false,
  ownerReadFail: false,
  extraPoint: false,
  logsRequested: [],
  reserve: 100n * W,
  supply: 10000n * W,
  allowance: 0n,
  stale: false,
  mode: "faucet",
  rejectSimulation: false,
  // Undefined models the live deployment, whose vault and feeds predate these views.
  backing: undefined,
  pinned: false,
  governor: account,
  candidateCR: 180n,
  // Only marked owners carry an active liquidation mark; ratio overrides by address.
  marked: [candidate],
  crs: {},
  /** Extra borrowers for the demo's loan book (0 in the tests): ratios clustered near the minimum. */
  crowd: 0,
  consistent: false,
  rpcFail: false,
  codeMissing: false,
  chainMismatch: false,
  sent: [],
  calls: [],
  now: BigInt(Math.floor(Date.now() / 1000)),
  pendingKind: 4, // Redemption spread (the change kinds start at Economics = 0)
  pendingEta: 1n,
  /** The encoded pending payload, as Parameters stores it; by default a spread change to 60. */
  pendingPayload: undefined,
  share: false,
  underlyingAllowance: 0n,
  askerAllowance: 0n,
  /** Whether the asker's `ask` (Treasury-paid) passes for every feed; by default it reverts NotNeeded. */
  askerFree: false,
  /** IMD the asker itself holds (the Oracle pane offers a top-up below 2 IMD). */
  askerHeld: 35n * 10n ** 17n,
});
export const block = (s) => ({
  number: "0x100",
  hash: blockHash,
  parentHash: "0x" + "00".repeat(32),
  nonce: "0x0000000000000000",
  sha3Uncles: blockHash,
  logsBloom: "0x" + "00".repeat(256),
  transactionsRoot: blockHash,
  stateRoot: blockHash,
  receiptsRoot: blockHash,
  miner: zeroAddress,
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x200",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  timestamp: "0x" + s.now.toString(16),
  transactions: [],
  uncles: [],
  baseFeePerGas: "0x1",
});
const byAddr = Object.fromEntries(
  Object.entries(addresses).map(([k, v]) => [v.toLowerCase(), k]),
);
const abiName = {
  imdToken: "ShareToken",
  underlying: "MockIMD",
  payToken: "MockIMD",
  collateralPriceFeed: "UsdPriceFeed",
  compToken: "CompToken",
  parameters: "Parameters",
  treasury: "Treasury",
  usdPriceFeed: "UsdPriceFeed",
  oracle: "SwarmWorkOracle",
};
// Multicall3, as the terminal bundles its reads (src/config.ts): each inner call is answered by `call` like a
// direct eth_call, and a revert in one fails only that one, as on chain.
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const multicallAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
function call(s, params) {
  if (params[0].to.toLowerCase() === MULTICALL3) {
    const { args } = decodeFunctionData({ abi: multicallAbi, data: params[0].data });
    const results = args[0].map((c) => {
      try {
        return { success: true, returnData: call(s, [{ ...params[0], to: c.target, data: c.callData }, ...params.slice(1)]) };
      } catch (e) {
        if (!c.allowFailure) throw e;
        return { success: false, returnData: e.data ?? "0x" };
      }
    });
    return encodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", result: results });
  }
  const tx = params[0],
    name = byAddr[tx.to.toLowerCase()];
  if (!name) throw Error("Unknown target " + tx.to);
  let a = abi[abiName[name] || name],
    decoded;
  try {
    decoded = decodeFunctionData({ abi: a, data: tx.data });
  } catch (e) {
    if (name === "oracle") {
      a = abi.MockWorkOracle;
      decoded = decodeFunctionData({ abi: a, data: tx.data });
    } else throw e;
  }
  const { functionName: f, args = [] } = decoded;
  s.calls.push({ name, fn: f, args });
  if (
    s.collateralFeedFail &&
    name === "ParameterizedVault" &&
    f === "collateralPriceFeed"
  )
    throw Error("execution reverted");
  // Plain-IMD collateral answers none of the share members.
  if (
    !s.share &&
    ((name === "imdToken" &&
      ["asset", "convertToAssets", "redeem"].includes(f)) ||
      (name === "ParameterizedVault" &&
        ["collateralPriceFeed", "lockIMD"].includes(f)) ||
      name === "underlying" ||
      name === "collateralPriceFeed")
  )
    throw Error("execution reverted");
  const fn = a.find((x) => x.type === "function" && x.name === f);
  if (
    name === "oracle" &&
    s.mode === "faucet" &&
    ![
      "vault",
      "deployer",
      "mintingRights",
      "grantRights",
      "consumeRights",
    ].includes(f)
  )
    throw Error("Unsupported function");
  let value;
  if (
    f === "backingPerComp" ||
    f === "expectedQuestionHash" ||
    f === "lastToBlock"
  ) {
    if (f === "backingPerComp" ? s.backing === undefined : !s.pinned)
      throw Error("execution reverted");
    value =
      f === "backingPerComp"
        ? s.backing
        : f === "lastToBlock"
          ? 26121526n
          : "0x" + "2b".repeat(32);
    return encodeFunctionResult({ abi: a, functionName: f, result: value });
  }
  if (name === "asker") {
    if (f === "ask" && !s.askerFree) throw Error("execution reverted");
    value =
      f === "price"
        ? askerPrice
        : f === "payToken"
          ? addresses.payToken
          : f === "feeds"
            ? [
                keccak256(askerBody),
                true,
                false,
                0n,
                0n,
                0n,
                false, // treasuryPaid
                "0x" + "00".repeat(32),
              ]
            : f === "askPaidMany"
              ? ["0x" + "11".repeat(32), "0x" + "12".repeat(32)]
              : "0x" + "11".repeat(32);
    return encodeFunctionResult({ abi: a, functionName: f, result: value });
  }
  if (fn.stateMutability === "nonpayable") {
    if (s.rejectSimulation) {
      const error = new Error("execution reverted");
      error.data = encodeErrorResult({
        abi: abi.ParameterizedVault,
        errorName: "RedemptionWorsensRatio",
      });
      throw error;
    }
    if (f === "redeem")
      value = (args[0] * (10000n - fee(s, args[0])) * 10n ** 14n) / (2n * W);
    else if (f === "approve" || f === "transfer") value = true;
    else if (f === "sync") value = 0n;
  } else if (name === "ParameterizedVault") {
    const scalar = {
      minCR: s.minCR,
      redemptionCeilingCR: s.minCR + 50n,
      redemptionSpread: 50n,
      redemptionReserve: s.reserve,
      REDEMPTION_FEE_FLOOR_BPS: 50n,
      REDEMPTION_FEE_CAP_BPS: 500n,
      totalDebt: s.supply - 20n * W,
      totalBadDebt: 0n,
      totalWorkMinted: 20n * W,
      totalNonPrincipalRedeemed: 0n,
      workCeiling: s.workCeiling,
      workRatioBps: 2500n,
      reserveValue: 1000n * W,
      securedCollateral: 1000n * W,
      backedDebt: 1000n * W,
      debtCeiling: 1000000n * W,
      stabilityFeeBps: 200n,
      maxDivergenceBps: s.maxDivergenceBps,
      gracePeriod: s.lull ?? 21600n,
      liquidationWindow: 3600n,
      stabilityFeeOf: W,
      badDebtOf: 0n,
      debtOf: 1000n * W,
    };
    if (f in addresses) value = addresses[f];
    else if (f === "priceFeed") value = addresses.PriceFeed;
    else if (f === "nhiFeed") value = addresses.NhiFeed;
    else if (f === "spotFeed") value = addresses.SpotFeed;
    else if (f === "redemptionFeeBps") value = fee(s, args[0]);
    else if (f === "collateralRatio") value = crOf(s, args[0]);
    else if (f === "positions") {
      if (s.ownerReadFail && args[0].toLowerCase() === extraOwner.toLowerCase())
        throw Error("Position read unavailable");
      const k = crowdIndex(args[0].toLowerCase());
      const debt =
        s.crowd && k >= 0 && k < s.crowd
          ? BigInt(40 + ((k * 389) % 1460)) * W
          : args[0].toLowerCase() === closedOwner.toLowerCase()
          ? 0n
          : args[0].toLowerCase() === extraOwner.toLowerCase()
            ? 250n * W
            : 1000n * W;
      // The demo derives collateral from the ratio, so ratio, collateral and liquidation price agree.
      // The tests keep the fixed 1,000 IMD their arithmetic was written against.
      value =
        debt === 0n
          ? [100n * W, 0n]
          : [
              s.consistent
                ? (debt * crOf(s, args[0]) * 10n ** 16n) / (2n * W)
                : 1000n * W,
              debt,
            ];
    } else if (f === "liquidationMarks")
      value = s.marked.some((a) => a.toLowerCase() === args[0].toLowerCase())
        ? [s.now - 22000n, 21600n, true, account]
        : [0n, 0n, false, zeroAddress];
    else value = scalar[f];
    // Share mode: collateral amounts are raw sIMD, worth RATE IMD per 1e18.
    if (s.share && f === "positions") value = [(value[0] * W) / RATE, value[1]];
    if (s.share && ["redemptionReserve", "securedCollateral"].includes(f))
      value = (value * W) / RATE;
  } else if (
    ["imdToken", "compToken", "underlying", "payToken"].includes(name)
  ) {
    const shareToken = s.share && name === "imdToken";
    value = {
      deployer: account,
      decimals: shareToken ? 24 : 18,
      // The deployed Sepolia token still carries the testnet symbol; the terminal reads it.
      symbol: name === "compToken" ? "COMP" : shareToken ? "sIMD" : "IMD",
      balanceOf: shareToken
        ? 8000n * 10n ** 24n
        : name === "payToken" && String(args[0]).toLowerCase() === addresses.asker
          ? s.askerHeld
          : 10000n * W,
      allowance:
        name === "underlying"
          ? s.underlyingAllowance
          : name === "payToken"
            ? s.askerAllowance
            : s.allowance,
      totalSupply: s.supply,
      vault: addresses.ParameterizedVault,
      asset: addresses.underlying,
    }[f];
    if (f === "convertToAssets") value = (args[0] * RATE) / W;
  } else if (name === "parameters") {
    const current = {
      debtCeiling: 1000000n * W,
      protocolBonusShareBps: 1000n,
      stabilityFeeBps: 200n,
      maxDivergenceBps: s.maxDivergenceBps,
      markerShareBps: 1000n,
    };
    value = {
      vault: addresses.ParameterizedVault,
      governor: s.governor,
      TIMELOCK: 172800n,
      pendingChange: [s.pendingKind, s.pendingEta],
      current,
      compPerTaskWad: W / 10n,
      pendingRedemptionSpread: [50n, s.pendingEta],
      pendingWorkRatio: [2500n, 0n],
      pendingReserveAsset: [zeroAddress, zeroAddress, 0n, 0n],
      pendingSet: [current, 0n],
      pending: !s.pendingEta
        ? "0x"
        : (s.pendingPayload ??
          encodeAbiParameters(parseAbiParameters("uint8, uint256"), [s.pendingKind, 60n])),
    }[f];
  } else if (name === "treasury")
    value = {
      vault: addresses.ParameterizedVault,
      reserveAssets: [addresses.imdToken],
      withdrawer: account,
    }[f];
  else if (name === "oracle")
    value = {
      vault: addresses.ParameterizedVault,
      deployer: account,
      mintingRights: 980n * W,
      attestedTasks: 10000n,
      creditedTasks: 9000n,
      earnedRights: 1000n * W,
      consumedRights: 20n * W,
      compPerTaskWad: W / 10n,
      CLAIMANT: account,
      AGENT_ID: 51450n,
      latestValue: [10000n, s.now - 3600n],
      isStale: s.stale,
      maxAge: 86400n,
    }[f];
  else
    value = {
      latestValue: [
        name === "usdPriceFeed"
          ? 2n * W
          : name === "collateralPriceFeed"
            ? (2n * W * RATE) / W
            : name === "NhiFeed"
              ? (85n * W) / 100n
              : name === "SpotFeed"
                ? BigInt(Math.round(1e15 * s.spotMultiplier))
                : W / 1000n,
        s.now - 120n,
      ],
      isStale: s.stale,
      maxAge: 86400n,
      isReporter: true,
    }[f];
  if (value === undefined && fn.outputs.length)
    throw Error(`Missing fixture ${name}.${f}`);
  return encodeFunctionResult({ abi: a, functionName: f, result: value });
}
function fee(s, amount) {
  const base = (amount * W) / s.supply / 4n;
  const capped = base > 450n * 10n ** 14n ? 450n * 10n ** 14n : base;
  return 50n + (capped + 10n ** 14n - 1n) / 10n ** 14n;
}
/** The demo's crowd: deterministic owners, ratios mostly 150–230% with a tail, debts 40–1,500. Each
 * address looks like a real one (a deterministic scramble of its index) and ends in its index, which
 * `crowdIndex` reads back, so searching the book by address finds something. */
export const crowdOwner = (i) => {
  let x = (i + 1) * 2654435761 >>> 0, hex = "";
  for (let k = 0; k < 34; k++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    hex += (x >>> 28).toString(16);
  }
  return `0x${hex}${(0xd000 + i).toString(16).padStart(6, "0")}`;
};
function crowdIndex(owner) {
  const n = parseInt(owner.slice(-6), 16) - 0xd000;
  return n >= 0 && n < 10000 ? n : -1;
}
function crowdCr(i) {
  const a = ((i * 7919) % 101) / 100, b = ((i * 104729) % 97) / 96;
  return BigInt(Math.round(150 + a * b * 160 + (i % 9 === 0 ? 40 : 0)));
}
function crOf(s, owner) {
  const o = owner.toLowerCase();
  if (s.crs[o] !== undefined) return s.crs[o];
  const k = crowdIndex(o);
  if (s.crowd && k >= 0 && k < s.crowd) return crowdCr(k);
  if (o === candidate.toLowerCase()) return s.candidateCR;
  return BigInt(
    Math.round(
      (o === extraOwner.toLowerCase() ? 260 : 175) * s.priceMultiplier,
    ),
  );
}
export function rpc(s, body) {
  try {
    if (s.rpcFail) throw Error("Fixture RPC unavailable");
    let result;
    switch (body.method) {
      case "eth_chainId":
        result = s.chainMismatch ? "0x1" : "0xaa36a7";
        break;
      case "eth_getLogs": {
        s.logsRequested.push(body.params[0]);
        const p = body.params[0];
        result =
          s.logMode === "rpc"
            ? fixtureLogs(s, p.address).filter(
                (l) =>
                  BigInt(l.blockNumber) >= BigInt(p.fromBlock) &&
                  BigInt(l.blockNumber) <= BigInt(p.toBlock),
              )
            : [];
        break;
      }
      case "eth_getCode":
        result =
          s.codeMissing ||
          (body.params[1] !== "latest" && BigInt(body.params[1]) < 16n)
            ? "0x"
            : "0x6001600055";
        break;
      case "eth_blockNumber":
        result = "0x100";
        break;
      case "eth_getBlockByNumber":
        result = block(s);
        break;
      case "eth_call":
        result = call(s, body.params);
        break;
      case "eth_getTransactionReceipt":
        result = {
          transactionHash: txHash,
          transactionIndex: "0x0",
          blockHash,
          blockNumber: "0x100",
          from: account,
          to: addresses.ParameterizedVault,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          contractAddress: null,
          logs: [],
          logsBloom: "0x" + "00".repeat(256),
          status: "0x1",
          effectiveGasPrice: "0x1",
          type: "0x2",
        };
        break;
      default:
        throw Error("Unmocked RPC " + body.method);
    }
    return { jsonrpc: "2.0", id: body.id, result };
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32000, message: e.message, data: e.data },
    };
  }
}
export function sent(s, tx) {
  const name = byAddr[tx.to.toLowerCase()];
  const a = abi[abiName[name] || name];
  const d = decodeFunctionData({ abi: a, data: tx.data });
  s.sent.push({ name, ...d });
  if (d.functionName === "approve") {
    if (name === "underlying") s.underlyingAllowance = d.args[1];
    else if (name === "payToken") s.askerAllowance = d.args[1];
    else s.allowance = d.args[1];
  }
  return txHash;
}
export async function installWallet(
  page,
  { chain = "0x1", reject = false, atomic = false } = {},
) {
  await page.addInitScript(
    ({ account, chain, reject, atomic }) => {
      const listeners = {};
      window.__wallet = {
        chain,
        connected: false,
        added: false,
        reject,
        requests: [],
      };
      window.ethereum = {
        on: (n, cb) => {
          listeners[n] = cb;
        },
        removeListener: (n) => {
          delete listeners[n];
        },
        request: async ({ method, params }) => {
          const w = window.__wallet;
          w.requests.push({ method, params });
          if (method === "eth_accounts") return w.connected ? [account] : [];
          if (method === "eth_requestAccounts") {
            if (w.reject) throw { code: 4001, message: "User rejected" };
            w.connected = true;
            return [account];
          }
          if (method === "eth_chainId") return w.chain;
          if (method === "wallet_switchEthereumChain") {
            if (!w.added) {
              throw { code: 4902, message: "Unknown chain" };
            }
            w.chain = params[0].chainId;
            listeners.chainChanged?.(w.chain);
            return null;
          }
          if (method === "wallet_addEthereumChain") {
            w.added = true;
            return null;
          }
          if (method === "eth_sendTransaction") {
            if (w.reject) throw { code: 4001, message: "User rejected" };
            return window.__sendFixture(params[0]);
          }
          // An EIP-5792 wallet when `atomic`: a batch runs its calls in order through the same fixture.
          if (atomic && method === "wallet_getCapabilities")
            return { [w.chain]: { atomic: { status: "supported" } } };
          if (atomic && method === "wallet_sendCalls") {
            if (w.reject) throw { code: 4001, message: "User rejected" };
            const hashes = [];
            for (const c of params[0].calls) hashes.push(await window.__sendFixture({ from: params[0].from, to: c.to, data: c.data }));
            w.batches = [...(w.batches ?? []), params[0].calls.length];
            w.lastBatch = hashes;
            return { id: "0x" + "ba".repeat(32) };
          }
          if (atomic && method === "wallet_getCallsStatus")
            return {
              version: "2.0.0",
              id: params[0],
              chainId: w.chain,
              atomic: true,
              status: 200,
              receipts: w.lastBatch.map((h) => ({
                transactionHash: h,
                blockHash: "0x" + "11".repeat(32),
                blockNumber: "0x1",
                gasUsed: "0x1",
                logs: [],
                status: "0x1",
              })),
            };
          throw Error("Unmocked wallet " + method);
        },
      };
    },
    { account, chain, reject, atomic },
  );
}

export const extraOwner = "0x0000000000000000000000000000000000000c33";
export const closedOwner = "0x0000000000000000000000000000000000000d44";
export function fixtureLogs(s, address) {
  const name = byAddr[address.toLowerCase()];
  const a = abi[abiName[name] || name];
  const event = (eventName, args, height, index) => {
    const item = a.find((e) => e.type === "event" && e.name === eventName);
    return {
      address,
      topics: encodeEventTopics({ abi: a, eventName, args }),
      data: encodeAbiParameters(
        item.inputs.filter((i) => !i.indexed),
        item.inputs.filter((i) => !i.indexed).map((i) => args[i.name]),
      ),
      blockNumber: "0x" + height.toString(16),
      logIndex: "0x" + index.toString(16),
      transactionIndex: "0x0",
      transactionHash: "0x" + height.toString(16).padStart(64, "0"),
      blockHash,
      removed: false,
    };
  };
  if (name === "ParameterizedVault")
    return [
      ...[account, candidate, extraOwner, closedOwner, account, ...Array.from({ length: s.crowd ?? 0 }, (_, i) => crowdOwner(i))].map(
        (owner, i) =>
          event(
            "CollateralDeposited",
            { account: owner, amount: 100n * W },
            100 + i,
            0,
          ),
      ),
      // One liquidation, so points credit a liquidator (legacy name for Bite).
      event(
        "Liquidated",
        {
          owner: closedOwner,
          liquidator: account,
          debtRepaid: 10n * W,
          collateralSeized: 11n * W,
        },
        200,
        1,
      ),
    ];
  // imdUSD transfers for genesis points: the account mints 300 and sends 100 on; the Treasury's
  // stability-fee mint must earn nothing. Expected (season 16..256, 7,200 blocks a point):
  // account 4.47 holding + 30 liquidation = 34.47, candidate 3.62.
  if (name === "compToken") {
    const zero = "0x0000000000000000000000000000000000000000";
    return [
      event("Transfer", { from: zero, to: account, value: 300n * W }, 110, 0),
      event("Transfer", { from: zero, to: candidate, value: 100n * W }, 111, 0),
      event(
        "Transfer",
        { from: account, to: candidate, value: 100n * W },
        140,
        0,
      ),
      event(
        "Transfer",
        { from: zero, to: addresses.treasury, value: 5n * W },
        150,
        0,
      ),
    ];
  }
  if (!["PriceFeed", "NhiFeed", "SpotFeed", "oracle"].includes(name)) return [];
  return [7200, 7000, 2400, 120, ...(s.extraPoint ? [30] : [])].flatMap(
    (seconds, i) => {
      const value =
        name === "NhiFeed"
          ? ((80n + BigInt(i)) * W) / 100n
          : name === "oracle"
            ? 10000n + BigInt(i)
            : W / 1000n + (BigInt(i) * W) / 100000n;
      return [
        event(
          "ValueUpdated",
          { value, updatedAt: s.now - BigInt(seconds) },
          100 + i * 10,
          0,
        ),
        event(
          "AttestationAccepted",
          {
            requestId: "0x" + i.toString(16).padStart(64, "0"),
            questionHash: "0x" + "01".repeat(32),
          },
          100 + i * 10,
          1,
        ),
      ];
    },
  );
}
export function blockscout(s, url) {
  const parsed = new URL(url),
    address = parsed.pathname.split("/")[4];
  const all = s.explorerEmpty ? [] : fixtureLogs(s, address).reverse();
  const page = Number(parsed.searchParams.get("cursor") || 0);
  const items = all.slice(page, page + 3).map((l) => ({
    address: { hash: l.address },
    block_number: Number(BigInt(l.blockNumber)),
    index: Number(BigInt(l.logIndex)),
    transaction_hash: l.transactionHash,
    data: l.data,
    topics: l.topics,
  }));
  return {
    items,
    next_page_params: page + 3 < all.length ? { cursor: page + 3 } : null,
  };
}

// Mainnet ENS, answered for the demo and the tests: two fixture addresses carry names, every
// other reverse lookup reverts as an address with no primary name does.
export const ensRpcUrls = JSON.parse(
  readFileSync(new URL("../src/ens-rpc.json", import.meta.url)),
);
export const ensNames = {
  [account.toLowerCase()]: "miyagod.eth",
  [candidate.toLowerCase()]: "keeper.eth",
  // A dozen of the demo's crowd carry primary names too, so the book's search by ENS has something to find.
  ...Object.fromEntries(
    [
      "whale.eth", "hodl.eth", "nakamoto.eth", "liquidity.eth", "degen.eth", "vitalik-fan.eth",
      "satoshi.eth", "ledger.eth", "treasury.eth", "marketmaker.eth", "stable.eth", "dollar.eth",
    ].map((name, i) => [crowdOwner(i * 3).toLowerCase(), name]),
  ),
};
const reverseAbi = parseAbi([
  "function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string resolvedName, address resolver, address reverseResolver)",
]);
/** The market sits 10% above the fixture's primary feed (1.1e15 wei ETH per IMD against 1e15). */
const isqrt = (n) => {
  let x = n, y = (n + 1n) / 2n;
  while (y < x) [x, y] = [y, (n / y + y) / 2n];
  return x;
};
const marketSqrt = isqrt((10n ** 18n << 192n) / (11n * 10n ** 14n));
export function ensRpc(body) {
  const reply = (result) => ({ jsonrpc: "2.0", id: body.id, result });
  if (body.method === "eth_chainId") return reply("0x1");
  if (body.method !== "eth_call")
    return {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "unsupported" },
    };
  // IMD's live market for the price panel: the v4 pool's slot0 (extsload) and Chainlink ETH/USD.
  const data = body.params[0].data;
  if (data.startsWith("0x1e2eaeaf")) return reply(`0x${marketSqrt.toString(16).padStart(64, "0")}`);
  if (data.startsWith("0xfeaf968c"))
    return reply(
      encodeAbiParameters(
        parseAbiParameters("uint80, int256, uint256, uint256, uint80"),
        [1n, 2000n * 10n ** 8n, 0n, 0n, 1n],
      ),
    );
  // Anything else this mock does not model (e.g. a vault read such as gem() routed to the mainnet client)
  // reverts, as an unknown call to a real node would, instead of throwing out of the route handler.
  let args;
  try {
    ({ args } = decodeFunctionData({ abi: reverseAbi, data }));
  } catch {
    return { jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted", data: "0x" } };
  }
  const name = ensNames[String(args[0]).toLowerCase()];
  if (!name)
    return {
      jsonrpc: "2.0",
      id: body.id,
      error: { code: 3, message: "execution reverted", data: "0x" },
    };
  return reply(
    encodeFunctionResult({
      abi: reverseAbi,
      functionName: "reverseWithGateways",
      result: [name, zeroAddress, zeroAddress],
    }),
  );
}
