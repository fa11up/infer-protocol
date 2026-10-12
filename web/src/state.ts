import { parseAbi, zeroAddress, type Address } from "viem";
import { activeInterface, onChain } from "./names";
import { setUnit } from "./unit";
import { setCollateral, shareAbi, vaultShareAbi } from "./collateral";
import { readAsker, type AskerState } from "./BuyUpdate";
import type { Runtime, Target } from "./config";
// Dynamic implementation-derived ABIs are loaded only after manifest verification.
export const read = async (
  r: Runtime,
  t: Target,
  fn: string,
  args: readonly unknown[] = [],
  blockNumber?: bigint,
): Promise<any> =>
  r.client.readContract({ ...t, functionName: onChain(fn), args, blockNumber });
// Whether an address has code, checked once per page load: these contracts cannot self-destruct (no
// SELFDESTRUCT in their runtime, launch check), so code seen once stays. Re-reading it for every contract on every
// 15-second refresh was a third of the terminal's RPC calls. A miss is not remembered: it is re-read next time.
const withCode = new WeakMap<Runtime, Set<string>>();
async function hasCode(r: Runtime, address: Address, blockNumber: bigint) {
  let seen = withCode.get(r);
  if (!seen) withCode.set(r, (seen = new Set()));
  if (seen.has(address.toLowerCase())) return true;
  const code = await r.client.getCode({ address, blockNumber });
  if (!code || code === "0x") return false;
  seen.add(address.toLowerCase());
  return true;
}
// Reads newer than the pinned ABIs. They are called through inline fragments rather than by
// editing public/abi (which the manifest verifies against the deployment's source commit), and a
// deployment that predates them reads as "unavailable" in its own field, never as a failed snapshot.
const optionalAbi = parseAbi([
  "function backingPerUnit() view returns (uint256)",
  "function backingPerComp() view returns (uint256)",
  "function expectedQuestionHash(uint64 fromBlock, uint64 toBlock) pure returns (bytes32)",
  "function lastToBlock() view returns (uint64)",
  "function maxDeviationBps() view returns (uint256)",
  "function STALE_DEVIATION_MULTIPLE() view returns (uint256)",
  "function oracleBudget() view returns (uint256)",
  "function redemptionDivisor() view returns (uint256)",
  "function streamPayee() view returns (address)",
  "function streamPerDay() view returns (uint256)",
  "function workOracle() view returns (address)",
]);
export type Question =
  | { kind: "pinned"; fingerprint: `0x${string}`; lastToBlock?: bigint }
  | { kind: "unpinned" }
  | { kind: "unavailable" };
