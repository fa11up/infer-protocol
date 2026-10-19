// The analytics page's readers: chain logs and reads turned into the series its panels draw. Everything comes from the
// same sources the terminal uses (config.ts runtime, history.ts logs, the peg pool scan in peg-logs.ts), plus
// IdentityMD's public /swarm for the size of the swarm. Each reader throws on its own so one panel can fail alone.
import { decodeEventLog, getAddress, parseAbi, type Address } from "viem";
import { S1_TOPICS, type RawLog } from "../../points/pool.ts";
import type { Runtime, Target } from "./config";
import { alignedWindows, history, limited, logClient, type ChainLog } from "./history";
import { ours } from "./names";
import { ETH_USD, POOL_MANAGER, SLOT0 } from "./market";
import { pegPoolScan } from "./peg-logs";
import { read, type Snapshot } from "./state";

/** IMD on mainnet, and IdentityMD's payment address: every paid request (API or Intake) lands there in IMD. */
export const IMD_TOKEN: Address = "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7";
export const SWARM_PAY_TO: Address = "0x4e0fa57bde726079356537e2f34d671e9f41adbc";
export const USDC_TOKEN: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const INFER_TOKEN: Address = "0x53d0eA0A685220718Dc6a0a6e4617194C6F37921";
const SWARM_API = "https://api.imd.fun/swarm";
/** Every request IdentityMD sells costs this much IMD (api.imd.fun/requests/capabilities). */
export const REQUEST_IMD = 0.5;

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const DAY = 86_400;
export const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(5, 10);

/* ---------- block times ---------- */

/** Block -> unix time, interpolated between headers read every 1,000 blocks (exact at each anchor, within seconds
 * between them). Anchors are kept per runtime, so a refresh reads only the new ones. */
const anchors = new WeakMap<Runtime, Map<number, number>>();
const SPACING = 1000;
export async function blockClock(r: Runtime, from: number, head: number): Promise<(block: number) => number> {
  let map = anchors.get(r);
  if (!map) anchors.set(r, (map = new Map()));
  const want: number[] = [];
  for (let b = Math.floor(from / SPACING) * SPACING; b < head; b += SPACING) if (!map.has(b)) want.push(b);
  want.push(head);
  const got = await Promise.all(want.map((b) => r.client.getBlock({ blockNumber: BigInt(b) })));
  got.forEach((blk) => map!.set(Number(blk.number), Number(blk.timestamp)));
  const keys = [...map.keys()].sort((a, b) => a - b);
  return (block: number) => {
    let lo = 0,
      hi = keys.length - 1;
    if (block <= keys[0]) return map!.get(keys[0])! - (keys[0] - block) * 12;
    if (block >= keys[hi]) return map!.get(keys[hi])! + (block - keys[hi]) * 12;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= block) lo = mid;
      else hi = mid;
    }
    const a = keys[lo],
      b = keys[hi],
      ta = map!.get(a)!,
      tb = map!.get(b)!;
    return Math.round(ta + ((tb - ta) * (block - a)) / (b - a));
  };
}

/* ---------- peg ---------- */

export type PegPoint = { t: number; price: number; block: number };
const priceAtTick = (tick: number) => Math.pow(1.0001, tick) * 1e12;
const signed = (w: bigint) => (w >= 1n << 255n ? w - (1n << 256n) : w);
const word = (data: string, i: number) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));

/** The pool's price after its Initialize and after every swap, in order. */
export async function pegHistory(r: Runtime, head: number): Promise<{ points: PegPoint[]; firstBlock: number }> {
  const logs = await pegPoolScan(r, head);
  if (!logs) throw Error("This deployment has no peg pool.");
  const priced = logs
    .filter((l) => {
      const t0 = l.topics[0]?.toLowerCase();
      return t0 === S1_TOPICS.initialize || t0 === S1_TOPICS.swap;
    })
    .sort(order);
  if (!priced.length) throw Error("The peg pool has no price yet.");
  const firstBlock = Number(BigInt(priced[0].blockNumber));
  const clock = await blockClock(r, firstBlock, head);
  const points = priced.map((l) => {
    const block = Number(BigInt(l.blockNumber));
    return { t: clock(block), price: priceAtTick(Number(signed(word(l.data, 4)))), block };
  });
  return { points, firstBlock };
}
const order = (a: RawLog, b: RawLog) => {
  const d = Number(BigInt(a.blockNumber) - BigInt(b.blockNumber));
  return d || Number(BigInt(a.logIndex === "0x" ? "0x0" : a.logIndex)) - Number(BigInt(b.logIndex === "0x" ? "0x0" : b.logIndex));
};

