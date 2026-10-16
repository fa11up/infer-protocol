// Season 1 as the SeasonVault records it, for the Points pane: whether it has been opened, when it starts and
// ends, its pot, and the block the opening executed in (where the preseason ends, rules/season-1.md section 3).
//
// Phases: "preseason" until openSeason executes; "scheduled" from then until `start` (nothing accrues); "live"
// during the season; "ended" after it. The opening block comes from `pointsConfig.endBlock` when it is pinned there
// (the authority, set after execution), else from the vault's SeasonOpened event via Blockscout (a hint: public
// RPCs refuse historical log searches); until either answers, the preseason keeps counting to the head.
import { parseAbi, type Address } from "viem";
import { pointsConfig, type Runtime } from "./config";
import { explorerLogs } from "./history";
import { phaseAt, type SeasonPhase } from "./season-math.ts";
export { phaseAt, infer, type SeasonPhase } from "./season-math.ts";

export const SEASON_VAULT_ABI = parseAbi([
  "function opened() view returns (uint256)",
  "struct Season { uint64 start; uint64 rootSetAt; bool expired; uint256 pot; bytes32 formula; bytes32 root; uint256 total; uint256 registered; uint256 paid; bytes32 pendingRoot; uint256 pendingTotal; uint64 pendingEta; }",
  "function season(uint256 s) view returns (Season)",
  "function SEASON() view returns (uint256)",
]);

export type SeasonInfo = {
  phase: SeasonPhase;
  /** Unix seconds; set once opened. */
  start?: number;
  end?: number;
  /** INFER wei. */
  pot?: bigint;
  /** The block openSeason executed in: the preseason's last block. Undefined while unknown. */
  openedBlock?: number;
  /** Where openedBlock came from. */
  openedFrom?: "config" | "explorer";
};

/** keccak256("SeasonOpened(uint256,uint256,uint256,uint256,bytes32)") */
const SEASON_OPENED_TOPIC = "0xe5fead77cd3d429b79f60d07d3d9a69b566d0c3812f6f0938a24e505f8faa3a6";

async function openedBlockFromExplorer(r: Runtime, vault: Address, head: bigint): Promise<number | undefined> {
  const logs = await explorerLogs(r, { address: vault, abi: SEASON_VAULT_ABI }, 0n, head);
  const opened = logs
    .filter((l) => l.topics[0]?.toLowerCase() === SEASON_OPENED_TOPIC && BigInt(l.topics[1] ?? "0x1") === 0n)
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1))[0];
  return opened ? Number(opened.blockNumber) : undefined;
}

const known = new WeakMap<Runtime, SeasonInfo>();
export async function readSeason(r: Runtime, head: bigint, now: number): Promise<SeasonInfo> {
  const vault = pointsConfig.seasonVaults[r.config.chainId] as Address | undefined;
  if (!vault) return { phase: "preseason" };
  const opened = (await r.client.readContract({ address: vault, abi: SEASON_VAULT_ABI, functionName: "opened" })) as bigint;
  if (opened === 0n) return { phase: "preseason" };
  const [s, length] = await Promise.all([
    r.client.readContract({ address: vault, abi: SEASON_VAULT_ABI, functionName: "season", args: [0n] }) as Promise<{ start: bigint; pot: bigint }>,
    r.client.readContract({ address: vault, abi: SEASON_VAULT_ABI, functionName: "SEASON" }) as Promise<bigint>,
  ]);
  const start = Number(s.start);
  const end = start + Number(length);
  let openedBlock = pointsConfig.endBlock;
  let openedFrom: SeasonInfo["openedFrom"] = openedBlock !== undefined ? "config" : undefined;
  if (openedBlock === undefined) {
    const old = known.get(r);
    if (old?.openedBlock !== undefined) {
      openedBlock = old.openedBlock;
      openedFrom = old.openedFrom;
    } else {
      try {
        openedBlock = await openedBlockFromExplorer(r, vault, head);
        if (openedBlock !== undefined) openedFrom = "explorer";
      } catch {
        /* The explorer refused: the preseason keeps counting until it answers or endBlock is pinned. */
      }
    }
  }
  const info: SeasonInfo = { phase: phaseAt(now, true, start, end), start, end, pot: s.pot, openedBlock, openedFrom };
  known.set(r, info);
  return info;
}

/** The first block whose timestamp is at or after `ts` (rules section 1), by binary search over block headers;
 * remembered per timestamp in the browser. */
export async function firstBlockAtOrAfter(r: Runtime, ts: number, head: bigint): Promise<bigint> {
  const key = `block-at:${r.config.chainId}:${ts}`;
  try {
    const kept = localStorage.getItem(key);
    if (kept) return BigInt(kept);
  } catch {
    /* no storage */
  }
  const time = async (n: bigint) => Number((await r.client.getBlock({ blockNumber: n })).timestamp);
  if ((await time(head)) < ts) throw Error("that time has not been reached");
  // 12-second blocks: start the search near the estimate.
  const headTime = await time(head);
  let lo = head - BigInt(Math.ceil((headTime - ts) / 12) + 600);
  if (lo < 0n) lo = 0n;
  while (lo > 0n && (await time(lo)) >= ts) lo = lo > 5_000n ? lo - 5_000n : 0n;
  let hi = head;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await time(mid)) >= ts) hi = mid;
    else lo = mid;
  }
  try {
    localStorage.setItem(key, hi.toString());
  } catch {
    /* no storage */
  }
  return hi;
}
