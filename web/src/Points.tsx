import { useEffect, useRef, useState } from "react";
import { decodeEventLog, getAddress } from "viem";
import {
  computePoints,
  display,
  displayNumber,
  shareBps,
  type PointEvent,
  type PointsResult,
} from "../../points/engine.ts";
import { lpEvents, type TxTransfer } from "../../points/lp.ts";
import { computePreseason } from "../../points/preseason.ts";
import { poolEvents, nftOwnerEvents, S1_TOPICS, type RawLog } from "../../points/pool.ts";
import { history } from "./history";
import { ours } from "./names";
import { historyConfig, pointsConfig, type Runtime } from "./config";
import type { Snapshot } from "./state";
import { message } from "./math";
import { Info, Row } from "./actions";
import { Ticker } from "./motion";
import { useEns, displayName, ensName } from "./ens";

const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SECONDS_PER_BLOCK = 12;
const topicAddress = (t: string) => getAddress(`0x${t.slice(-40)}`);
/** keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"), the PoolManager's add/remove event. */
const MODIFY_LIQUIDITY =
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

/** Transactions that added to or removed from the peg pool, read once and then only the new blocks. */
const lpScans = new WeakMap<Runtime, { through: number; txs: Set<string> }>();
async function pegLiquidityTxs(r: Runtime, head: number): Promise<Set<string> | undefined> {
  const pool = pointsConfig.pegPools[r.config.chainId];
  const pm = pointsConfig.poolManagers[r.config.chainId];
  if (!pool || !pm) return undefined;
  // Kept in the browser between visits (missing or full storage just means a full scan), and re-read from 64 blocks
  // before where the last scan stopped, so a reorganised block is read again.
  const storeKey = `lp-scan:${r.config.chainId}:${pool.poolId}`;
  let old = lpScans.get(r);
  if (!old)
    try {
      const kept = JSON.parse(localStorage.getItem(storeKey) ?? "null");
      if (kept && Number.isSafeInteger(kept.through) && Array.isArray(kept.txs)) old = { through: kept.through, txs: new Set(kept.txs) };
    } catch {
      /* no storage */
    }
  const txs = new Set(old?.txs);
  const step = Number(historyConfig.chunkSize);
  // Windows aligned to multiples of the chunk size, as history.ts reads them, so /rpc can serve closed ones from
  // its cache; several at a time.
  const windows: [number, number][] = [];
  for (let a = old ? Math.max(pool.fromBlock, old.through - 63) : pool.fromBlock; a <= head; ) {
    const b = (Math.floor((a + step - 1) / step) + 1) * step - 1;
    windows.push([a, Math.min(head, b)]);
    a = b + 1;
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(historyConfig.parallel, windows.length) }, async () => {
      while (next < windows.length) {
        const [a, b] = windows[next++];
        const logs = (await r.client.request({
          method: "eth_getLogs",
          params: [{ address: pm as `0x${string}`, topics: [MODIFY_LIQUIDITY, pool.poolId], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
        })) as { transactionHash: string }[];
        for (const l of logs) txs.add(l.transactionHash.toLowerCase());
      }
    }),
  );
  lpScans.set(r, { through: head, txs });
  try {
    localStorage.setItem(storeKey, JSON.stringify({ through: head, txs: [...txs] }));
  } catch {
    /* no storage */
  }
  return txs;
}

/** Every log of the peg pool (Initialize, Swap, ModifyLiquidity) and its positions' NFT transfers, for Season 1's
 * liquidity reader (points/preseason.ts). Read in the same aligned windows as above; kept in memory per runtime. */
