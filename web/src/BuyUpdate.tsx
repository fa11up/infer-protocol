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
      inFlight[name] = !/^0x0+$/.test(f[7]); // inFlight is the eighth member since treasuryPaid was added
    }),
  );
  const state: AskerState = { price, payToken, ready, inFlight };
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
        ? "An update is already on its way."
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
        reason={blocked}
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
        text={`Pays ${fmt(total)} IMD from your wallet${toBuy.length > 1 ? `, in one transaction, for ${toBuy.length} answers` : " for a fresh answer"} from swarm panels, usually within minutes. No protocol funds are spent.`}
      />)}
    </div>
  );
}
