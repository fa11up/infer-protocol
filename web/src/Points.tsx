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
import { poolEvents, nftOwnerEvents, isWalletCode, isSafeProxy, S1_TOPICS, type RawLog } from "../../points/pool.ts";
import { computeSeason1, type S1Event } from "../../points/season1.ts";
import { readSeason, firstBlockAtOrAfter, infer, type SeasonInfo } from "./season";
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
/** Season 1's wallet rule (rules section 2.1): EOAs, EIP-7702 accounts and Safe accounts earn; other contracts do
 * not. Classified by code at the head, as the reference scorer does through the head mid-season; remembered for the
 * session (code rarely changes, and a wrong guess only moves this view, never the payout). */
const walletCache = new WeakMap<Runtime, Map<string, boolean>>();
async function contractsAmong(r: Runtime, addresses: Set<string>, head: bigint): Promise<string[]> {
  let cache = walletCache.get(r);
  if (!cache) walletCache.set(r, (cache = new Map()));
  const out: string[] = [];
  const todo = [...addresses].filter((a) => !cache!.has(a));
  for (let i = 0; i < todo.length; i += 8)
    await Promise.all(
      todo.slice(i, i + 8).map(async (a) => {
        const code = (await r.client.getCode({ address: a as `0x${string}`, blockNumber: head })) ?? "0x";
        let wallet = isWalletCode(code);
        if (!wallet) {
          const slot0 = await r.client.getStorageAt({ address: a as `0x${string}`, slot: "0x0", blockNumber: head });
          wallet = isSafeProxy(code, slot0 ?? "0x");
        }
        cache!.set(a, wallet);
      }),
    );
  for (const a of addresses) if (cache.get(a) === false) out.push(a);
  return out;
}

export type PointsData = PointsResult & {
  season?: SeasonInfo;
  /** Season 1's board, once it is live (points/season1.ts over the season's blocks). */
  s1?: ReturnType<typeof computeSeason1>;
};