const poolScans = new WeakMap<Runtime, { through: number; logs: RawLog[] }>();
async function pegPoolLogs(r: Runtime, head: number): Promise<{ pool: RawLog[]; nft: RawLog[] } | undefined> {
  const pool = pointsConfig.pegPools[r.config.chainId];
  const pm = pointsConfig.poolManagers[r.config.chainId];
  if (!pool?.positionManager || !pm) return undefined;
  const old = poolScans.get(r);
  const step = Number(historyConfig.chunkSize);
  const windowsFrom = (from: number) => {
    const w: [number, number][] = [];
    for (let a = from; a <= head; ) {
      const b = (Math.floor((a + step - 1) / step) + 1) * step - 1;
      w.push([a, Math.min(head, b)]);
      a = b + 1;
    }
    return w;
  };
  const scan = async (windows: [number, number][], address: string, topics: unknown[]) => {
    const out: RawLog[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(historyConfig.parallel, windows.length) }, async () => {
        while (next < windows.length) {
          const [a, b] = windows[next++];
          const logs = (await r.client.request({
            method: "eth_getLogs",
            params: [{ address: address as `0x${string}`, topics: topics as never, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
          })) as RawLog[];
          out.push(...logs);
        }
      }),
    );
    return out;
  };
  // Re-read from 64 blocks before the last scan, dropping what was kept from there, so a reorganised block is read again.
  const from = old ? Math.max(pool.fromBlock, old.through - 63) : pool.fromBlock;
  const fresh = await scan(windowsFrom(from), pm, [[S1_TOPICS.initialize, S1_TOPICS.swap, S1_TOPICS.modifyLiquidity], pool.poolId]);
  const logs = [...(old?.logs.filter((l) => Number(BigInt(l.blockNumber)) < from) ?? []), ...fresh];
  poolScans.set(r, { through: head, logs });
  if (!logs.some((l) => l.topics[0]?.toLowerCase() === S1_TOPICS.initialize)) throw new Error("the peg pool's Initialize was not read: liquidity cannot be priced");
  const { tokenIds } = poolEvents(logs, pool.positionManager);
  const ids = tokenIds.map((id) => "0x" + id.toString(16).padStart(64, "0"));
  const nft = ids.length ? await scan(windowsFrom(pool.fromBlock), pool.positionManager, [S1_TOPICS.transfer, null, null, ids]) : [];
  return { pool: logs, nft };
}

