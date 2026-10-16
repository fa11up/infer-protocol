// Reads imdUSD Transfer and vault Bite events from Blockscout and turns them into engine events.
//
// Blockscout, never a public RPC's eth_getLogs: public nodes can silently return an EMPTY array for
// a range they decline. A token or vault always has at least its constructor's logs, so zero logs is
// an error here, never "nobody holds anything".
import type { PointEvent } from "./engine.ts";

// keccak256 of the event signatures (checked against the compiled ABIs in the CLI's self-test).
export const TOPICS = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer(address,address,uint256)
  bite: "0xc55e1bb84cb7e132c40564eb13e09fd474d063a3c1142615fe6a309d21c1c5aa", // Bite(address,address,uint256,uint256)
};

type Item = { topics: (string | null)[]; data: string; block_number: number | string; index: number | string; transaction_hash?: string };

const word = (hex: string, i: number) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
const addr = (topic: string | null) => {
  if (!topic) throw Error("missing indexed address");
  return "0x" + topic.slice(-40).toLowerCase();
};

export function decodeLog(item: Item): PointEvent | null {
  const t0 = item.topics?.[0];
  const block = Number(item.block_number);
  const logIndex = Number(item.index);
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(logIndex)) throw Error("malformed log position");
  if (t0 === TOPICS.transfer) return { kind: "transfer", from: addr(item.topics[1]), to: addr(item.topics[2]), value: word(item.data, 0), block, logIndex };
  if (t0 === TOPICS.bite) return { kind: "bite", liquidator: addr(item.topics[2]), debtRepaid: word(item.data, 0), block, logIndex };
  return null;
}

/** keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)") on the v4 PoolManager. */
export const MODIFY_LIQUIDITY = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";

/**
 * The transactions among `txs` that added to or removed from `poolId`: each one's logs from Blockscout, looking
 * for the PoolManager's ModifyLiquidity with that pool id. Only transactions that moved imdUSD to or from the
 * PoolManager are asked about, so this is one request per swap or deposit, never a scan of the PoolManager.
 */
export async function liquidityTxs(host: string, txs: string[], poolId: string, apiKey = process.env.BLOCKSCOUT_API_KEY): Promise<Set<string>> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "infer-points/1.0" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const out = new Set<string>();
  for (const tx of txs) {
    const res = await fetch(`https://${host}/api/v2/transactions/${tx}/logs`, { headers });
    if (!res.ok) throw Error(`blockscout ${res.status} for the logs of ${tx}`);
    const body = (await res.json()) as { items?: Item[] };
    if (!Array.isArray(body.items)) throw Error("incomplete Blockscout response");
    if (body.items.some((l) => l.topics?.[0] === MODIFY_LIQUIDITY && l.topics?.[1]?.toLowerCase() === poolId.toLowerCase())) out.add(tx.toLowerCase());
  }
  return out;
}

export async function fetchLogs(host: string, address: string, apiKey = process.env.BLOCKSCOUT_API_KEY): Promise<Item[]> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "infer-points/1.0" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const items: Item[] = [];
  let params: Record<string, unknown> | null = null;
  for (let page = 0; page < 100_000; ++page) {
    const qs = params ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : "";
    const res = await fetch(`https://${host}/api/v2/addresses/${address}/logs${qs}`, { headers });
    if (!res.ok) throw Error(`blockscout ${res.status} on page ${page} for ${address}`);
    const body = (await res.json()) as { items?: Item[]; next_page_params?: Record<string, unknown> | null };
    if (!Array.isArray(body.items)) throw Error("incomplete Blockscout response");
    items.push(...body.items);
    params = body.next_page_params ?? null;
    if (!params) break;
  }
  if (!items.length) throw Error(`no logs at all for ${address} on ${host}: wrong address or chain, or the explorer declined; refusing to report "nobody holds anything"`);
  return items;
}

/** Etherscan-style filtered logs from Blockscout (`?module=logs&action=getLogs`), paged 1,000 at a time. */
export async function fetchFilteredLogs(
  host: string,
  q: { address: string; topic0: string; topic1?: string; topic3?: string; fromBlock: number; toBlock: number },
  apiKey = process.env.BLOCKSCOUT_API_KEY,
): Promise<{ topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash?: string }[]> {
  const out: { topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash?: string }[] = [];
  for (let page = 1; page < 10_000; ++page) {
    const p = new URLSearchParams({ module: "logs", action: "getLogs", address: q.address, fromBlock: String(q.fromBlock), toBlock: String(q.toBlock), topic0: q.topic0, page: String(page), offset: "1000" });
    if (q.topic1) p.set("topic1", q.topic1), p.set("topic0_1_opr", "and");
    if (q.topic3) p.set("topic3", q.topic3), p.set("topic0_3_opr", "and");
    if (apiKey) p.set("apikey", apiKey);
    let res: Response | undefined;
    // Keyless Blockscout rate-limits (429): back off and retry rather than fail a whole run.
    for (let attempt = 0; attempt < 6; ++attempt) {
      res = await fetch(`https://${host}/api?${p}`, { headers: { Accept: "application/json", "User-Agent": "infer-points/1.0" } });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    if (!res!.ok) throw Error(`blockscout ${res!.status} for ${q.address} ${q.topic0}`);
    const body = (await res!.json()) as { status?: string; message?: string; result?: unknown };
    if (!Array.isArray(body.result)) {
      if (body.message === "No logs found") break;
      throw Error(`blockscout: ${body.message ?? "malformed response"}`);
    }
    out.push(...(body.result as typeof out));
    if (body.result.length < 1000) break;
  }
  return out;
}
