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
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error || body.result === undefined) throw Error(`rpc ${method}: ${body.error?.message ?? "no result"}`);
  return body.result;
}

const through = Number(BigInt(await rpcCall("eth_blockNumber", [])));
const startBlock = Number(opt("start"));
const endBlock = Number(opt("end", String(through)));

// Token transfers + liquidations (as in the preseason), and vault debt (rule 5).
const [tokenLogs, vaultLogs] = await Promise.all([fetchLogs(chain.blockscout, stablecoin!), fetchLogs(chain.blockscout, vault!)]);
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
const poolQ = (topic0: string) => fetchFilteredLogs(chain.blockscout, { address: chain.poolManager, topic0, topic1: peg.id, fromBlock: peg.fromBlock, toBlock: through });
// Sequential on purpose: keyless Blockscout rate-limits parallel bursts.
// The pool is initialised exactly once, at peg.fromBlock: ask for that block only (cheap, and a wrong
// fromBlock in chains.ts shows up as "expected exactly one Initialize").
const init = await fetchFilteredLogs(chain.blockscout, { address: chain.poolManager, topic0: S1_TOPICS.initialize, topic1: peg.id, fromBlock: peg.fromBlock, toBlock: peg.fromBlock });
const swaps = await poolQ(S1_TOPICS.swap);
const mods = await poolQ(S1_TOPICS.modifyLiquidity);
if (init.length !== 1) throw Error(`expected exactly one Initialize for the peg pool, got ${init.length}: refusing to guess the price`);
if (!mods.length) throw Error("no liquidity logs for the peg pool: refusing to report that nobody provided any");
const pool = poolEvents([...init, ...swaps, ...mods], peg.positionManager);
events.push(...pool.events);
for (const id of pool.tokenIds) {
  const topic3 = "0x" + id.toString(16).padStart(64, "0");
  const t = await fetchFilteredLogs(chain.blockscout, { address: peg.positionManager, topic0: S1_TOPICS.transfer, topic3, fromBlock: peg.fromBlock, toBlock: through });
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