/** Seconds spent below `level`, the time-weighted average and the lowest price, between t0 and t1. */
export function pegStats(points: PegPoint[], t0: number, t1: number, level = 0.99) {
  let start = points[0]?.price ?? 1;
  for (const p of points) if (p.t <= t0) start = p.price;
  const inside = points.filter((p) => p.t > t0 && p.t <= t1);
  let below = 0,
    area = 0,
    cur = start,
    ct = t0,
    low = { t: t0, price: start };
  for (const p of inside) {
    if (cur < level) below += p.t - ct;
    area += cur * (p.t - ct);
    cur = p.price;
    ct = p.t;
    if (p.price < low.price) low = { t: p.t, price: p.price };
  }
  if (cur < level) below += t1 - ct;
  area += cur * (t1 - ct);
  return { start, inside, below, twap: area / Math.max(1, t1 - t0), low, now: cur };
}

/* ---------- feeds ---------- */

export type FeedUpdates = { name: string; times: number[]; maxAge: number };
function decodeAll(t: Target, logs: ChainLog[]) {
  const out: { log: ChainLog; name: string; args: Record<string, unknown> }[] = [];
  for (const log of logs) {
    try {
      const e = decodeEventLog({ abi: t.abi, data: log.data, topics: log.topics });
      out.push({ log, name: ours(String(e.eventName)), args: (e.args ?? {}) as Record<string, unknown> });
    } catch {
      /* a topic this ABI does not know is not data for these panels */
    }
  }
  return out;
}
/** When each feed's value was last set, from its ValueUpdated logs (`updatedAt`, the time the vault ages it by). */
export async function feedUpdates(r: Runtime, s: Snapshot): Promise<FeedUpdates[]> {
  const list: [string, string][] = [
    ["price", "PriceFeed"],
    ["spot", "SpotFeed"],
    ["health", "NhiFeed"],
  ];
  return Promise.all(
    list
      .filter(([, key]) => s.targets[key])
      .map(async ([name, key]) => {
        const t = s.targets[key];
        const h = await history(r, t, s.block);
        const times = decodeAll(t, h.logs)
          .filter((e) => e.name === "ValueUpdated")
          .map((e) => Number(e.args.updatedAt as bigint))
          .sort((a, b) => a - b);
        return { name, times, maxAge: Number(s.feeds[key]?.maxAge ?? 3600n) };
      }),
  );
}
/** The share of [t0, t1] during which a feed was fresh (its last value younger than maxAge). */
export function freshIntervals(f: FeedUpdates, t0: number, t1: number): { a: number; b: number; at: number }[] {
  return f.times
    .map((u, i) => ({ a: Math.max(u, t0), b: Math.min(u + f.maxAge, f.times[i + 1] ?? Infinity, t1), at: u }))
    .filter((x) => x.b > x.a);
}

/* ---------- vault, token and settings events ---------- */

export type VaultEvent = { t: number; block: number; tx: string; name: string; who?: Address; amount?: bigint; by?: Address };
export async function vaultEvents(r: Runtime, s: Snapshot): Promise<VaultEvent[]> {
  const t = s.targets.ParameterizedVault;
  const h = await history(r, t, s.block);
  const clock = await blockClock(r, Number(h.from), Number(s.block));
  return decodeAll(t, h.logs).map(({ log, name, args }) => {
    const who = (args.account ?? args.owner ?? args.redeemer) as Address | undefined;
    const amount = (args.amount ?? args.debtRepaid ?? args.burned) as bigint | undefined;
    const block = Number(log.blockNumber);
    return { t: clock(block), block, tx: log.transactionHash, name, who: who && getAddress(who), amount, by: args.liquidator as Address | undefined };
  });
}

