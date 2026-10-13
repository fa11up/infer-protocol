// MXXN's full-moon clock (ThriceInABlueMoon, 0x2BBC…25fB, verified source). MXXN moves only inside its window
// `moonConfig = [start, end]` (2,880 blocks, ~9.6 h). Before any transfer or burn, if the block is past `end`, the
// window moves forward ONE cycle; a transfer that then falls outside the window reverts, taking that move with it.
// Burns always pass (the owner is the zero address and a burn goes there), so each successful burn of 1 wei moves the
// clock one cycle: with no traffic it falls behind one cycle a month, and burns catch it up.
import { parseAbi } from "viem";

/** TWENTY_NINE_AND_HALF_DAY_BLOCKS in MXXN's source (a private constant, so it is copied here). */
export const MOON_CYCLE = 169_920n;
const BLOCK_SECONDS = 12;

export const MOON = parseAbi([
  "function moonConfig() view returns (uint256 start, uint256 end)",
  "function burn(uint256 value)",
]);

export type MoonState = {
  /** Cycles the stored window trails the chain: burns that would bring it to the current or next full moon. */
  behind: bigint;
  /** The full moon the clock is heading for: the stored window moved `behind` cycles. */
  start: bigint;
  end: bigint;
  head: bigint;
  /** The chain is inside that full moon now. */
  open: boolean;
  /** A redemption would go through now: inside the full moon with the clock at most one cycle behind (the
   * redemption's own transfer moves it the last cycle). */
  redeemable: boolean;
  /** Burns still needed before a redemption can go through at that full moon. */
  needed: bigint;
};

export function moonState(start: bigint, end: bigint, head: bigint): MoonState {
  const behind = head > end ? (head - end + MOON_CYCLE - 1n) / MOON_CYCLE : 0n;
  const s = start + behind * MOON_CYCLE,
    e = end + behind * MOON_CYCLE;
  const open = head >= s && head <= e;
  return {
    behind,
    start: s,
    end: e,
    head,
    open,
    redeemable: open && behind <= 1n,
    needed: behind > 1n ? behind - 1n : 0n,
  };
}

/** About how long `blocks` blocks take, for a countdown: "5 h 52 m", "29 d 12 h", "4 m". */
export function blocksToTime(blocks: bigint): string {
  const s = Number(blocks < 0n ? 0n : blocks) * BLOCK_SECONDS;
  const d = Math.floor(s / 86_400),
    h = Math.floor((s % 86_400) / 3600),
    m = Math.max(Math.floor((s % 3600) / 60), s > 0 && s < 60 ? 1 : 0);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} m` : `${m} m`;
}
