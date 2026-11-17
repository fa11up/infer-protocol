// INFER BOX from imdusd.com/build/ (founder 2026-11-17: building with the swarm is the page's headline, open to
// any wallet). The Box serves partner sites at /api/partner/*: sign in with the wallet (the message names this
// site), get a session token bound to this origin, then evaluate, quote, pay and follow orders as on the Box's
// own page. A wallet with no access code joins on its first sign-in, within the Box's per-day bounds. The token
// lives in this tab only (sessionStorage), per wallet; nothing else is stored. Port of miyamaker's
// app/src/pages/Build/box.ts without wagmi.
import { erc20Abi, parseAbi, type Address, type Hex } from "viem";
import { connectAccount, personalSign, readClient, walletClient, type Provider } from "./wallet";

export const BOX = "https://box.imdusd.com";
// VITE_BOX_URL points a dev server at a local Box (wrangler dev); a production build always talks to box.imdusd.com.
const API = `${(import.meta.env.DEV && (import.meta.env.VITE_BOX_URL as string | undefined)) || BOX}/api/partner`;

export type Band = "likely" | "uncertain" | "unlikely" | "refused";
export type Field = { id: string; label: string; type: "address" | "number" | "choice" | "text"; example: string };
export type Verdict = {
  id: string;
  band: Band;
  action?: string;
  policy?: { line: string };
  risks?: { severity: "block" | "high" | "medium"; reason: string; redirect?: string | null }[];
  sharpen?: string[];
  fields?: Field[];
  usedToday?: number;
  evalsPerDay?: number;
};
export type Me = { wallet: string; evalsPerDay: number; usedToday: number; payments: boolean };
export type Quote = {
  orderId: Hex;
  box: Address;
  imdUsd: Address;
  expiresAt: number;
  total: string;
  pay: { orderId: Hex; commitment: Hex; toFloat: string; toTreasury: string; escrow: string; ref: Hex };
  shown: { swarmPriceImd: number; imdUsd: number; cost: number; buffer: number };
};
export type Order = {
  id: string;
  action: string;
  status: "quoted" | "paid" | "sending" | "held" | "admitted" | "refused" | "mismatch" | "expired";
  created_at: number;
  paid_tx?: string | null;
  job_id?: string | null;
  result?: { state: string; say: string };
};
export const KINDS = [
  ["question", "A question", "An answer the swarm checks and signs: a price over a block window, a count of events, an on-chain read."],
  ["build", "A build", "Code in a public repo: a contract with tests, a site, a script, an audit."],
  ["launch", "A launch", "A token, project or Uniswap v4 hook launched on chain, every address and fee named."],
  ["workflow", "A launch with its site", "A launch plus the website for it, in one order."],
] as const;
export type Kind = (typeof KINDS)[number][0];

const BOX_ABI = parseAbi([
  "function pay(bytes32 orderId, bytes32 commitment, uint256 toFloat, uint256 toTreasury, uint256 escrow, bytes32 ref)",
  "function token() view returns (address)",
]);

export class BoxError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init: { body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch(() => {
    throw new BoxError("Couldn't reach INFER BOX. Check your connection and try again.", 0);
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new BoxError(json.error || `INFER BOX answered ${res.status}`, res.status);
  return json;
}

const storeKey = (wallet: string) => `box-token:${wallet.toLowerCase()}`;
export function savedToken(wallet: string): string | null {
  try {
    const raw = sessionStorage.getItem(storeKey(wallet));
    const s = raw ? (JSON.parse(raw) as { token: string; expiresAt: number }) : null;
    return s && s.expiresAt > Date.now() ? s.token : null;
  } catch {
    return null;
  }
}

/** Connect, then sign the Box's sign-in message. Returns the wallet and its session token. */
export async function signIn(p: Provider): Promise<{ wallet: Address; token: string }> {
  const wallet = await connectAccount(p);
  const kept = savedToken(wallet);
  if (kept) return { wallet, token: kept };
  const ch = await call<{ nonce: string; message: string }>("/challenge", { body: { address: wallet } });
  const signature = await personalSign(p, wallet, ch.message);
  const r = await call<{ token: string; expiresAt: number }>("/login", { body: { nonce: ch.nonce, signature } });
  try {
    sessionStorage.setItem(storeKey(wallet), JSON.stringify(r));
  } catch {
    /* private window: the session lasts until the page closes */
  }
  return { wallet, token: r.token };
}

export function forget(wallet: string) {
  try {
    sessionStorage.removeItem(storeKey(wallet));
  } catch {
    /* nothing stored */
  }
}

export const me = (token: string) => call<Me>("/me", { token });
export const evaluate = (token: string, idea: string, typeHint: Kind, facts: Record<string, string>) =>
  call<Verdict>("/evaluate", { token, body: { idea, typeHint, facts } });
export const quote = (token: string, evalId: string) => call<Quote>("/order", { token, body: { evalId } });
export const orders = (token: string) => call<{ orders: Order[] }>("/orders", { token });

export const toImdUsd = (wei: string | bigint) => (Number(BigInt(wei) / 10n ** 14n) / 1e4).toFixed(2);

/**
 * Pay a quote from the signed-in wallet: check the Box really takes imdUSD, check the balance, approve exactly the
 * total if needed, then Box.pay with the quote's own arguments. `say` reports each step.
 */
export async function pay(p: Provider, wallet: Address, q: Quote, say: (s: string) => void): Promise<Hex> {
  const read = readClient();
  const code = await read.getCode({ address: q.box });
  const token = await read.readContract({ address: q.box, abi: BOX_ABI, functionName: "token" }).catch(() => null);
  if (!code || code === "0x" || token?.toLowerCase() !== q.imdUsd.toLowerCase())
    throw new BoxError("The payment contract didn't check out. Nothing was sent.", 0);
  const total = BigInt(q.total);
  const balance = await read.readContract({ address: q.imdUsd, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });
  if (balance < total) throw new BoxError(`You hold ${toImdUsd(balance)} imdUSD and this needs ${toImdUsd(total)}.`, 0);
  const w = await walletClient(p, wallet);
  const allowance = await read.readContract({ address: q.imdUsd, abi: erc20Abi, functionName: "allowance", args: [wallet, q.box] });
  if (allowance < total) {
    say(`Step 1 of 2: approve exactly ${toImdUsd(total)} imdUSD to the Box.`);
    const a = await w.writeContract({ address: q.imdUsd, abi: erc20Abi, functionName: "approve", args: [q.box, total] });
    say("Waiting for the approval to land…");
    if ((await read.waitForTransactionReceipt({ hash: a })).status !== "success")
      throw new BoxError("The approval failed. Nothing was paid.", 0);
    say("Step 2 of 2: pay.");
  } else say("Confirm the payment in your wallet.");
  const x = q.pay;
  const hash = await w.writeContract({
    address: q.box,
    abi: BOX_ABI,
    functionName: "pay",
    args: [x.orderId, x.commitment, BigInt(x.toFloat), BigInt(x.toTreasury), BigInt(x.escrow), x.ref],
  });
  say("Waiting for the payment to land…");
  if ((await read.waitForTransactionReceipt({ hash })).status !== "success")
    throw new BoxError("The payment reverted. Nothing was paid.", 0);
  return hash;
}