export type SupplyDay = { day: string; supply: number; minted: number; burned: number };
export type Holder = { address: Address; balance: number };
const ZERO = "0x0000000000000000000000000000000000000000";
/** imdUSD's supply at each day's end, and every holder's balance now, from its Transfer logs. */
export async function tokenLedger(r: Runtime, s: Snapshot): Promise<{ days: SupplyDay[]; holders: Holder[]; supply: number }> {
  const t = s.targets.stablecoin;
  const h = await history(r, t, s.block);
  const clock = await blockClock(r, Number(h.from), Number(s.block));
  const bal = new Map<string, bigint>();
  const days = new Map<string, SupplyDay>();
  let supply = 0n;
  for (const l of h.logs) {
    if (l.topics[0]?.toLowerCase() !== S1_TOPICS.transfer || l.topics.length < 3) continue;
    const from = "0x" + l.topics[1]!.slice(-40),
      to = "0x" + l.topics[2]!.slice(-40),
      v = BigInt(l.data);
    const d = dayOf(clock(Number(l.blockNumber)));
    const row = days.get(d) ?? { day: d, supply: 0, minted: 0, burned: 0 };
    if (from === ZERO) {
      supply += v;
      row.minted += Number(v) / 1e18;
    } else bal.set(from, (bal.get(from) ?? 0n) - v);
    if (to === ZERO) {
      supply -= v;
      row.burned += Number(v) / 1e18;
    } else bal.set(to, (bal.get(to) ?? 0n) + v);
    row.supply = Number(supply) / 1e18;
    days.set(d, row);
  }
  // Days with no transfer still have a supply: carry the last one forward to today.
  const out: SupplyDay[] = [];
  const first = clock(Number(h.from));
  let last = 0;
  for (let t0 = Math.floor(first / DAY) * DAY; t0 <= Number(s.timestamp); t0 += DAY) {
    const d = dayOf(t0);
    const row = days.get(d);
    if (row) last = row.supply;
    if (row || out.length) out.push(row ?? { day: d, supply: last, minted: 0, burned: 0 });
  }
  const holders = [...bal]
    .filter(([, v]) => v > 0n)
    .map(([a, v]) => ({ address: getAddress(a), balance: Number(v) / 1e18 }))
    .sort((a, b) => b.balance - a.balance);
  return { days: out, holders, supply: Number(supply) / 1e18 };
}

export type SettingEvent = { t: number; block: number; tx: string; name: string; payload?: `0x${string}`; detail?: string };
/** Parameters' Proposed / Applied / Cancelled and the Treasury's reserve-asset changes. */
export async function settingEvents(r: Runtime, s: Snapshot): Promise<SettingEvent[]> {
  const out: SettingEvent[] = [];
  for (const key of ["parameters", "treasury"]) {
    const t = s.targets[key];
    if (!t) continue;
    const h = await history(r, t, s.block);
    const clock = await blockClock(r, Number(h.from), Number(s.block));
    for (const { log, name, args } of decodeAll(t, h.logs)) {
      if (!["Proposed", "Applied", "Cancelled", "ReserveAssetSet", "ReserveAssetRemoved"].includes(name)) continue;
      const block = Number(log.blockNumber);
      const bps = args.haircutBps as bigint | undefined;
      out.push({
        t: clock(block),
        block,
        tx: log.transactionHash,
        name,
        payload: args.payload as `0x${string}` | undefined,
        detail: name === "ReserveAssetSet" ? `reserve asset listed${bps !== undefined ? `, counted at ${Number(bps) / 100}%` : ""}` : undefined,
      });
    }
  }
  return out;
}

/* ---------- floor, treasury ---------- */

export type Floor = { payoutPrice: bigint; attested: bigint; feeBps: bigint; backing: bigint };
export async function readFloor(r: Runtime, s: Snapshot): Promise<Floor> {
  const vault = s.targets.ParameterizedVault;
  const [payoutPrice, feeBps] = (await Promise.all([
    read(r, vault, "payoutPrice", [], s.block),
    read(r, vault, "redemptionFeeBps", [1000n * 10n ** 18n], s.block),
  ])) as [bigint, bigint];
  return { payoutPrice, attested: s.feeds.Collateral?.value ?? 0n, feeBps, backing: (s.v.backingPerUnit as bigint | undefined) ?? 10n ** 18n };
}
/** One imdUSD's worth if redeemed now, in dollars at the IMD market price: the vault pays sIMD at the higher of its
 * attested and paced payout prices, scaled by backing (at most $1), less the fee. */