export type Snapshot = {
  block: bigint;
  timestamp: bigint;
  loadedAt: number;
  targets: Record<string, Target>;
  v: Record<string, any>;
  feeds: Record<
    string,
    { value: bigint; updated: bigint; stale: boolean; maxAge: bigint }
  >;
  work: Record<string, any>;
  questions: Record<string, Question>;
  errors: string[];
  verified: boolean;
  /** The protocol's OracleAsker, when the deployment names one; "unreadable" if it would not answer. */
  asker?: AskerState | "unreadable";
};
export async function snapshot(
  r: Runtime,
  account?: Address,
): Promise<Snapshot> {
  if ((await r.client.getChainId()) !== r.config.chainId)
    throw Error(
      "Public RPC chain ID does not match the deployment. Transactions disabled.",
    );
  const block = await r.client.getBlock();
  const bn = block.number;
  const targets = { ...r.targets };
  await Promise.all(
    Object.entries(targets).map(async ([n, t]) => {
      if (!(await hasCode(r, t.address, bn)))
        throw Error(`No deployed code for ${n}. Transactions disabled.`);
    }),
  );
  const vault = targets.ParameterizedVault;
  if (!vault) throw Error("The handoff is missing ParameterizedVault.");
  await Promise.all(
    Object.entries({
      gem: "MockIMD",
      stablecoin: "ImdUSD",
      parameters: "Parameters",
      treasury: "Treasury",
      usdPriceFeed: "UsdPriceFeed",
      oracle: "SwarmWorkOracle",
    }).map(async ([fn, abiName]) => {
      const a = (await read(r, vault, fn, [], bn)) as Address;
      if (a === zeroAddress) throw Error(`Missing linked contract: ${fn}`);
      targets[fn] = { address: a, abi: r.abis[abiName] };
      if (!(await hasCode(r, a, bn))) throw Error(`No code for linked ${fn}`);
    }),
  );
  await Promise.all(
    [
      ["priceFeed", "PriceFeed"],
      ["nhiFeed", "NhiFeed"],
      ["spotFeed", "SpotFeed"],
    ].map(async ([getter, name]) => {
      if (
        (await read(r, vault, getter, [], bn)).toLowerCase() !==
        targets[name].address.toLowerCase()
      )
        throw Error(`Vault ${getter} differs from the handoff.`);
    }),
  );
  await Promise.all(
    ["stablecoin", "parameters", "treasury", "oracle"].map(async (name) => {
      if (
        (await read(r, targets[name], "vault", [], bn)).toLowerCase() !==
        vault.address.toLowerCase()
      )
        throw Error(`Linked ${name} belongs to a different vault.`);
    }),
  );
  const errors: string[] = [];
  const v: Record<string, any> = {};
  const feeds: Snapshot["feeds"] = {};
  const jobs: string[] = [
    "mat",
    "redemptionCeilingCR",
    "gap",
    "redemptionReserve",
    "REDEMPTION_FEE_FLOOR_BPS",
    "REDEMPTION_FEE_CAP_BPS",
    "totalDebt",
    "backedDebt",
    "totalBadDebt",
    "totalEarned",
    "totalNonPrincipalRedeemed",
    "earnLine",
    "earnMat",
    "reserveValue",
    "securedCollateral",
    "line",
    "duty",
    "skew",
    "lull",
    "tail",
  ];
  const safe = async (key: string, fn: () => Promise<any>) => {
    try {
      v[key] = await fn();
    } catch {
      errors.push(key);
    }
  };
  await Promise.all([
    ...jobs.map((fn) => safe(fn, () => read(r, vault, fn, [], bn))),
    safe("fee", () => read(r, vault, "redemptionFeeBps", [0n], bn)),
    safe("supply", () => read(r, targets.stablecoin, "totalSupply", [], bn)),
    // Only the testnet faucet token answers deployer(); real collateral (sIMD) does not, and that is no failure.
    read(r, targets.gem, "deployer", [], bn).then(
      (d) => (v.imdDeployer = d),
      () => undefined,
    ),
    safe("gemDecimals", () => read(r, targets.gem, "decimals", [], bn)),
    safe("gemSymbol", () => read(r, targets.gem, "symbol", [], bn)),
    safe("compDecimals", () => read(r, targets.stablecoin, "decimals", [], bn)),
    ...[
      "governor",
      "TIMELOCK",
      "pendingChange",
      "current",
      "wage",
      "pendingGap",
      "pendingEarnMat",
      "pendingReserveAsset",
      "pendingSet",
      "pending",
    ].map((fn) => safe(fn, () => read(r, targets.parameters, fn, [], bn))),
    safe("reserveAssets", () =>
      read(r, targets.treasury, "reserveAssets", [], bn),
    ),
    safe("withdrawer", () => read(r, targets.treasury, "withdrawer", [], bn)),
    ...Object.entries({
      PriceFeed: "PriceFeed",
      NhiFeed: "NhiFeed",
      SpotFeed: "SpotFeed",
      USD: "usdPriceFeed",
    }).map(async ([key, n]) => {
      try {
        const [data, stale, maxAge] = await Promise.all([
          read(r, targets[n], "latestValue", [], bn),
          read(r, targets[n], "isStale", [], bn),
          read(r, targets[n], "maxAge", [], bn),
        ]);
        feeds[key] = { value: data[0], updated: data[1], stale, maxAge };
      } catch {
        errors.push(key);
      }
    }),
    ...(account
      ? [
          ...[
            "positions",
            "debtOf",
            "stabilityFeeOf",
            "collateralRatio",
            "badDebtOf",
            // The connected borrower's own mark: the position pane warns while one is open.
            "liquidationMarks",
          ].map((fn) => safe(fn, () => read(r, vault, fn, [account], bn))),
          safe("gemBalance", () =>
            read(r, targets.gem, "balanceOf", [account], bn),
          ),
          safe("compBalance", () =>
            read(r, targets.stablecoin, "balanceOf", [account], bn),
          ),
          safe("allowance", () =>
            read(r, targets.gem, "allowance", [account, vault.address], bn),
          ),
          safe("rights", () =>
            read(r, targets.oracle, "mintingRights", [account], bn),
          ),
        ]
      : []),
  ]);
  const optional = (
    address: Address,
    functionName: string,
    args: readonly unknown[] = [],
  ) =>
    r.client.readContract({
      address,
      abi: optionalAbi,
      functionName: onChain(functionName) as never,
      args: args as never,
      blockNumber: bn,
    }) as Promise<any>;
  // How far one update may move the price: the cap, and how much wider it is once stale. A feed built
  // before the stale bound has no multiple, and then a stale feed is unbounded.
  try {
    v.priceCapBps = await optional(targets.PriceFeed.address, "maxDeviationBps");
  } catch {
    v.priceCapBps = undefined;
  }
  try {
    v.staleMultiple = await optional(targets.PriceFeed.address, "STALE_DEVIATION_MULTIPLE");
  } catch {
    v.staleMultiple = undefined;
  }
  // Current values for the newer governed settings, so a pending change can read current → proposed. An
  // older Parameters without them reads "—" for the current side.
  await Promise.all(
    ["oracleBudget", "redemptionDivisor", "streamPayee", "streamPerDay", "workOracle"].map(async (fn) => {
      try {
        v[`gov_${fn}`] = await optional(targets.parameters.address, fn);
      } catch {
        v[`gov_${fn}`] = undefined;
      }
    }),
  );
  try {
    v.backingPerUnit = await optional(vault.address, "backingPerUnit");
  } catch {
    v.backingPerUnit = undefined;
  }
  try {
    setUnit(await read(r, targets.stablecoin, "symbol", [], bn));
  } catch {
    /* Label only: the default unit stands. */
  }
  const questions: Record<string, Question> = {};
  await Promise.all(
    ["PriceFeed", "NhiFeed", "SpotFeed"].map(async (n) => {
      try {
        // A feed that pins no question returns zero for every window.
        const hash = (await optional(
          targets[n].address,
          "expectedQuestionHash",
          [0n, 0n],
        )) as `0x${string}`;
        if (/^0x0+$/.test(hash)) questions[n] = { kind: "unpinned" };
        else {
          let last: bigint | undefined;
          try {
            last = BigInt(await optional(targets[n].address, "lastToBlock"));
          } catch {
            last = undefined;
          }
          questions[n] = {
            kind: "pinned",
            fingerprint: hash,
            lastToBlock: last,
          };
        }
      } catch {
        // Feeds built before question binding have no such view: they accept any question.
        questions[n] = { kind: "unavailable" };
      }
    }),
  );
  const work: Record<string, any> = { mode: "unknown" };
  // Three work oracles exist. The single-agent one ("attested") predates the rename and survives only
  // on legacy deployments. The swarm-wide one ("swarm") credits any agent from the swarm's daily tally
  // and is what deploys from now on. A test faucet ("faucet") grants credits by hand.
  try {
    if (activeInterface() !== "legacy")
      throw Error("single-agent oracle is legacy only");
    const keys = [
      "attestedTasks",
      "creditedTasks",
      "earnedRights",
      "consumedRights",
      "wage",
      "CLAIMANT",
      "AGENT_ID",
      "latestValue",
      "isStale",
      "maxAge",
    ];
    const values = await Promise.all(
      keys.map((k) => read(r, targets.oracle, k, [], bn)),
    );
    keys.forEach((k, i) => (work[k] = values[i]));
    work.mode = "attested";
  } catch {
    try {
      const keys = ["wage", "latestValue", "isStale", "maxAge"];
      const values = await Promise.all(
        keys.map((k) => read(r, targets.oracle, k, [], bn)),
      );
      keys.forEach((k, i) => (work[k] = values[i]));
      if (account) {
        [work.creditedRights, work.consumedRights] = await Promise.all([
          read(r, targets.oracle, "creditedRights", [account], bn),
          read(r, targets.oracle, "consumedRights", [account], bn),
        ]);
      }
      work.mode = "swarm";
    } catch {
      try {
        const t = {
          address: targets.oracle.address,
          abi: r.abis.MockWorkOracle,
        };
        work.deployer = await read(r, t, "deployer", [], bn);
        targets.oracle = t;
        work.mode = "faucet";
      } catch {
        work.mode = "unknown";
      }
    }
  }
  // The collateral: a staking-vault share (sIMD) answers asset() with IMD, and the vault then prices
  // it through its own collateralPriceFeed. Plain IMD answers neither, and keeps the USD feed.
  let share = false;
  try {
    const underlying = (await r.client.readContract({
      address: targets.gem.address,
      abi: shareAbi,
      functionName: "asset",
      blockNumber: bn,
    })) as Address;
    if (
      underlying !== zeroAddress &&
      underlying.toLowerCase() !== targets.gem.address.toLowerCase()
    ) {
      targets.underlying = { address: underlying, abi: r.abis.MockIMD };
      const [rate, uSymbol, uDecimals] = await Promise.all([
        r.client.readContract({
          address: targets.gem.address,
          abi: shareAbi,
          functionName: "convertToAssets",
          args: [10n ** 18n],
          blockNumber: bn,
        }),
        read(r, targets.underlying, "symbol", [], bn),
        read(r, targets.underlying, "decimals", [], bn),
      ]);
      // sIMD is priced from IMD: IMD/USD times the exchange rate, per 1e18 raw units. The vault's own
      // collateralPriceFeed computes exactly that; if it cannot be read, derive the same figure here.
      try {
        const priceFeed = (await r.client.readContract({
          address: vault.address,
          abi: vaultShareAbi,
          functionName: "collateralPriceFeed",
          blockNumber: bn,
        })) as Address;
        targets.collateralPriceFeed = {
          address: priceFeed,
          abi: r.abis.UsdPriceFeed,
        };
        const [data, stale, maxAge] = await Promise.all([
          read(r, targets.collateralPriceFeed, "latestValue", [], bn),
          read(r, targets.collateralPriceFeed, "isStale", [], bn),
          read(r, targets.collateralPriceFeed, "maxAge", [], bn),
        ]);
        feeds.Collateral = { value: data[0], updated: data[1], stale, maxAge };
      } catch {
        if (feeds.USD)
          feeds.Collateral = {
            ...feeds.USD,
            value: (feeds.USD.value * (rate as bigint)) / 10n ** 18n,
          };
      }
      setCollateral({
        symbol: v.gemSymbol,
        decimals: Number(v.gemDecimals),
        share: true,
        rate: rate as bigint,
        underlyingSymbol: uSymbol,
        underlyingDecimals: Number(uDecimals),
      });
      share = true;
      if (account) {
        await Promise.all([
          safe("underlyingBalance", () =>
            read(r, targets.underlying, "balanceOf", [account], bn),
          ),
          safe("underlyingAllowance", () =>
            read(
              r,
              targets.underlying,
              "allowance",
              [account, vault.address],
              bn,
            ),
          ),
        ]);
      }
    }
  } catch {
    // A share whose exchange rate cannot be read has no IMD equivalent: a raw sIMD amount is not an IMD
    // amount (one sIMD is several IMD), and the vault's own share price halts in this case too.
    if (targets.underlying) {
      share = true;
      errors.push("Collateral");
      setCollateral({
        symbol: v.gemSymbol,
        decimals: Number(v.gemDecimals ?? 18),
        share: true,
        rate: 0n,
      });
    }
  }
  if (!share) {
    setCollateral({
      symbol: v.gemSymbol,
      decimals: Number(v.gemDecimals ?? 18),
    });
    if (feeds.USD) feeds.Collateral = feeds.USD;
  }
  // The vault prices collateral per 1e18 raw units and never reads decimals, so any collateral scale
  // is displayable. The stablecoin is fixed at 18.
  if (
    v.gemDecimals === undefined ||
    Number(v.gemDecimals) > 36 ||
    v.compDecimals !== 18
  )
    throw Error(
      "Unexpected token decimals for this deployment. Transactions disabled.",
    );
  // Optional: a deployment without an asker, or one that does not answer, still runs every other pane.
  let asker: Snapshot["asker"];
  try {
    asker = await readAsker(
      r,
      {
        PriceFeed: targets.PriceFeed.address,
        NhiFeed: targets.NhiFeed.address,
        SpotFeed: targets.SpotFeed.address,
      },
      account,
      bn,
    );
  } catch {
    asker = "unreadable";
  }
  return {
    asker,
    block: bn,
    timestamp: block.timestamp,
    loadedAt: Date.now(),
    targets,
    v,
    feeds,
    work,
    questions,
    errors,
    verified: true,
  };
}
export function feedsReady(s: Snapshot | undefined) {
  if (!s) return false;
  for (const key of ["PriceFeed", "NhiFeed", "SpotFeed", "USD", "Collateral"]) {
    const f = s.feeds[key];
    if (!f || f.stale || !f.updated || f.value <= 0n) return false;
  }
  const a = s.feeds.PriceFeed.value,
    b = s.feeds.SpotFeed.value;
  const d = a > b ? a - b : b - a;
  return s.v.skew !== undefined && d <= (a * s.v.skew) / 10000n;
}
