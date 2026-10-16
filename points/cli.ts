#!/usr/bin/env node
// Genesis points leaderboard.
//
//   node points/cli.ts --stablecoin 0x.. --vault 0x.. [--chain ethereum] [--exclude 0x..,0x..]
//                      [--start <block>] [--end <block>] [--lp-x 3] [--credit-days 3] [--out points.json]
//                      [--lp-switch <block> [--rpc <url>]]
//
// --lp-switch: from that block liquidity earns by Season 1's reader (points/preseason.ts), as the terminal does
// from pointsConfig.lpSwitchBlock (26206625). Holding is unchanged.
//
// --start defaults to the stablecoin's first log, --end to the latest log, so a run mid-season is a
// live leaderboard. The vault and the chain's v4 PoolManager are always excluded; pass the Treasury
// (and any other protocol contract that holds imdUSD) with --exclude.
//
// Liquidity: imdUSD deposited into the chain's peg pool less what was withdrawn (lp.ts), from the token's own
// transfers to and from the PoolManager in transactions that carry the pool's ModifyLiquidity.
import { writeFileSync } from "node:fs";
import { computePoints, display, shareBps, DEFAULTS } from "./engine.ts";
import { decodeLog, fetchLogs, liquidityTxs } from "./logs.ts";
import { lpEvents } from "./lp.ts";
import { CHAINS, PEG_POOLS } from "./chains.ts";
import { computePreseason } from "./preseason.ts";
import { readPegPool } from "./poolread.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const isAddr = (a?: string) => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
const stablecoin = opt("stablecoin");
const vault = opt("vault");
const chainName = opt("chain", "ethereum")!;
const chain = CHAINS[chainName];
if (!isAddr(stablecoin) || !isAddr(vault) || !chain) {
  console.error("usage: node points/cli.ts --stablecoin 0x.. --vault 0x.. [--chain ethereum|sepolia] [--exclude 0x..] [--start N] [--end N] [--lp-x 3] [--credit-days 3] [--out file]");
  process.exit(1);
}
const excluded = [vault!, chain.poolManager, ...(opt("exclude", "")!.split(",").filter(isAddr))];

const [tokenLogs, vaultLogs] = await Promise.all([fetchLogs(chain.blockscout, stablecoin!), fetchLogs(chain.blockscout, vault!)]);
const events = [...tokenLogs, ...vaultLogs].map(decodeLog).filter((e) => e !== null);
if (chain.pegPool) {
  const pm = chain.poolManager.toLowerCase();
  const transfers = tokenLogs.flatMap((l) => {
    const e = decodeLog(l);
    return e?.kind === "transfer" && l.transaction_hash ? [{ from: e.from, to: e.to, value: e.value, block: e.block, logIndex: e.logIndex, tx: l.transaction_hash }] : [];
  });
  const candidates = [...new Set(transfers.filter((t) => t.from === pm || t.to === pm).map((t) => t.tx))];
  events.push(...lpEvents(transfers, await liquidityTxs(chain.blockscout, candidates, chain.pegPool), pm));
}
const blocks = tokenLogs.map((l) => Number(l.block_number));
const startBlock = Number(opt("start", String(Math.min(...blocks))));
const endBlock = Number(opt("end", String(Math.max(...blocks, ...vaultLogs.map((l) => Number(l.block_number))))));
const season = {
  startBlock,
  endBlock,
  blocksPerDay: chain.blocksPerDay,
  lpBps: Math.round(Number(opt("lp-x", String(DEFAULTS.lpBps / 10_000))) * 10_000),
  liquidationCreditDays: Number(opt("credit-days", String(DEFAULTS.liquidationCreditDays))),
  excluded,
};
const lpSwitch = opt("lp-switch");
let r;
if (lpSwitch !== undefined) {
  const peg = PEG_POOLS[chainName];
  if (!peg) throw Error(`no peg pool configured for ${chainName}`);
  const rpcUrl = opt("rpc", process.env.RPC_URL ?? "https://eth.drpc.org")!;
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error || body.result === undefined) throw Error(`rpc ${method}: ${body.error?.message ?? "no result"}`);
    return body.result;
  };
  const poolEvents = await readPegPool({ blockscout: chain.blockscout, poolManager: chain.poolManager, peg, through: endBlock, rpc });
  r = computePreseason(events, season, { switchBlock: Number(lpSwitch), poolEvents, bandLower: peg.bandLower, bandUpper: peg.bandUpper, token1Scale: peg.token1Scale });
} else {
  r = computePoints(events, season);
}
const out = {
  chain: chainName,
  stablecoin: stablecoin!.toLowerCase(),
  vault: vault!.toLowerCase(),
  season: { ...season, unit: "1 point = 1 imdUSD held for 1 day (7,200 blocks); liquidity earns lpBps/10000 x" },
  logsRead: tokenLogs.length + vaultLogs.length,
  totalPoints: display(r.total, chain.blocksPerDay),
  accounts: r.accounts.map((a) => ({
    owner: a.owner,
    points: display(a.points, chain.blocksPerDay),
    shareBps: shareBps(a.points, r.total),
    heldNow: a.held.toString(),
    lpNow: a.lp.toString(),
    perDayNow: display(a.ratePerBlock * BigInt(chain.blocksPerDay), chain.blocksPerDay),
  })),
};
const file = opt("out", "points.json")!;
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.error(`${out.logsRead} logs, ${events.length} point events, ${out.accounts.length} accounts, ${out.totalPoints} points (blocks ${startBlock}..${endBlock}) -> ${file}`);
for (const a of out.accounts.slice(0, 10)) console.error(`  ${a.owner}  ${a.points.padStart(16)}  ${(a.shareBps / 100).toFixed(2)}%  +${a.perDayNow}/day`);