export function redemptionValue(f: Floor, marketImdUsd: bigint, attestedImdUsd: bigint | undefined): number | undefined {
  if (!f.attested || !attestedImdUsd) return undefined;
  const paid = f.payoutPrice > f.attested ? f.payoutPrice : f.attested;
  const marketShare = (Number(f.attested) * Number(marketImdUsd)) / Number(attestedImdUsd);
  return (Number(f.backing) / 1e18) * (1 - Number(f.feeBps) / 10_000) * (marketShare / Number(paid));
}

/* ---------- redemption value over time ---------- */

// The same figure as `redemptionValue`, at past blocks. The vault emits nothing when its paced payout price moves, so
// it is sampled: one Multicall3 eth_call per sample (the vault's payout price, fee and backing, the two feeds, IMD's
// pool and Chainlink ETH/USD as market.ts reads them now), hourly for the last three days and every four hours before.
// A sample at a closed block never changes, so each is kept in the browser and a revisit reads only the new ones.
const SAMPLE_ABI = parseAbi([
  "function payoutPrice() view returns (uint256)",
  "function redemptionFeeBps(uint256) view returns (uint256)",
  "function backingPerUnit() view returns (uint256)",
  "function latestValue() view returns (uint256, uint256)",
  "function extsload(bytes32) view returns (bytes32)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
export type RedeemPoint = { t: number; value: number; block: number };
const BLOCKS_PER_HOUR = 300;

/** Sample blocks in [from, head): every 4 hours, then hourly over the last 3 days, on fixed multiples so they repeat. */
export function redemptionSampleBlocks(from: number, head: number): number[] {
  const out: number[] = [];
  const coarse = 4 * BLOCKS_PER_HOUR;
  const recent = head - 72 * BLOCKS_PER_HOUR;
  for (let b = Math.ceil(from / coarse) * coarse; b < recent; b += coarse) out.push(b);
  for (let b = Math.ceil(Math.max(from, recent) / BLOCKS_PER_HOUR) * BLOCKS_PER_HOUR; b < head; b += BLOCKS_PER_HOUR) out.push(b);
  return out;
}

export async function redemptionHistory(r: Runtime, s: Snapshot, from: number): Promise<RedeemPoint[]> {
  const vault = s.targets.ParameterizedVault.address;
  const usd = s.targets.usdPriceFeed?.address;
  const col = (s.targets.collateralPriceFeed ?? s.targets.usdPriceFeed)?.address;
  if (!usd || !col || r.config.chainId !== 1) throw Error("Redemption history is read on mainnet only.");
  const head = Number(s.block);
  const blocks = redemptionSampleBlocks(from, head);
  const key = `an-redeem:${vault.toLowerCase()}`;
  let kept: Record<string, number | null> = {};
  try {
    kept = JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    /* no storage: every sample is read */
  }
  const call = (address: Address, functionName: string, args: readonly unknown[] = []) => ({ address, abi: SAMPLE_ABI, functionName, args });
  // null: the figure did not exist at that block (a feed unreadable, the vault not deployed yet).
  const sample = async (b: number): Promise<number | null> => {
    const res: { status: string; result?: unknown }[] = await r.archive.multicall({
      allowFailure: true,
      blockNumber: BigInt(b),
      contracts: [
        call(vault, "payoutPrice"),
        call(vault, "redemptionFeeBps", [1000n * 10n ** 18n]),
        call(vault, "backingPerUnit"),
        call(col, "latestValue"),
        call(usd, "latestValue"),
        call(POOL_MANAGER, "extsload", [SLOT0]),
        call(ETH_USD, "latestRoundData"),
      ] as never,
    } as never);
    if (res.some((x: { status: string }) => x.status !== "success")) return null;
    const [payout, fee, backing, colV, usdV, word, round] = res.map((x: { result?: unknown }) => x.result) as [
      bigint,
      bigint,
      bigint,
      readonly [bigint, bigint],
      readonly [bigint, bigint],
      `0x${string}`,
      readonly [bigint, bigint],
    ];
    const sqrt = BigInt(word) & ((1n << 160n) - 1n);
    if (!sqrt || round[1] <= 0n) return null;
    const imdUsd = ((((10n ** 18n) << 192n) / (sqrt * sqrt)) * round[1]) / 10n ** 8n;
    const v = redemptionValue({ payoutPrice: payout, attested: colV[0], feeBps: fee, backing }, imdUsd, usdV[0]);
    return v === undefined || !Number.isFinite(v) ? null : v;
  };
  const got = await Promise.all(
    blocks.map(async (b): Promise<[number, number | null | undefined]> => {
      if (b in kept) return [b, kept[b]];
      try {
        return [b, await limited(r, () => sample(b))];
      } catch {
        return [b, undefined]; // refused: read again on the next visit
      }
    }),
  );
  const closed = head - 64;
  for (const [b, v] of got) if (v !== undefined && b <= closed) kept[b] = v;
  try {
    localStorage.setItem(key, JSON.stringify(kept));
  } catch {
    /* not kept */
  }
  const points = got.filter((x): x is [number, number] => typeof x[1] === "number");
  if (!points.length) throw Error("No redemption value could be read.");
  const clock = await blockClock(r, points[0][0], head);
  return points.map(([b, value]) => ({ t: clock(b), value, block: b }));
}

export type TreasuryHolding = { symbol: string; amount: number; usd?: number };
export async function treasuryHoldings(r: Runtime, s: Snapshot, marketImdUsd?: bigint): Promise<TreasuryHolding[]> {
  const t = s.targets.treasury;
  if (!t) throw Error("This deployment has no Treasury.");
  const gemDecimals = Number(s.v.gemDecimals ?? 18);
  const bal = (token: Address) => r.client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [t.address], blockNumber: s.block }) as Promise<bigint>;
  // IMD, USDC and INFER are mainnet addresses: on any other chain the Treasury's own sIMD and imdUSD are all there is.
  const mainnet = r.config.chainId === 1;
  const [simd, imdusd, imd, usdc, infer] = await Promise.all([
    bal(s.targets.gem.address),
    bal(s.targets.stablecoin.address),
    ...(mainnet ? [bal(IMD_TOKEN), bal(USDC_TOKEN), bal(INFER_TOKEN)] : []),
  ]);
  const col = s.feeds.Collateral?.value;
  const imdUsd = marketImdUsd ? Number(marketImdUsd) / 1e18 : undefined;
  if (!mainnet)
    return [
      { symbol: "sIMD, the redemption reserve", amount: Number(simd) / 10 ** gemDecimals, usd: col !== undefined ? Number((simd * col) / 10n ** 18n) / 1e18 : undefined },
      { symbol: "imdUSD, from stability fees", amount: Number(imdusd) / 1e18, usd: Number(imdusd) / 1e18 },
    ];
  return [
    { symbol: "sIMD, the redemption reserve", amount: Number(simd) / 10 ** gemDecimals, usd: col !== undefined ? Number((simd * col) / 10n ** 18n) / 1e18 : undefined },
    { symbol: "IMD", amount: Number(imd) / 1e18, usd: imdUsd !== undefined ? (Number(imd) / 1e18) * imdUsd : undefined },
    { symbol: "imdUSD, from stability fees", amount: Number(imdusd) / 1e18, usd: Number(imdusd) / 1e18 },
    { symbol: "USDC", amount: Number(usdc) / 1e6, usd: Number(usdc) / 1e6 },
    { symbol: "INFER", amount: Number(infer) / 1e18 },
  ];
}

