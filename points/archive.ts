// Historical logs when Blockscout refuses: Etherscan v2 (an archive source; ETHERSCAN_API_KEY) first, then the RPC in
// 5,000-block chunks. Free public RPCs refuse historical ranges (drpc: any range; publicnode: archive), so the RPC is
// a last resort. Callers check results are non-empty and replay to live state, so a silently-empty source fails.
import type { RawLog } from "./pool.ts";

export type Rpc = (method: string, params: unknown[]) => Promise<any>;

const CHUNK = 5_000;
export async function rpcLogs(rpc: Rpc, address: string, topics: (string | null)[], from: number, to: number): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let b = from; b <= to; b += CHUNK) {
    const hi = Math.min(b + CHUNK - 1, to);
    out.push(...((await rpc("eth_getLogs", [{ address, topics, fromBlock: "0x" + b.toString(16), toBlock: "0x" + hi.toString(16) }])) as RawLog[]));
  }
  return out;
}

/** Etherscan v2 getLogs: pages of up to 1,000, advancing from the last block seen and dropping repeats. */
export async function etherscanLogs(address: string, topics: (string | null)[], from: number, to: number, key = process.env.ETHERSCAN_API_KEY): Promise<RawLog[]> {
  if (!key) throw Error("no ETHERSCAN_API_KEY");
  const seen = new Map<string, RawLog>();
  for (let b = from; b <= to; ) {
    const q = new URLSearchParams({ chainid: "1", module: "logs", action: "getLogs", address, fromBlock: String(b), toBlock: String(to), page: "1", offset: "1000", apikey: key });
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

/** Etherscan, then the RPC. */
export async function archiveLogs(rpc: Rpc, address: string, topics: (string | null)[], from: number, to: number): Promise<RawLog[]> {
  try {
    return await etherscanLogs(address, topics, from, to);
  } catch (err) {
    console.error(`  ${address.slice(0, 10)}: ${(err as Error).message}; trying the RPC`);
    return rpcLogs(rpc, address, topics, from, to);
  }
}
