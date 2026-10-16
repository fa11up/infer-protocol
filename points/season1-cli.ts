#!/usr/bin/env node
// Season 1 leaderboard (rules in season1.ts).
//
//   node points/season1-cli.ts --stablecoin 0x.. --vault 0x.. --start <block> [--end <block>] [--allow 0x..,0x..]
//                              [--lp-x 3] [--rpc <url>] [--out season1.json]
//
// Reads everything from Blockscout (never a public RPC's eth_getLogs); the RPC is used only for the latest block
// number and for classifying addresses by their code at that block (wallets earn, contracts do not, rule 1).
import { writeFileSync } from "node:fs";
import { computeSeason1, type S1Event } from "./season1.ts";
import { display, shareBps } from "./engine.ts";
import { decodeLog, fetchLogs, fetchFilteredLogs } from "./logs.ts";
import { poolEvents, nftOwnerEvents, debtEvents, isWalletCode, S1_TOPICS, type RawLog } from "./pool.ts";
import { CHAINS, PEG_POOLS } from "./chains.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const isAddr = (a?: string) => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const stablecoin = opt("stablecoin")?.toLowerCase();
const vault = opt("vault")?.toLowerCase();
const chainName = opt("chain", "ethereum")!;
const chain = CHAINS[chainName];
const peg = PEG_POOLS[chainName];
const rpc = opt("rpc", process.env.RPC_URL ?? "https://eth.drpc.org")!;
if (!isAddr(stablecoin) || !isAddr(vault) || !chain || !peg || !opt("start")) {
  console.error("usage: node points/season1-cli.ts --stablecoin 0x.. --vault 0x.. --start N [--end N] [--allow 0x..] [--lp-x 3] [--rpc url] [--out file]");
  process.exit(1);
}

async function rpcCall(method: string, params: unknown[]): Promise<any> {
  // A free RPC throttles: back off and retry a few times before giving up (never on a definite error).
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (body.error || body.result === undefined) throw Error(`rpc ${method}: ${body.error?.message ?? "no result"}`);
      return body.result;
    } catch (e) {
      if (attempt >= 4 || !/429|rate|limit exceeded|timeout|fetch failed|too many/i.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

const through = Number(BigInt(await rpcCall("eth_blockNumber", [])));

/** Filtered eth_getLogs in 5,000-block chunks (free RPCs refuse 10,000 inclusive; fallback only; callers check
 * the result is non-empty). */
const CHUNK = 5_000;
async function rpcLogs(address: string, topics: (string | null)[], from: number, to: number): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let b = from; b <= to; b += CHUNK) {
    const hi = Math.min(b + CHUNK - 1, to);
    const logs = (await rpcCall("eth_getLogs", [{ address, topics, fromBlock: "0x" + b.toString(16), toBlock: "0x" + hi.toString(16) }])) as RawLog[];
    out.push(...logs);
  }
  return out;
}
/** Etherscan v2 getLogs (an archive source, keyed by ETHERSCAN_API_KEY): pages of up to 1,000, advancing from the
 * last block seen and dropping the repeats, until a short page. Used when Blockscout refuses, before the RPC. */
