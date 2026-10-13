import { keccak256, parseAbi, type Address } from "viem";
import type { Runtime } from "./config";
import type { Snapshot } from "./state";
import { Action, Info, type Actions } from "./actions";
import { exact, fmt } from "./math";

// Buying a price update with the viewer's own IMD, through the protocol's OracleAsker. The asker pays
// IdentityMD's on-chain Intake and delivers the answer through SwarmRelay; the feed checks it like any
// other attestation. Nothing here spends protocol money. Until the Intake is live on mainnet the
// deployment names no asker, and the control explains that instead.
export const askerAbi = parseAbi([
  "function price() view returns (uint256)",
  "function payToken() view returns (address)",
  "function feeds(address) view returns (bytes32 bodyHash, bool tracksPool, bool keepAlive, uint64 lastAsk, uint64 armedAt, uint64 inFlightAt, bool treasuryPaid, bytes32 inFlight)",
  "function askPaid(address feed, bytes body, uint256 maxPrice) returns (bytes32)",
  "function askPaidMany(address[] feeds, bytes[] bodies, uint256 maxPriceEach) returns (bytes32[])",
]);
const feedAbi = parseAbi(["function latestValue() view returns (uint256 value, uint64 updatedAt)"]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);

export type AskerState = {
  price: bigint;
  payToken: Address;
  /** Feeds whose configured request body matches the hash the asker pins. */
  ready: Record<string, boolean>;
  /** A request already on its way for this feed. */
  inFlight: Record<string, boolean>;
  /** For a feed in flight: when it was ordered, when the asker takes the next order (ordered + ASK_TIMEOUT), and
   * whether its answer has already reached the feed (the slot stays set when the Intake's callback does not clear it). */
  orderedAt: Record<string, bigint>;
  reopensAt: Record<string, bigint>;
  answered: Record<string, boolean>;
  balance?: bigint;
  allowance?: bigint;
};

export async function readAsker(
  r: Runtime,
  feeds: Record<string, Address>,
  account: Address | undefined,
  blockNumber: bigint,
): Promise<AskerState | undefined> {
  const cfg = r.config.oracleAsker;
  if (!cfg) return undefined;
  const at = { address: cfg.address, abi: askerAbi } as const;
  const [price, payToken] = await Promise.all([
    r.client.readContract({ ...at, functionName: "price", blockNumber }),
    r.client.readContract({ ...at, functionName: "payToken", blockNumber }),
  ]);
  const ready: Record<string, boolean> = {};
  const inFlight: Record<string, boolean> = {};
  const orderedAt: Record<string, bigint> = {};
  const reopensAt: Record<string, bigint> = {};
  const answered: Record<string, boolean> = {};
  // The asker treats a request as in flight only until ASK_TIMEOUT after it was sent (2 hours, a deploy-time
  // constant it does not expose): after that `askPaid`/`askPaidMany` buy again. A slot the Intake's callback never
  // cleared reads non-zero for ever, and taking it at face value refused every purchase ("An update is already on
  // its way", mainnet 2026-10-13, slots 4-6 hours old).
  const ASK_TIMEOUT = 2n * 3600n;
  const now = (await r.client.getBlock(blockNumber === undefined ? {} : { blockNumber })).timestamp;
  await Promise.all(
    Object.entries(feeds).map(async ([name, feed]) => {
      const body = cfg.requests?.[name];
      if (!body) return;
      const f = await r.client.readContract({
        ...at,
        functionName: "feeds",
        args: [feed],
        blockNumber,
      });
      ready[name] = f[0] === keccak256(body);
      // inFlight is the eighth member since treasuryPaid was added, inFlightAt the sixth.
      inFlight[name] = !/^0x0+$/.test(f[7]) && now < BigInt(f[5]) + ASK_TIMEOUT;
      if (inFlight[name]) {
        orderedAt[name] = BigInt(f[5]);
        reopensAt[name] = BigInt(f[5]) + ASK_TIMEOUT;
        // latestValue's updatedAt is the attestation's issue time, which is after the order for its own answer.
        const [, updatedAt] = await r.client.readContract({ address: feed, abi: feedAbi, functionName: "latestValue", blockNumber });
        answered[name] = BigInt(updatedAt) >= BigInt(f[5]);
      }
    }),
  );
  const state: AskerState = { price, payToken, ready, inFlight, orderedAt, reopensAt, answered };
  if (account)
    [state.balance, state.allowance] = await Promise.all([
      r.client.readContract({
        address: payToken,
        abi: erc20,
        functionName: "balanceOf",
        args: [account],
        blockNumber,
      }),
      r.client.readContract({
        address: payToken,
        abi: erc20,
        functionName: "allowance",
        args: [account, cfg.address],
        blockNumber,
      }),
    ]);
  return state;
}