/* ---------- the swarm ---------- */

export type SwarmDay = { day: string; requests: number; imd: number };
export type Swarm = { online?: number; enrolled?: number; days: SwarmDay[] };
/** Agents online from IdentityMD's /swarm; paid requests per day from IMD transfers into its payment address over the
 * last seven full days (eth_getLogs on IMD, filtered by recipient, in the aligned windows /rpc caches). */
export async function readSwarm(r: Runtime, s: Snapshot): Promise<Swarm> {
  const head = Number(s.block);
  const today = Math.floor(Number(s.timestamp) / DAY) * DAY;
  const from = head - 8 * 7200;
  const health = fetch(SWARM_API)
    .then((x) => (x.ok ? x.json() : undefined))
    .then((d) => (d?.health ?? d) as { agentsOnline?: number; seatsEnrolled?: number } | undefined)
    .catch(() => undefined);
  // The history windows (aligned, so closed ones are cache-identical at /rpc); the days outside the week are dropped.
  const windows = alignedWindows(BigInt(from), BigInt(head)).map(([a, b]) => [Number(a), Number(b)] as const);
  const byDay = new Map<string, SwarmDay>();
  for (let t0 = today - 7 * DAY; t0 < today; t0 += DAY) byDay.set(dayOf(t0), { day: dayOf(t0), requests: 0, imd: 0 });
  const add = (t: number, imd: number) => {
    const row = byDay.get(dayOf(t));
    if (!row) return;
    row.imd += imd;
    row.requests += Math.max(1, Math.round(imd / REQUEST_IMD));
  };
  // IdentityMD takes payment on Ethereum mainnet: elsewhere only the swarm's size is shown.
  if (r.config.chainId !== 1) {
    const h0 = await health;
    if (!h0) throw Error("IdentityMD's /swarm did not answer.");
    return { online: h0.agentsOnline, enrolled: h0.seatsEnrolled, days: [] };
  }
  const topic = "0x" + SWARM_PAY_TO.slice(2).toLowerCase().padStart(64, "0");
  const viaRpc = await Promise.all(
    windows.map(([a, b]) =>
      limited(
        r,
        () =>
          logClient(r).request({
            method: "eth_getLogs",
            params: [{ address: IMD_TOKEN, topics: [S1_TOPICS.transfer as `0x${string}`, null, topic as `0x${string}`], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }],
          }) as Promise<RawLog[]>,
      ),
    ),
  ).catch(() => undefined);
  if (viaRpc) {
    const clock = await blockClock(r, from, head);
    // The open window can reach back over the closed one before it: a transfer read twice counts once.
    const unique = new Map(viaRpc.flat().map((l) => [`${l.transactionHash}:${BigInt(l.logIndex)}`, l]));
    for (const l of unique.values()) if (Number(BigInt(l.blockNumber)) >= from) add(clock(Number(BigInt(l.blockNumber))), Number(BigInt(l.data)) / 1e18);
  } else {
    // A public RPC that refuses week-old log ranges (imdusd.com's /rpc serves them; local and fallback hosts may not):
    // read the same transfers from Blockscout's token-transfer list for the payment address, newest first.
    for (const t of await explorerTransfers(today - 7 * DAY)) add(t.t, t.imd);
  }
  const h = await health;
  return { online: h?.agentsOnline, enrolled: h?.seatsEnrolled, days: [...byDay.values()] };
}