/** Reads imdUSD transfers and vault liquidations, then runs the shared engine at the snapshot block. */
export async function loadPoints(
  r: Runtime,
  s: Snapshot,
): Promise<PointsResult> {
  const token = s.targets.stablecoin;
  const vault = s.targets.ParameterizedVault;
  const [tokenHistory, vaultHistory] = await Promise.all([
    history(r, token, s.block),
    history(r, vault, s.block),
  ]);
  const events: PointEvent[] = [];
  const transfers: TxTransfer[] = [];
  for (const log of tokenHistory.logs) {
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3) continue;
    const t = {
      from: topicAddress(log.topics[1]!),
      to: topicAddress(log.topics[2]!),
      value: BigInt(log.data),
      block: Number(log.blockNumber),
      logIndex: log.logIndex,
      tx: log.transactionHash,
    };
    transfers.push(t);
    events.push({ kind: "transfer", from: t.from, to: t.to, value: t.value, block: t.block, logIndex: t.logIndex });
  }
  // imdUSD provided to the peg pool earns the liquidity rate (points/lp.ts): the PoolManager is excluded, so a
  // deposit leaves the wallet's holding and comes back here as liquidity.
  const lpTxs = await pegLiquidityTxs(r, Number(s.block));
  const pm = pointsConfig.poolManagers[r.config.chainId];
  if (lpTxs && pm) events.push(...lpEvents(transfers, lpTxs, pm));
  for (const log of vaultHistory.logs) {
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: vault.abi,
        data: log.data,
        topics: log.topics,
      });
    } catch {
      continue; // events this ABI does not describe carry no points
    }
    if (!decoded.eventName || ours(decoded.eventName) !== "Bite") continue;
    // Same order under both interfaces: owner, liquidator, debt repaid, collateral seized.
    const [, liquidator, debtRepaid] = Object.values(decoded.args as object);
    events.push({
      kind: "bite",
      liquidator: String(liquidator),
      debtRepaid: BigInt(debtRepaid as bigint),
      block: Number(log.blockNumber),
      logIndex: log.logIndex,
    });
  }
  const head = Number(s.block);
  const endBlock =
    pointsConfig.endBlock === undefined
      ? head
      : Math.min(pointsConfig.endBlock, head);
  const season = {
    // Past the end nothing accrues: totals stay as they were at endBlock and every rate reads zero.
    closed: pointsConfig.endBlock !== undefined && head >= pointsConfig.endBlock,
    // The first imdUSD transfer (the CLI's default too), not the history's read floor, which can sit earlier.
    startBlock: pointsConfig.startBlock ?? (tokenHistory.logs.length ? Number(tokenHistory.logs[0]!.blockNumber) : Number(tokenHistory.from)),
    endBlock,
    blocksPerDay: pointsConfig.blocksPerDay,
    lpBps: pointsConfig.lpBps,
    liquidationCreditDays: pointsConfig.liquidationCreditDays,
    excluded: [
      vault.address,
      s.targets.treasury.address,
      pointsConfig.poolManagers[r.config.chainId] ?? "",
      ...pointsConfig.excluded,
    ].filter(Boolean),
  };
  // From lpSwitchBlock, liquidity earns by Season 1's reader (points/preseason.ts); holding is unchanged.
  const pegPool = pointsConfig.pegPools[r.config.chainId];
  if (pointsConfig.lpSwitchBlock !== undefined && pegPool?.positionManager && pegPool.bandLower !== undefined) {
    const logs = await pegPoolLogs(r, head);
    if (logs) {
      const pool = poolEvents(logs.pool, pegPool.positionManager);
      return computePreseason(events, season, {
        switchBlock: pointsConfig.lpSwitchBlock,
        poolEvents: [...pool.events, ...nftOwnerEvents(logs.nft)],
        bandLower: pegPool.bandLower,
        bandUpper: pegPool.bandUpper!,
        token1Scale: pegPool.token1Scale ?? 10n ** 12n,
      });
    }
  }
  return computePoints(events, season);
}

type Loaded = {
  data?: PointsResult;
  error?: string;
  loading: boolean;
  at?: number;
};

export function usePoints(r: Runtime, s?: Snapshot) {
  const [state, setState] = useState<Loaded>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!s) return;
    let live = true;
    setState((old) => ({ ...old, loading: true }));
    loadPoints(r, s).then(
      (data) => live && setState({ data, loading: false, at: Date.now(), error: undefined }),
      // A failed refresh keeps the last board (with the error noted under it) rather than replacing it.
      (e) => live && setState((old) => ({ ...old, error: message(e), loading: false })),
    );
    return () => {
      live = false;
    };
  }, [r, s, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** A figure that keeps counting between blocks, from the points at the snapshot and the rate since. */
function useLive(base: bigint, perBlock: bigint, since: number | undefined, id: string) {
  const [now, setNow] = useState(() => Date.now());
  const reduced = useRef(
    typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (perBlock === 0n) return;
    const id = setInterval(
      () => setNow(Date.now()),
      reduced.current ? 12_000 : 1_000,
    );
    return () => clearInterval(id);
  }, [perBlock]);
  const blocks =
    since === undefined
      ? 0
      : Math.max(0, (now - since) / 1000 / SECONDS_PER_BLOCK);
  const value =
    displayNumber(base, pointsConfig.blocksPerDay) +
    displayNumber(perBlock, pointsConfig.blocksPerDay) * blocks;
  // Never backwards. The count runs on from when the points were read, which is some seconds after the block
  // they were read at, so it runs a little ahead and the next read would pull it back. It holds instead,
  // until the chain catches up. Another account (`id`) starts afresh.
  const shown = useRef({ id: "", value: 0 });
  if (shown.current.id !== id || value >= shown.current.value) shown.current = { id, value };
  return shown.current.value;
}