export function BuyUpdate({
  r,
  s,
  feed,
  feeds: group,
  actions,
  label = "Buy update",
  idPrefix = "buy-update",
  info = true,
  hold,
  holdNote,
}: {
  r: Runtime;
  s?: Snapshot;
  feed: string;
  /** Several feeds bought in one transaction (askPaidMany), e.g. the primary and the spot together. */
  feeds?: string[];
  actions: Actions;
  /** What the button says, e.g. "Update price". */
  label?: string;
  /** Keeps ids unique when the same feed's button appears in two places. */
  idPrefix?: string;
  /** Show the info icon (one per group of buttons is enough when they share a reason). */
  info?: boolean;
  /** Why buying now would be wasted (priceUpdate's `wait`): the button shows, disabled, with this reason. */
  hold?: string;
  /** A few words under the held button; the full reason is the panel's sentence and the info icon. */
  holdNote?: string;
}) {
  const cfg = r.config.oracleAsker;
  const id = `${idPrefix}-${feed}`;
  if (cfg && s?.asker === "unreadable")
    return (
      <div className="buy-update">
        <button type="button" disabled>
          {label}
        </button>
        {info && (<Info
          label={label}
          text="The request contract did not answer. Refresh to try again."
        />)}
      </div>
    );
  const a = s?.asker === "unreadable" ? undefined : s?.asker;
  if (!cfg || !a)
    return (
      <div className="buy-update">
        <button type="button" disabled>
          {label}
        </button>
        {info && (<Info
          label={label}
          text="Buying an update from here opens when IdentityMD's on-chain request contract is live. Until then, anyone can buy one from the oracle service and relay it."
        />)}
      </div>
    );
  const all = group ?? [feed];
  // A feed already on its way is skipped by the asker and not charged, so it is not paid for here either.
  const toBuy = all.filter((n) => !a.inFlight[n]);
  // Say what is actually true of a feed in flight: answered already (the asker's slot outlives the answer when the
  // Intake's callback does not clear it) or still coming, and when the asker takes the next order.
  const hhmm = (t?: bigint) => (t === undefined ? "" : `${new Date(Number(t) * 1000).toISOString().slice(11, 16)} UTC`);
  const names = (ns: string[]) => ns.map((n) => (n === "NhiFeed" ? "NHI" : n.replace(/Feed$/, "").toLowerCase())).join(" and ");
  const latest = (ns: string[], m: Record<string, bigint>) => ns.map((n) => m[n]).reduce((x, y) => (y > x ? y : x), 0n);
  const inFlightNote = (() => {
    const done = all.filter((n) => a.inFlight[n] && a.answered[n]);
    const coming = all.filter((n) => a.inFlight[n] && !a.answered[n]);
    const reopen = hhmm(latest(all, a.reopensAt));
    if (coming.length)
      return `An update for ${names(coming)} was ordered at ${hhmm(latest(coming, a.orderedAt))} and is on its way. If it stalls, ordering reopens at ${reopen}.`;
    // Nothing in flight (the usual case): this note is never shown, and done[0] would not exist.
    if (!done.length) return "";
    return `${names(done)[0].toUpperCase() + names(done).slice(1)} ${done.length > 1 ? "were" : "was"} just updated (ordered at ${hhmm(latest(done, a.orderedAt))}). The oracle takes the next order for ${done.length > 1 ? "them" : "it"} after ${reopen}.`;
  })();
  const total = a.price * BigInt(toBuy.length || 1);
  const short = a.allowance === undefined || a.allowance < total;
  const what = toBuy.length > 1 ? `${toBuy.length} updates` : "an update";
  const blocked = hold
    ? hold
    : all.some((n) => !cfg.requests?.[n])
    ? "This deployment lists no request for this feed."
    : all.some((n) => !a.ready[n])
      ? "The configured request does not match the question this feed pins. Nothing will be sent."
      : !toBuy.length
        ? inFlightNote
        : a.price === 0n
          ? "The request contract is not selling updates right now."
          : a.balance !== undefined && a.balance < total
            ? `This costs ${fmt(total)} IMD; this wallet holds ${fmt(a.balance)}.`
            : "";
  return (
    <div className="buy-update">
      <Action
        id={id}
        label={short && !blocked ? `Approve ${fmt(total)} IMD · ${label}` : label}
        actions={actions}
        disabled={!!blocked}
        reason={hold ? (holdNote ?? "") : blocked}
        request={() => {
          if (blocked) throw Error(blocked);
          if (short)
            return {
              target: { address: a.payToken, abi: erc20 },
              fn: "approve",
              args: [cfg.address, total],
              summary: `Approve exactly ${exact(total)} IMD for ${what}. The purchase is a separate transaction.`,
            };
          if (toBuy.length === 1)
            return {
              target: { address: cfg.address, abi: askerAbi },
              fn: "askPaid",
              args: [s!.targets[toBuy[0]].address, cfg.requests[toBuy[0]], a.price],
              summary: `Pay ${exact(a.price)} IMD from this wallet for a fresh ${toBuy[0]} answer. It arrives once a swarm panel answers, usually within minutes.`,
            };
          return {
            target: { address: cfg.address, abi: askerAbi },
            fn: "askPaidMany",
            args: [toBuy.map((n) => s!.targets[n].address), toBuy.map((n) => cfg.requests[n]), a.price],
            summary: `Pay ${exact(total)} IMD from this wallet, in one transaction, for fresh ${toBuy.join(" and ")} answers. Each arrives once its swarm panel answers, usually within minutes of each other.`,
          };
        }}
      />
      {info && (<Info
        label={label}
        text={hold ? hold : `Pays ${fmt(total)} IMD from your wallet${toBuy.length > 1 ? `, in one transaction, for ${toBuy.length} answers` : " for a fresh answer"} from swarm panels, usually within minutes. No protocol funds are spent.`}
      />)}
    </div>
  );
}
