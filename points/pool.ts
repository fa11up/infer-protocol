// Season 1 readers: chain logs -> season1 events. PURE (decoding only; fetching lives in logs.ts / cli.ts).
import type { S1Event } from "./season1.ts";

export const S1_TOPICS = {
  modifyLiquidity: "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec",
  swap: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
  initialize: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
  draw: "0x7ffa12f2611233f19bb229a71c5d8224cb37373555ab6754b65aef59ea26831d",
  wipe: "0x2d2c7da251295f4d722a8ddaf337627952c957ce21b2757c852e47fe81b3a2af",
  cash: "0xc8f3a3b870d1d884775f2a0157bc36abedf6c2111d6c3bd78c684e23709cfe24",
  bite: "0xc55e1bb84cb7e132c40564eb13e09fd474d063a3c1142615fe6a309d21c1c5aa",
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};

/** Etherscan-style log (Blockscout `?module=logs&action=getLogs`): hex strings throughout. */
export type RawLog = { topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash?: string };

const TWO256 = 1n << 256n;
const word = (data: string, i: number) => BigInt("0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64));
const signed = (w: bigint) => (w >= TWO256 / 2n ? w - TWO256 : w);
const addr = (topic: string) => "0x" + topic.slice(-40).toLowerCase();
const pos = (l: RawLog) => ({ block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex === "0x" ? "0x0" : l.logIndex)) });

/**
 * Pool logs (Initialize, Swap, ModifyLiquidity of ONE pool) -> price and liquidity events, plus the owner of every
 * position that is not held through the PositionManager (its owner is the address that modified it).
 * PositionManager positions are keyed by their tokenId (the salt); their owners come from `nftOwnerEvents`.
 */
export function poolEvents(logs: RawLog[], positionManager: string): { events: S1Event[]; tokenIds: bigint[] } {
  const pm = positionManager.toLowerCase();
  const events: S1Event[] = [];
  const tokenIds = new Set<bigint>();
  const seenOwner = new Set<string>();
  for (const l of logs) {
    const t0 = l.topics[0]?.toLowerCase();
    const at = pos(l);
    if (t0 === S1_TOPICS.initialize) {
      events.push({ kind: "price", tick: Number(signed(word(l.data, 4))), ...at });
    } else if (t0 === S1_TOPICS.swap) {
      events.push({ kind: "price", tick: Number(signed(word(l.data, 4))), ...at });
    } else if (t0 === S1_TOPICS.modifyLiquidity) {
      const sender = addr(l.topics[2]);
      const tickLower = Number(signed(word(l.data, 0)));
      const tickUpper = Number(signed(word(l.data, 1)));
      const delta = signed(word(l.data, 2));
      const salt = word(l.data, 3);
      const id = sender === pm ? `nft:${salt}` : `${sender}:${tickLower}:${tickUpper}:${salt}`;
      if (sender === pm) tokenIds.add(salt);
      else if (!seenOwner.has(id)) {
        seenOwner.add(id);
        events.push({ kind: "owner", id, owner: sender, ...at });
      }
      events.push({ kind: "liquidity", id, tickLower, tickUpper, delta, ...at });
    }
  }
  return { events, tokenIds: [...tokenIds] };
}

/** PositionManager ERC-721 Transfer logs -> who owns each position from each block (burns go to the zero address). */
export function nftOwnerEvents(logs: RawLog[]): S1Event[] {
  return logs
    .filter((l) => l.topics[0]?.toLowerCase() === S1_TOPICS.transfer && l.topics.length === 4)
    .map((l) => ({ kind: "owner", id: `nft:${BigInt(l.topics[3])}`, owner: addr(l.topics[2]), ...pos(l) }));
}

/**
 * Vault logs -> each wallet's principal outstanding over time (rule 5). Principal = drawn - wiped - cancelled by
 * redemption - repaid by liquidation, floored at zero. Stability fees are not tracked (a wipe that pays fees can
 * only lower the figure, never raise it), so this understates debt slightly: in the borrower's favour.
 */
export function debtEvents(logs: RawLog[]): S1Event[] {
  const debt = new Map<string, bigint>();
  const out: S1Event[] = [];
  const sorted = [...logs].sort((a, b) => pos(a).block - pos(b).block || pos(a).logIndex - pos(b).logIndex);
  for (const l of sorted) {
    const t0 = l.topics[0]?.toLowerCase();
    let owner: string, change: bigint;
    if (t0 === S1_TOPICS.draw) [owner, change] = [addr(l.topics[1]), word(l.data, 0)];
    else if (t0 === S1_TOPICS.wipe) [owner, change] = [addr(l.topics[1]), -word(l.data, 0)];
    else if (t0 === S1_TOPICS.cash) [owner, change] = [addr(l.topics[2]), -word(l.data, 3)];
    else if (t0 === S1_TOPICS.bite) [owner, change] = [addr(l.topics[1]), -word(l.data, 0)];
    else continue;
    const next = (debt.get(owner) ?? 0n) + change;
    debt.set(owner, next > 0n ? next : 0n);
    out.push({ kind: "debt", owner, value: debt.get(owner)!, ...pos(l) });
  }
  return out;
}

/**
 * Safe (Gnosis Safe) singletons on Ethereum mainnet, each checked on chain by its VERSION() on 2026-10-16:
 * 1.1.1, 1.2.0, 1.3.0 (+ L2, + eip155 and eip155 L2), 1.4.1 (+ L2), 1.5.0 (+ L2).
 */
export const SAFE_SINGLETONS = new Set([
  "0x34cfac646f301356faa8b21e94227e3583fe3f5f", // 1.1.1
  "0x6851d6fdfafd08c0295c392436245e5bc78b0185", // 1.2.0
  "0xd9db270c1b5e3bd161e8c8503c55ceabee709552", // 1.3.0
  "0x3e5c63644e683549055b9be8653de26e0b4cd36e", // 1.3.0 L2
  "0x69f4d1788e39c87893c980c06edf4b7f686e2938", // 1.3.0 (eip155)
  "0xfb1bffc9d739b8d520daf37df666da4c687191ea", // 1.3.0 L2 (eip155)
  "0x41675c099f32341bf84bfc5382af534df5c7461a", // 1.4.1
  "0x29fcb43b46531bca003ddc8fcb67ffe91900c762", // 1.4.1 L2
  "0xff51a5898e281db6dfc7855790607438df2ca44b", // 1.5.0
  "0xedd160febbd92e350d4d398fb636302fccd67c7e", // 1.5.0 L2
]);

/** A Safe account: a proxy (at most 300 bytes of code) whose storage slot 0, its singleton, is a known Safe singleton. */
export function isSafeProxy(code: string, slot0: string): boolean {
  const bytes = (code.length - 2) / 2;
  if (bytes <= 0 || bytes > 300) return false;
  return SAFE_SINGLETONS.has(("0x" + slot0.slice(-40)).toLowerCase());
}

/** Code at a block -> earns as a wallet? Empty code (EOA) or an EIP-7702 delegation (0xef0100 + address). */
export function isWalletCode(code: string): boolean {
  const c = code.toLowerCase();
  return c === "0x" || c === "" || (c.startsWith("0xef0100") && c.length === 2 + 46);
}
