// A transaction has four ends, and only a receipt for that very transaction, or a copy of it at a new fee, means it ran.
// Between "sent" and those ends is a state the pages must keep: it may still land, so it must not be sent again. It is
// remembered across a reload or a page change, and only the user can give up on it (the wallet may have dropped it).
import type { Hash } from "viem";

export type Outcome =
  | { kind: "mined"; hash: Hash }
  | { kind: "reverted"; hash: Hash }
  | { kind: "replaced"; hash: Hash; reason: "cancelled" | "replaced" }
  | { kind: "unknown"; hash: Hash };

type Receipts = {
  waitForTransactionReceipt: (args: {
    hash: Hash;
    confirmations?: number;
    timeout?: number;
    onReplaced?: (r: { reason: "cancelled" | "replaced" | "repriced" }) => void;
  }) => Promise<{ status: string; transactionHash: Hash }>;
};

/** Waits for a sent transaction and says what became of it. Never throws: a timeout or a failed lookup is "unknown". */
export async function settle(client: Receipts, hash: Hash, timeout: number): Promise<Outcome> {
  let swapped: "cancelled" | "replaced" | "repriced" | undefined;
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: 1,
      timeout,
      onReplaced: (r) => {
        swapped = r.reason;
      },
    });
    const landed = receipt.transactionHash;
    if (swapped === "cancelled" || swapped === "replaced") return { kind: "replaced", hash: landed, reason: swapped };
    return receipt.status === "success" ? { kind: "mined", hash: landed } : { kind: "reverted", hash: landed };
  } catch {
    return { kind: "unknown", hash };
  }
}

/** Thrown when a send has gone out and its result is not known yet. The words never say it failed. */
export class OutcomeUnknown extends Error {}
export const unknownText = (label: string) =>
  `${label} was sent, but its result is not known yet. It may still land, so do not send it again. This page keeps checking.`;
export const replacedText = (label: string, reason: "cancelled" | "replaced") =>
  `${label} was ${reason} in your wallet, so it did not run.`;

/** A sent transaction (or wallet batch) whose result is not known yet. */
export type Unsettled = { hash?: Hash; batchId?: string; label: string; account: string; since: number };

export function loadUnsettled(key: string): Unsettled | undefined {
  try {
    const u = JSON.parse(localStorage.getItem(key) ?? "null");
    return u && typeof u.label === "string" && (u.hash || u.batchId) ? u : undefined;
  } catch {
    return undefined;
  }
}

export function saveUnsettled(key: string, u: Unsettled | undefined) {
  try {
    if (u) localStorage.setItem(key, JSON.stringify(u));
    else localStorage.removeItem(key);
  } catch {}
}