// Rounded DOWN, like every exact figure the engine displays, so the counter never shows a point the
// leaderboard rows have not earned.
const fmtPoints = (n: number) =>
  (Math.floor(n * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const perDay = (perBlock: bigint) =>
  display(
    perBlock * BigInt(pointsConfig.blocksPerDay),
    pointsConfig.blocksPerDay,
  );

export function Points({
  r,
  account,
  points,
}: {
  r: Runtime;
  account?: string;
  points: ReturnType<typeof usePoints>;
}) {
  const data = points.data;
  const mine = account
    ? data?.accounts.find((a) => a.owner === account.toLowerCase())
    : undefined;
  const rank = mine && data ? data.accounts.indexOf(mine) + 1 : undefined;
  const top = data?.accounts.slice(0, 10) ?? [];
  useEns(top.map((a) => a.owner));
  const liveMine = useLive(
    mine?.points ?? 0n,
    mine?.ratePerBlock ?? 0n,
    points.at,
    account?.toLowerCase() ?? "",
  );
  const liveTotal = useLive(
    data?.total ?? 0n,
    data?.totalRatePerBlock ?? 0n,
    points.at,
    "total",
  );
  const testnet = r.config.chainId !== 1;
  const closed = pointsConfig.endBlock !== undefined;
  // Preseason: Season 1 has not opened. Points may still be counting (closed is false) or frozen.
  const preseason = pointsConfig.preseason || closed;

  if (points.error && !data)
    return (
      <div className="desk-col">
        <p className="notice" role="alert">
          Could not read the points history: {points.error}. This is not the
          same as nobody holding imdUSD.{" "}
          <button type="button" onClick={points.retry}>
            Retry
          </button>
        </p>
      </div>
    );

  return (
    <>
      <div className="desk-col">
        {testnet && (
          <p className="notice" role="note">
            Preview on {r.config.network.name}. Testnet balances cost nothing to
            fake, so these points do not count. The season runs on mainnet.
          </p>
        )}
        {preseason && (
          <p className="notice notice-warn points-notice" role="note">
            <strong>Season 1 is yet to start.</strong> The points earned so far count towards your preseason total,
            which will be a capped distribution.
          </p>
        )}
        <div className="hero-stat">
          <span>
            {preseason ? (account ? "Your preseason points" : "Preseason total") : account ? "Your points" : "Season total"}
            <Info
              label="Points"
              text={
                closed
                  ? `Preseason points: 1 point for 1 imdUSD held for 1 day, ${pointsConfig.lpBps / 10_000}× for imdUSD provided to the imdUSD/USDC pool, counted until block ${pointsConfig.endBlock!.toLocaleString("en-US")}. Nothing accrues now; Season 1's rules are published when it opens.`
                  : preseason
                    ? `Preseason points: 1 point for 1 imdUSD held for 1 day; imdUSD you provide to the imdUSD/USDC pool earns ${pointsConfig.lpBps / 10_000}×. They count towards a capped preseason distribution. The counter runs between blocks at your current holdings and settles each refresh.`
                    : `1 point = 1 imdUSD held for 1 day. imdUSD you provide to the imdUSD/USDC pool earns ${pointsConfig.lpBps / 10_000}×. The counter runs between blocks at your current holdings and settles each refresh.`
              }
            />
          </span>
          <strong aria-live="off">
            {points.loading && !data
              ? "Reading…"
              : fmtPoints(account ? liveMine : liveTotal)}
          </strong>
          <small>
            {account
              ? mine
                ? `${closed ? "" : `+${perDay(mine.ratePerBlock)}/day · `}${(shareBps(mine.points, data!.total) / 100).toFixed(2)}% · #${rank} of ${data!.accounts.length}`
                : closed
                  ? "No preseason points for this wallet"
                  : "Hold imdUSD or provide it to the imdUSD/USDC pool to start earning"
              : data
                ? closed
                  ? `${data.accounts.length} wallets`
                  : `${data.accounts.length} earning · +${perDay(data.totalRatePerBlock)}/day`
                : ""}
          </small>
        </div>
        <Row label="Holding" info="imdUSD in a wallet, per imdUSD per day.">
          1 point / day
        </Row>
        <Row
          label="Liquidity"
          info="imdUSD you deposit into the imdUSD/USDC pool on Uniswap, from the block you deposit it, less what you withdraw. Boosted, because the peg needs depth."
        >
          {pointsConfig.pegPools[r.config.chainId]
            ? `${pointsConfig.lpBps / 10_000} points / day`
            : "no pool on this network"}
        </Row>
        <Row
          label="Liquidations"
          info="Each imdUSD of debt a liquidator repays earns this many days of holding."
        >
          {`${pointsConfig.liquidationCreditDays} days per imdUSD`}
        </Row>
        <Row
          label={preseason ? "Preseason" : "Counting"}
          info={
            closed
              ? `Preseason points counted from imdUSD's deployment to the block shown${pointsConfig.endedAt ? ` (${pointsConfig.endedAt})` : ""} and no longer change. INFER's seasons are opened on chain by governance, each with its own rules committed when it opens and published after it ends.`
              : "Points count from imdUSD's deployment and are still counting. INFER's seasons are opened on chain by governance, each with its own rules committed when it opens and published after it ends."
          }
        >
          {data
            ? pointsConfig.endBlock === undefined
              ? `Block ${data.startBlock.toLocaleString("en-US")} → live`
              : `Blocks ${data.startBlock.toLocaleString("en-US")} → ${pointsConfig.endBlock.toLocaleString("en-US")}`
            : "—"}
        </Row>
        <Row
          label="Not counted"
          info="Contracts that hold imdUSD for the protocol or the pool: the vault, the Treasury, and Uniswap's PoolManager (its imdUSD is credited to the LPs who deposited it)."
        >
          Vault, Treasury, pool contract
        </Row>
        {account && mine && !closed && (
          <Row label="You hold" info="Earning at the holding rate right now.">
            {`${display(mine.held * BigInt(pointsConfig.blocksPerDay), pointsConfig.blocksPerDay)} imdUSD`}
          </Row>
        )}
        {account && mine && mine.lp > 0n && !closed && (
          <Row label="You provide" info="imdUSD you deposited into the imdUSD/USDC pool, earning the liquidity rate.">
            {`${display(mine.lp * BigInt(pointsConfig.blocksPerDay), pointsConfig.blocksPerDay)} imdUSD`}
          </Row>
        )}
      </div>
      <div className="desk-col points-board">
        <div className="loan-columns points-columns" aria-hidden="true">
          <span>Top 10 holders</span>
          <span>Points</span>
          <span>Share</span>
          <span>{closed ? "" : "Per day"}</span>
        </div>
        {data && !top.length ? (
          <p className="muted">
            No imdUSD is held yet. Points start with the first mint.
          </p>
        ) : (
          <ol className="loan-feed points-feed" aria-label="Points leaderboard">
            {top.map((a, i) => (
              <li
                key={a.owner}
                className={
                  a.owner === account?.toLowerCase()
                    ? "selected-loan"
                    : undefined
                }
              >
                <span className="loan-who">
                  <b className={ensName(a.owner) ? "ens-name" : undefined}>
                    {i + 1}. {displayName(a.owner)}
                  </b>
                  <span className="loan-address" title={a.owner}>
                    {a.owner}
                  </span>
                </span>
                <span>
                  <Ticker text={display(a.points, pointsConfig.blocksPerDay)} />
                </span>
                <span>
                  {(shareBps(a.points, data!.total) / 100).toFixed(2)}%
                </span>
                <span>{closed ? "" : `+${perDay(a.ratePerBlock)}`}</span>
              </li>
            ))}
          </ol>
        )}
        {points.error && data && (
          <p className="micro danger-text" role="status">
            Could not refresh the points history: {points.error}. Showing the last board read.{" "}
            <button type="button" onClick={points.retry}>
              Retry
            </button>
          </p>
        )}
      </div>
    </>
  );
}