export async function loadPoints(
  r: Runtime,
  s: Snapshot,
): Promise<PointsData> {
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
  // The preseason ends at the block openSeason executed in (rules section 3): pinned in config, else read.
  const info = await readSeason(r, s.block, Number(s.timestamp)).catch(() => undefined);
  const preseasonEnd = pointsConfig.endBlock ?? (info && info.phase !== "preseason" ? info.openedBlock : undefined);
  const endBlock = preseasonEnd === undefined ? head : Math.min(preseasonEnd, head);
  const season = {
    // Past the end nothing accrues: totals stay as they were at endBlock and every rate reads zero.
    closed: preseasonEnd !== undefined && head >= preseasonEnd,
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
  let pre: PointsResult = computePoints(events, season);
  let poolLog: S1Event[] | undefined;
  if (pointsConfig.lpSwitchBlock !== undefined && pegPool?.positionManager && pegPool.bandLower !== undefined) {
    const logs = await pegPoolLogs(r, head);
    if (logs) {
      const pool = poolEvents(logs.pool, pegPool.positionManager);
      poolLog = [...pool.events, ...nftOwnerEvents(logs.nft)];
      pre = computePreseason(events, season, {
        switchBlock: pointsConfig.lpSwitchBlock,
        poolEvents: poolLog,
        bandLower: pegPool.bandLower,
        bandUpper: pegPool.bandUpper!,
        token1Scale: pegPool.token1Scale ?? 10n ** 12n,
      });
    }
  }
  if (!info || (info.phase !== "live" && info.phase !== "ended") || !poolLog || !pegPool?.bandLower) return { ...pre, season: info };

  // Season 1 (rules section 2): the same transfers and liquidations, the peg pool, wallets only.
  const startBlock = Number(await firstBlockAtOrAfter(r, info.start!, s.block));
  const s1End = info.phase === "ended" ? Number(await firstBlockAtOrAfter(r, info.end!, s.block)) - 1 : head;
  const s1Events: S1Event[] = [...(events.filter((e) => e.kind === "transfer" || e.kind === "bite") as S1Event[]), ...poolLog];
  const candidates = new Set<string>();
  for (const e of s1Events) {
    if (e.kind === "transfer") candidates.add(e.from.toLowerCase()), candidates.add(e.to.toLowerCase());
    if (e.kind === "owner") candidates.add(e.owner.toLowerCase());
    if (e.kind === "bite") candidates.add(e.liquidator.toLowerCase());
  }
  candidates.delete("0x0000000000000000000000000000000000000000");
  const contracts = await contractsAmong(r, candidates, s.block);
  const s1 = computeSeason1(s1Events, {
    startBlock,
    endBlock: s1End,
    blocksPerDay: pointsConfig.blocksPerDay,
    bandLower: pegPool.bandLower,
    bandUpper: pegPool.bandUpper!,
    token1Scale: pegPool.token1Scale ?? 10n ** 12n,
    lpBps: pointsConfig.lpBps,
    liquidationCreditDays: pointsConfig.liquidationCreditDays,
    dataThroughBlock: head,
    excluded: [vault.address, pointsConfig.poolManagers[r.config.chainId] ?? "", ...contracts].filter(Boolean),
    closed: info.phase === "ended",
  });
  return { ...pre, season: info, s1 };
}

type Loaded = {
  data?: PointsData;
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

/** INFER wei as whole INFER, grouped. */
const fmtInfer = (wei: bigint) => (wei / 10n ** 18n).toLocaleString("en-US");
const utcDay = (t: number) =>
  new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const until = (t: number, now: number) => {
  const s = Math.max(0, t - now);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

type BoardRow = { owner: string; points: bigint; ratePerBlock: bigint; held: bigint; lpPending?: bigint };

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
  const info = data?.season;
  const phase = info?.phase ?? "preseason";
  const s1 = phase === "live" || phase === "ended" ? data?.s1 : undefined;
  // The board shown: Season 1's once it is live, the preseason's until then.
  const board: { accounts: BoardRow[]; total: bigint; totalRatePerBlock: bigint } | undefined = s1 ?? data;
  const me = account?.toLowerCase();
  const mine = me ? board?.accounts.find((a) => a.owner === me) : undefined;
  const minePre = me ? data?.accounts.find((a) => a.owner === me) : undefined;
  const rank = mine && board ? board.accounts.indexOf(mine) + 1 : undefined;
  const top = board?.accounts.slice(0, 10) ?? [];
  useEns(top.map((a) => a.owner));
  const liveMine = useLive(mine?.points ?? 0n, mine?.ratePerBlock ?? 0n, points.at, `${phase}:${me ?? ""}`);
  const liveTotal = useLive(board?.total ?? 0n, board?.totalRatePerBlock ?? 0n, points.at, `${phase}:total`);
  const testnet = r.config.chainId !== 1;
  // The preseason has stopped: pinned in config, or opened on chain with its block known.
  const preEnd = pointsConfig.endBlock ?? (phase !== "preseason" ? info?.openedBlock : undefined);
  const preClosed = preEnd !== undefined;
  const preseason = phase === "preseason" || phase === "scheduled";
  const counting = s1 ? phase === "live" : !preClosed;
  const now = Math.floor(Date.now() / 1000);
  const pot = info?.pot;
  const preShare = pointsConfig.preseasonShareBps;

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

  const estimate = (pts: bigint | undefined, total: bigint | undefined, share: number) =>
    pot !== undefined && pts !== undefined && total ? infer(pts, total, pot, share) : undefined;
  const mineEst =
    s1 && pot !== undefined
      ? (estimate(mine?.points, s1.total, 10_000 - preShare) ?? 0n) + (estimate(minePre?.points, data?.total, preShare) ?? 0n)
      : undefined;

  return (
    <>
      <div className="desk-col">
        {testnet && (
          <p className="notice" role="note">
            Preview on {r.config.network.name}. Testnet balances cost nothing to
            fake, so these points do not count. The season runs on mainnet.
          </p>
        )}
        {phase === "preseason" && (
          <p className="notice notice-warn points-notice" role="note">
            <strong>Season 1 is yet to start.</strong> The points earned so far count towards your preseason total,
            which will be a capped distribution. LP positions now earn only while the price is $0.99–$1.01 (future
            points only; past points unchanged).
          </p>
        )}
        {phase === "scheduled" && (
          <p className="notice notice-warn points-notice" role="note">
            <strong>Season 1 starts {utcDay(info!.start!)}</strong> (in {until(info!.start!, now)}). The preseason
            {preClosed ? ` closed at block ${preEnd!.toLocaleString("en-US")}` : " is closing"}: its wallets share{" "}
            {preShare / 100}% of the Season 1 pot. Nothing accrues until the start.
          </p>
        )}
        {phase === "live" && (
          <p className="notice points-notice" role="note">
            <strong>Season 1 is live</strong> until {utcDay(info!.end!)}. Holding earns 1 point a day; liquidity earns{" "}
            {pointsConfig.lpBps / 10_000}× only between $0.99 and $1.01, while the price is there.
          </p>
        )}
        {phase === "ended" && (
          <p className="notice points-notice" role="note">
            <strong>Season 1 has ended.</strong> The payout is computed from its published rules and claimed from the
            SeasonVault.
          </p>
        )}
        <div className="hero-stat">
          <span>
            {s1
              ? account ? "Your Season 1 points" : "Season 1 total"
              : preseason
                ? `${account ? "Your preseason points" : "Preseason total"}${preClosed ? " (final)" : ""}`
                : account ? "Your points" : "Season total"}
            <Info
              label="Points"
              text={
                s1
                  ? `Season 1: 1 point per imdUSD held per day in a wallet (EOA, EIP-7702 or Safe); ${pointsConfig.lpBps / 10_000}× on a peg-pool position's depth between $0.99 and $1.01 while the price is there, after a one-day hold; 3 days per imdUSD of debt repaid as a liquidator. Computed here with the reference code (points/season1.ts); the payout comes from the published rules.`
                  : preClosed
                    ? `Preseason points, counted from imdUSD's deployment to block ${preEnd!.toLocaleString("en-US")}, where governance opened Season 1. They no longer change; preseason wallets share ${preShare / 100}% of the Season 1 pot.`
                    : `Preseason points: 1 point for 1 imdUSD held for 1 day; imdUSD you provide to the imdUSD/USDC pool earns ${pointsConfig.lpBps / 10_000}×. They count towards a capped preseason distribution. The counter runs between blocks at your current holdings and settles each refresh.`
              }
            />
          </span>
          <strong aria-live="off">
            {points.loading && !data ? "Reading…" : fmtPoints(account ? liveMine : liveTotal)}
          </strong>
          <small>
            {account
              ? mine
                ? `${counting ? `+${perDay(mine.ratePerBlock)}/day · ` : ""}${(shareBps(mine.points, board!.total) / 100).toFixed(2)}% · #${rank} of ${board!.accounts.length}`
                : s1
                  ? "Hold imdUSD in a wallet or provide liquidity at the peg to earn"
                  : preClosed
                    ? "No preseason points for this wallet"
                    : "Hold imdUSD or provide it to the imdUSD/USDC pool to start earning"
              : board
                ? counting
                  ? `${board.accounts.length} earning · +${perDay(board.totalRatePerBlock)}/day`
                  : `${board.accounts.length} wallets`
                : ""}
          </small>
        </div>
        <Row
          label="Rates"
          info={`Holding: imdUSD in a wallet earns 1 point per imdUSD per day. Liquidity: an imdUSD/USDC pool position earns ${pointsConfig.lpBps / 10_000}x on its depth between $0.99 and $1.01, only while the pool price is in that band and inside the position's range (from block 26,206,625; before it, imdUSD deposited earned ${pointsConfig.lpBps / 10_000}x).`}
        >
          {pointsConfig.pegPools[r.config.chainId]
            ? `Hold 1 · LP ${pointsConfig.lpBps / 10_000} (at peg) / day`
            : "Hold 1 / day · no pool on this network"}
        </Row>
        {s1 ? (
          <>
            <Row label="Peg pool" info="Liquidity earns only while the pool price is between $0.99 and $1.01.">
              {s1.atPeg ? "At peg: liquidity earning" : "Off peg: liquidity not earning"}
            </Row>
            {account && mineEst !== undefined && (
              <Row
                label="Est. INFER"
                info={`If the season ended now: ${(10_000 - preShare) / 100}% of the ${pot !== undefined ? fmtInfer(pot) : ""} INFER pot by Season 1 points, plus ${preShare / 100}% by preseason points. It moves as everyone's points do.`}
              >
                {`≈ ${fmtInfer(mineEst)} INFER`}
              </Row>
            )}
            {account && mine?.lpPending && mine.lpPending > 0n ? (
              <Row label="Pending" info="Liquidity points vest one day after your last addition; removing liquidity before then forfeits them.">
                {`${display(mine.lpPending, pointsConfig.blocksPerDay)} points`}
              </Row>
            ) : null}
            <Row label="Preseason" info={`Final preseason points; preseason wallets share ${preShare / 100}% of the pot.`}>
              {account
                ? minePre
                  ? `${display(minePre.points, pointsConfig.blocksPerDay)} points`
                  : "none"
                : `${pot !== undefined ? fmtInfer((pot * BigInt(preShare)) / 10_000n) : "—"} INFER to ${data?.accounts.length ?? 0} wallets`}
            </Row>
            <Row label="Season 1" info="91 days from the start set on chain; the rules were committed when it opened.">
              {`${utcDay(info!.start!)} → ${utcDay(info!.end!)}`}
            </Row>
          </>
        ) : (
          <>
            <Row label="Liquidations" info="Each imdUSD of debt a liquidator repays earns this many days of holding.">
              {`${pointsConfig.liquidationCreditDays} days per imdUSD`}
            </Row>
            <Row
              label={preseason ? "Preseason" : "Counting"}
              info={
                preClosed
                  ? `Preseason points counted from imdUSD's deployment to the block shown and no longer change. INFER's seasons are opened on chain by governance, each with its own rules committed when it opens and published after it ends.`
                  : "Points count from imdUSD's deployment and are still counting. INFER's seasons are opened on chain by governance, each with its own rules committed when it opens and published after it ends."
              }
            >
              {data
                ? !preClosed
                  ? `Block ${data.startBlock.toLocaleString("en-US")} → live`
                  : `Blocks ${data.startBlock.toLocaleString("en-US")} → ${preEnd!.toLocaleString("en-US")}`
                : "—"}
            </Row>
            {account && minePre && !preClosed && (
              <Row label="You hold" info="Earning at the holding rate right now.">
                {`${display(minePre.held * BigInt(pointsConfig.blocksPerDay), pointsConfig.blocksPerDay)} imdUSD`}
              </Row>
            )}
            {account && minePre && minePre.lp > 0n && !preClosed && (
              <Row label="You provide" info="imdUSD you deposited into the imdUSD/USDC pool, earning the liquidity rate.">
                {`${display(minePre.lp * BigInt(pointsConfig.blocksPerDay), pointsConfig.blocksPerDay)} imdUSD`}
              </Row>
            )}
          </>
        )}
      </div>
      <div className="desk-col points-board">
        <div className="loan-columns points-columns" aria-hidden="true">
          <span>{s1 ? "Season 1 · top 10" : "Top 10 holders"}</span>
          <span>Points</span>
          <span>Share</span>
          <span>{counting ? "Per day" : ""}</span>
        </div>
        {board && !top.length ? (
          <p className="muted">
            {s1 ? "No Season 1 points yet." : "No imdUSD is held yet. Points start with the first mint."}
          </p>
        ) : (
          <ol className="loan-feed points-feed" aria-label="Points leaderboard">
            {top.map((a, i) => (
              <li key={a.owner} className={a.owner === me ? "selected-loan" : undefined}>
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
                <span>{(shareBps(a.points, board!.total) / 100).toFixed(2)}%</span>
                <span>{counting ? `+${perDay(a.ratePerBlock)}` : ""}</span>
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