const etherscanKey = process.env.ETHERSCAN_API_KEY;
async function etherscanLogs(address: string, topics: (string | null)[], from: number, to: number): Promise<RawLog[]> {
  if (!etherscanKey) throw Error("no ETHERSCAN_API_KEY");
  const seen = new Map<string, RawLog>();
  for (let b = from; b <= to; ) {
    const q = new URLSearchParams({ chainid: "1", module: "logs", action: "getLogs", address, fromBlock: String(b), toBlock: String(to), page: "1", offset: "1000", apikey: etherscanKey });
    topics.forEach((t, i) => t && q.set(`topic${i}`, t));
    for (let i = 1; i < topics.length; i++) if (topics[i]) q.set(`topic0_${i}_opr`, "and");
    let body: { status: string; message: string; result: RawLog[] | string } | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      body = await (await fetch(`https://api.etherscan.io/v2/api?${q}`)).json();
      if (body!.status === "1" || /No records/.test(body!.message)) break;
      if (!/rate limit/i.test(String(body!.result))) throw Error(`etherscan: ${body!.message} ${String(body!.result).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
    const page = Array.isArray(body!.result) ? body!.result : [];
    for (const l of page) seen.set(`${l.transactionHash}:${Number(BigInt(l.logIndex))}`, l);
    if (page.length < 1000) break;
    const last = Number(BigInt(page[page.length - 1].blockNumber));
    if (last === b) throw Error(`etherscan: over 1,000 logs in block ${b}`);
    b = last; // the last block may be split across pages: read it again; repeats are dropped
  }
  return [...seen.values()];
}
const archiveLogs = async (address: string, topics: (string | null)[], from: number, to: number): Promise<RawLog[]> => {
  try {
    return await etherscanLogs(address, topics, from, to);
  } catch (err) {
    console.error(`  ${address.slice(0, 10)}: ${(err as Error).message}; trying the RPC`);
    return rpcLogs(address, topics, from, to);
  }
};
const startBlock = Number(opt("start"));
const endBlock = Number(opt("end", String(through)));

// Token transfers + liquidations (as in the preseason), and vault debt (rule 5).
type V2Item = { topics: (string | null)[]; data: string; block_number: number | string; index: number | string; transaction_hash?: string };
const fromRaw = (l: RawLog): V2Item => ({ topics: l.topics, data: l.data, block_number: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex)), transaction_hash: l.transactionHash });
async function addressLogs(address: string, from: number): Promise<V2Item[]> {
  try {
    return await fetchLogs(chain.blockscout, address);
  } catch (err) {
    console.error(`  ${address}: ${(err as Error).message}; reading its logs from Etherscan instead`);
    return (await archiveLogs(address, [], from, through)).map(fromRaw);
  }
}
const tokenLogs = await addressLogs(stablecoin!, 26_166_000);
const vaultLogs = await addressLogs(vault!, 26_166_000);
const asRaw = (l: { topics: (string | null)[]; data: string; block_number: number | string; index: number | string }): RawLog => ({
  topics: l.topics.filter((t): t is string => !!t),
  data: l.data,
  blockNumber: String(l.block_number),
  logIndex: String(l.index),
});
const events: S1Event[] = [];
for (const l of [...tokenLogs, ...vaultLogs]) {
  const e = decodeLog(l);
  if (e?.kind === "transfer" || e?.kind === "bite") events.push(e as S1Event);
}
events.push(...debtEvents(vaultLogs.map(asRaw)));

// The peg pool: price and liquidity (rules 2-4), then the owners of its PositionManager positions.
const poolQ = async (topic0: string, from = peg.fromBlock, to = through): Promise<RawLog[]> => {
  try {
    return await fetchFilteredLogs(chain.blockscout, { address: chain.poolManager, topic0, topic1: peg.id, fromBlock: from, toBlock: to });
  } catch (err) {
    console.error(`  pool ${topic0.slice(0, 10)}: ${(err as Error).message}; reading from Etherscan instead`);
    return archiveLogs(chain.poolManager, [topic0, peg.id], from, to);
  }
};
// Sequential on purpose: keyless Blockscout rate-limits parallel bursts.
// The pool is initialised exactly once, at peg.fromBlock: ask for that block only (cheap, and a wrong
// fromBlock in chains.ts shows up as "expected exactly one Initialize").
const init = await poolQ(S1_TOPICS.initialize, peg.fromBlock, peg.fromBlock);
const swaps = await poolQ(S1_TOPICS.swap);
const mods = await poolQ(S1_TOPICS.modifyLiquidity);
if (init.length !== 1) throw Error(`expected exactly one Initialize for the peg pool, got ${init.length}: refusing to guess the price`);
if (!mods.length) throw Error("no liquidity logs for the peg pool: refusing to report that nobody provided any");
const pool = poolEvents([...init, ...swaps, ...mods], peg.positionManager);
events.push(...pool.events);

// CONTROLS against a source that silently drops logs: the replay must land where the chain is.
const lastTick = [...pool.events].filter((e) => e.kind === "price").sort((a, b) => a.block - b.block || a.logIndex - b.logIndex).pop();
const slot0 = (await rpcCall("eth_call", [{ to: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227", data: "0xc815641c" + peg.id.slice(2) }, "0x" + through.toString(16)])) as string;
const tickNow = Number(BigInt.asIntN(24, BigInt("0x" + slot0.slice(2 + 64, 2 + 128))));
if (!lastTick || (lastTick as { tick: number }).tick !== tickNow) throw Error(`pool replay ends at tick ${(lastTick as { tick?: number })?.tick}, the chain says ${tickNow}: swap logs are incomplete`);
const supplyHex = (await rpcCall("eth_call", [{ to: stablecoin, data: "0x18160ddd" }, "0x" + through.toString(16)])) as string;
let minted = 0n;
for (const e of events) if (e.kind === "transfer" && e.block <= through) {
  if (e.from === "0x0000000000000000000000000000000000000000") minted += e.value;
  if (e.to === "0x0000000000000000000000000000000000000000") minted -= e.value;
}
if (minted !== BigInt(supplyHex)) throw Error(`replayed imdUSD supply ${minted} != totalSupply ${BigInt(supplyHex)}: transfer logs are incomplete`);
for (const id of pool.tokenIds) {
  const topic3 = "0x" + id.toString(16).padStart(64, "0");
  let t: RawLog[];
  try {
    t = await fetchFilteredLogs(chain.blockscout, { address: peg.positionManager, topic0: S1_TOPICS.transfer, topic3, fromBlock: peg.fromBlock, toBlock: through });
  } catch (err) {
    // Blockscout refused (rate limit). Fall back to Etherscan, then the RPC. The silent-empty risk of a public RPC
    // is covered by the check below: every position has at least its mint log.
    console.error(`  position #${id}: ${(err as Error).message}; reading its transfers from Etherscan instead`);
    t = await archiveLogs(peg.positionManager, [S1_TOPICS.transfer, null, null, topic3], peg.fromBlock, through);
  }
  if (!t.length) throw Error(`no mint/transfer logs for position #${id}: refusing to guess its owner`);
  await new Promise((r) => setTimeout(r, 400));
  events.push(...nftOwnerEvents(t));
}

// Rule 1: classify every address that could earn by its code at `through`.
const candidates = new Set<string>();
for (const e of events) {
  if (e.kind === "transfer") candidates.add(e.from.toLowerCase()), candidates.add(e.to.toLowerCase());
  if (e.kind === "owner" || e.kind === "debt") candidates.add(e.owner.toLowerCase());
  if (e.kind === "bite") candidates.add(e.liquidator.toLowerCase());
}
candidates.delete("0x0000000000000000000000000000000000000000");
const allow = new Set((opt("allow", "") ?? "").split(",").filter(isAddr).map((a) => a.toLowerCase()));
const contracts: string[] = [];
const blockTag = "0x" + through.toString(16);
for (const a of candidates) {
  const code = (await rpcCall("eth_getCode", [a, blockTag])) as string;
  if (!isWalletCode(code) && !allow.has(a)) contracts.push(a);
}

const season = {
  startBlock,
  endBlock,
  blocksPerDay: chain.blocksPerDay,
  bandLower: peg.bandLower,
  bandUpper: peg.bandUpper,
  token1Scale: peg.token1Scale,
  lpBps: Math.round(Number(opt("lp-x", "3")) * 10_000),
  dataThroughBlock: through,
  netDebt: args.includes("--net-debt"),
  excluded: [vault!, chain.poolManager, ...contracts],
};
const r = computeSeason1(events, season);
const d = (x: bigint) => display(x, chain.blocksPerDay);
const out = {
  chain: chainName,
  rules: "season1 (points/season1.ts)",
  season: { ...season, token1Scale: season.token1Scale.toString() },
  pool: { id: peg.id, tickNow: r.tick, atPeg: r.atPeg },
  excludedContracts: contracts,
  totalPoints: d(r.total),
  accounts: r.accounts.map((a) => ({
    owner: a.owner,
    points: d(a.points),
    shareBps: shareBps(a.points, r.total),
    hold: d(a.holdPoints),
    lp: d(a.lpPoints),
    lpPending: d(a.lpPending),
    liquidation: d(a.liquidationPoints),
    heldNow: a.held.toString(),
    debtNow: a.debt.toString(),
    perDayNow: d(a.ratePerBlock * BigInt(chain.blocksPerDay)),
  })),
};
const file = opt("out", "season1.json")!;
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.error(`season 1: blocks ${startBlock}..${Math.min(endBlock, through)}, ${events.length} events, ${contracts.length} contracts excluded, pool tick ${r.tick} (${r.atPeg ? "at peg" : "OFF PEG: no liquidity earns"}), ${out.totalPoints} points -> ${file}`);
for (const a of out.accounts.slice(0, 12)) console.error(`  ${a.owner}  ${a.points.padStart(14)}  ${(a.shareBps / 100).toFixed(2).padStart(6)}%  hold ${a.hold}  lp ${a.lp} (+${a.lpPending} pending)  +${a.perDayNow}/day`);
