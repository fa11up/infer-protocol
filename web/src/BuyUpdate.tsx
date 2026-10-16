import { keccak256, parseAbi, type Address } from "viem";
import type { Runtime } from "./config";
import type { Snapshot } from "./state";
import { Action, ActionForm, Info, type Actions } from "./actions";
import { exact, fmt } from "./math";

// Buying a price update through the protocol's OracleAsker. The asker pays IdentityMD's on-chain Intake and
// delivers the answer through SwarmRelay; the feed checks it like any other attestation. When the asker's own
// rules say the Treasury pays for a feed right now (`ask`: a kept-alive feed near stale, a feed stale long enough
// to be wide open, or an armed fall), the button sends that and the viewer pays only gas; otherwise it buys with
// the viewer's own IMD (`askPaid`). Until the Intake is live on mainnet the deployment names no asker, and the
// control explains that instead.
export const askerAbi = parseAbi([
  "function price() view returns (uint256)",
  "function payToken() view returns (address)",
  "function feeds(address) view returns (bytes32 bodyHash, bool tracksPool, bool keepAlive, uint64 lastAsk, uint64 armedAt, uint64 inFlightAt, bool treasuryPaid, bytes32 inFlight)",
  "function ask(address feed, bytes body) returns (bytes32)",
  "function askPaid(address feed, bytes body, uint256 maxPrice) returns (bytes32)",
  "function askPaidMany(address[] feeds, bytes[] bodies, uint256 maxPriceEach) returns (bytes32[])",
]);
const feedAbi = parseAbi(["function latestValue() view returns (uint256 value, uint64 updatedAt)"]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
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
  /** The Treasury pays for this feed's update right now: `ask` simulates cleanly at this block. The contract alone
   * decides (keep-alive near stale, wide open, or an armed fall, within its interval and budget), so it is asked
   * rather than re-derived here; any revert (NotNeeded, NotArmed, TooSoon, an empty asker) reads as not free. */
  free: Record<string, boolean>;
  /** IMD the asker itself holds: what it pays the Intake with for every Treasury-rule update (`ask`). */
  held: bigint;
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
  const held = await r.client.readContract({
    address: payToken,
    abi: erc20,
    functionName: "balanceOf",
    args: [cfg.address],
    blockNumber,
  });
  const ready: Record<string, boolean> = {};
  const inFlight: Record<string, boolean> = {};
  const orderedAt: Record<string, bigint> = {};
  const reopensAt: Record<string, bigint> = {};
  const answered: Record<string, boolean> = {};
  const free: Record<string, boolean> = {};
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
      if (ready[name] && !inFlight[name])
        free[name] = await r.client
          .simulateContract({ ...at, functionName: "ask", args: [feed, body], blockNumber })
          .then(() => true, () => false);
    }),
  );
  const state: AskerState = { price, payToken, ready, inFlight, orderedAt, reopensAt, answered, free, held };
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
  // Feeds the Treasury pays for right now go first, one `ask` per click (the asker has no batch form of it); the
  // rest are bought from this wallet as before, on the next click once the free one is in flight.
  const free = toBuy.filter((n) => a.free?.[n]);
  const paid = toBuy.filter((n) => !a.free?.[n]);
  const total = a.price * BigInt(paid.length || 1);
  const short = a.allowance === undefined || a.allowance < total;
  const what = paid.length > 1 ? `${paid.length} updates` : "an update";
  const blocked = hold
    ? hold
    : all.some((n) => !cfg.requests?.[n])
    ? "This deployment lists no request for this feed."
    : all.some((n) => !a.ready[n])
      ? "The configured request does not match the question this feed pins. Nothing will be sent."
      : !toBuy.length
        ? inFlightNote
        : free.length
          ? ""
          : a.price === 0n
            ? "The request contract is not selling updates right now."
            : a.balance !== undefined && a.balance < total
              ? `This costs ${fmt(total)} IMD; this wallet holds ${fmt(a.balance)}.`
              : "";
  const approve = short && !blocked && !free.length;
  const rest = paid.length ? ` Then this button buys ${names(paid)} from your wallet (${fmt(total)} IMD).` : "";
  const infoText = hold
    ? hold
    : free.length
      ? `The Treasury pays for the ${names(free.slice(0, 1))} update now (the protocol's rules allow it: a stale feed or a fall in IMD's price). You pay only gas.${rest}`
      : `Pays ${fmt(total)} IMD from your wallet${paid.length > 1 ? `, in one transaction, for ${paid.length} answers` : " for a fresh answer"} from swarm panels, usually within minutes. No protocol funds are spent.`;
  return (
    <div className="buy-update">
      <Action
        id={id}
        label={approve ? `Approve ${fmt(total)} IMD · ${label}` : label}
        actions={actions}
        disabled={!!blocked}
        reason={hold ? (holdNote ?? "") : blocked}
        request={() => {
          if (blocked) throw Error(blocked);
          if (free.length)
            return {
              target: { address: cfg.address, abi: askerAbi },
              fn: "ask",
              args: [s!.targets[free[0]].address, cfg.requests[free[0]]],
              summary: `The Treasury pays for a fresh ${free[0]} answer under the protocol's rules; this wallet pays only gas. It arrives once a swarm panel answers, usually within minutes.`,
            };
          if (short)
            return {
              target: { address: a.payToken, abi: erc20 },
              fn: "approve",
              args: [cfg.address, total],
              summary: `Approve exactly ${exact(total)} IMD for ${what}. The purchase is a separate transaction.`,
            };
          if (paid.length === 1)
            return {
              target: { address: cfg.address, abi: askerAbi },
              fn: "askPaid",
              args: [s!.targets[paid[0]].address, cfg.requests[paid[0]], a.price],
              summary: `Pay ${exact(a.price)} IMD from this wallet for a fresh ${paid[0]} answer. It arrives once a swarm panel answers, usually within minutes.`,
            };
          return {
            target: { address: cfg.address, abi: askerAbi },
            fn: "askPaidMany",
            args: [paid.map((n) => s!.targets[n].address), paid.map((n) => cfg.requests[n]), a.price],
            summary: `Pay ${exact(total)} IMD from this wallet, in one transaction, for fresh ${paid.join(" and ")} answers. Each arrives once its swarm panel answers, usually within minutes of each other.`,
          };
        }}
      />
      {info && (<Info
        label={label}
        text={infoText}
      />)}
    </div>
  );
}