/** IMD transfers into the payment address since `since`, from Blockscout (the swarm strip's fallback). */
async function explorerTransfers(since: number): Promise<{ t: number; imd: number }[]> {
  const base = `https://eth.blockscout.com/api/v2/addresses/${SWARM_PAY_TO}/token-transfers`;
  const out: { t: number; imd: number }[] = [];
  let next: Record<string, string> | undefined;
  for (let page = 0; page < 60; page++) {
    const q = new URLSearchParams({ type: "ERC-20", filter: "to", token: IMD_TOKEN, ...(next ?? {}) });
    const res = await fetch(`${base}?${q}`);
    if (!res.ok) throw Error(`Blockscout answered ${res.status}`);
    const d = (await res.json()) as { items: { timestamp: string; total?: { value: string; decimals: string } }[]; next_page_params?: Record<string, string> | null };
    for (const it of d.items) {
      const t = Math.floor(Date.parse(it.timestamp) / 1000);
      if (t < since) return out;
      out.push({ t, imd: Number(it.total?.value ?? 0) / 10 ** Number(it.total?.decimals ?? 18) });
    }
    if (!d.next_page_params) return out;
    next = Object.fromEntries(Object.entries(d.next_page_params).map(([k, v]) => [k, String(v)]));
  }
  return out;
}