/** Below this the asker can pay for only a few more Treasury-rule updates (four at 0.5 IMD), so the Oracle pane lets
 * anyone send it IMD. At or above it the control is not shown. */
export const TOP_UP_BELOW = 2n * 10n ** 18n;

/** Sending IMD to the asker, offered only while it holds under TOP_UP_BELOW. A plain ERC-20 transfer: the asker has
 * no withdraw, so what it is sent is spent only on updates its rules allow (`ask`), never returned. */
export function OracleTopUp({ r, s, actions }: { r: Runtime; s?: Snapshot; actions: Actions }) {
  const cfg = r.config.oracleAsker;
  const a = s?.asker === "unreadable" ? undefined : s?.asker;
  if (!cfg || !a || a.held >= TOP_UP_BELOW) return null;
  const left = a.price > 0n ? a.held / a.price : 0n;
  return (
    <section className="oracle-topup" aria-labelledby="oracle-topup-heading">
      <div className="section-label" id="oracle-topup-heading">
        Top up the oracle
        <Info
          label="Top up the oracle"
          text={`The request contract (OracleAsker) pays for the updates the protocol's rules allow: a feed near expiry, a feed stale long enough, or a fall in IMD's price. It holds ${fmt(a.held)} IMD. While it holds under ${fmt(TOP_UP_BELOW)}, anyone can send it IMD. It has no withdraw: IMD sent here is spent only on those updates and is never returned.`}
        />
      </div>
      <p className="micro danger-text">
        The oracle holds {fmt(a.held)} IMD, enough for {left.toString()} more Treasury-paid{" "}
        {left === 1n ? "update" : "updates"} at {fmt(a.price)} IMD each.
      </p>
      <ActionForm
        id="oracle-topup"
        label="Review top-up"
        actions={actions}
        target={{ address: a.payToken, abi: erc20 }}
        fn="transfer"
        fields={[
          {
            name: "IMD to send",
            kind: "amount",
            balance: { connected: !!actions.account, amount: a.balance, symbol: "IMD", decimals: 18 },
            max:
              a.balance !== undefined
                ? { value: a.balance, message: `This wallet holds ${exact(a.balance)} IMD.` }
                : undefined,
          },
        ]}
        mapArgs={(v) => [cfg.address, v[0]]}
        summary="Sends IMD from this wallet to the oracle's request contract. It pays only for updates the protocol's rules allow and cannot be withdrawn."
      />
    </section>
  );
}
