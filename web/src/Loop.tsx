// The leverage window: pick a target leverage, see where the position lands, press one button. The window then runs
// as many rounds as it takes, re-reading the chain before each:
//   up    Borrow (`draw`) imdUSD -> swap to IMD -> Deposit (`lockIMD`, staked as sIMD);
//   down  Withdraw (`free`) sIMD -> unstake -> swap to imdUSD -> Repay (`wipe`).
// There is no imdUSD/IMD pool: a swap crosses imdUSD/USDC (the peg pool), USDC/ETH and ETH/IMD in one Universal
// Router call (leverage.ts, fork-tested in tests/loop.fork.test.mjs). Each round keeps the ratio between its two halves
// at minCR + BORROW_BUFFER, as the vault requires; the planner (planToTarget) splits a target into such rounds.
// Selling imdUSD under $0.9975 is allowed, but only after the viewer confirms the loss shown.
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import type { Runtime } from "./config";
import { feedsReady, type Snapshot } from "./state";
import { Row, type Actions, type Call, useBackdropClose, openModal } from "./actions";
import { StillFigures } from "./motion";
import { collateral, fmtGem, gemUnit, perImd, vaultShareAbi } from "./collateral";
import { fmt, liquidationPrice, message, BORROW_BUFFER } from "./math";
import { unit } from "./unit";
import { ceilingState } from "./Panes";
import { PriceStatus } from "./PriceStatus";
import { PERMIT2, UNIVERSAL_ROUTER } from "./infer/swap";
import {
  DOWN_PATH,
  ERC20,
  IMD,
  IMDUSD,
  PEG_FLOOR_USD,
  PEG_POOL_ID,
  QUOTER_PATH,
  RECOMMENDED_CR,
  SHARE,
  STATE_VIEW,
  UNISWAP,
  UP_PATH,
  WAD,
  crForLeverage,
  encodePathSwap,
  leverageAt,
  pegMarginalSell,
  pegQuoter,
  planToTarget,
  usdAtSqrt,
  type TargetPlan,
} from "./leverage";

/** Slippage allowed on each swap: a round's minimum out is this far under its quote. */
const SLIPPAGE_BPS = 100n;
/** A plan losing more than this to the swaps says so in red. */
const COSTLY_BPS = 300n;
const MAX_ROUNDS = 12;
/** The cost rounds are planned at: the quoted cost (never a gain) plus the slippage minimum. */
const planCost = (bps: bigint) => (bps > 0n ? bps : 0n) + SLIPPAGE_BPS;


/** Debt under a cent is the fee of the seconds between reading it and repaying it: shown as no debt. */
const DUST_DEBT = 10n ** 16n;
const crText = (cr: bigint | undefined, debt?: bigint) =>
  cr === undefined || (debt !== undefined && debt < DUST_DEBT) ? "no debt" : `${cr}%`;
const x = (l: bigint | undefined) => (l === undefined ? "—" : `${(Number(l) / 1e18).toFixed(2)}×`);
const pctText = (bps: bigint) => `${(Number(bps < 0n ? -bps : bps) / 100).toFixed(2)}%`;
/** A target: a ratio in whole percent, or undefined for no debt (1×). */
type Target = { key: string; label: string; cr?: bigint };
type Plan = TargetPlan & { up: boolean; costBps: bigint; pegNow?: bigint; pegEnd?: bigint };

export function LoopWindow({
  r,
  s,
  actions,
  onClose,
}: {
  r: Runtime;
  s?: Snapshot;
  actions: Actions;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<string>();
  const [plan, setPlan] = useState<Plan>();
  const [planError, setPlanError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [finished, setFinished] = useState("");
  const stop = useRef(false);
  // The whole run, rounds and the reads between them: actions.busy covers only the transactions.
  const [running, setRunning] = useState(false);
  // The running loop reads the newest snapshot, not the one it started with.
  const snap = useRef(s);
  snap.current = s;
  // And the newest actions: their readiness follows the terminal's refreshes, which a run spans.
  const live = useRef(actions);
  live.current = actions;

  useEffect(() => {
    openModal(dialog.current);
  }, []);

  const v = s?.v ?? {};
  const g = collateral();
  const vault = s?.targets.ParameterizedVault;
  const held = v.positions?.[0] as bigint | undefined;
  const debt = v.debtOf as bigint | undefined;
  const price = s?.feeds.Collateral?.value;
  const imdUsd = s?.feeds.USD?.value;
  const mat = v.mat as bigint | undefined;
  const floor = mat !== undefined ? mat + BORROW_BUFFER : undefined;
  const sized = held !== undefined && debt !== undefined && !!price && !!imdUsd && floor !== undefined && g.rate > 0n;
  const value = sized ? (held! * price!) / WAD : undefined;
  const crNow = sized && debt! >= DUST_DEBT ? (value! * 100n) / debt! : undefined;
  const levNow = sized ? leverageAt(crNow) : undefined;
  const fresh = feedsReady(s);
  const busy = !!actions.busy || running;
  const working = running;

  // The choices: back to 1×, a few round multiples, and the most the vault allows (its floor between halves).
  const targets: Target[] = [];
  if (sized) {
    if (debt! >= DUST_DEBT) targets.push({ key: "1", label: "Unwind" });
    for (const l of [150n, 175n, 200n]) {
      const cr = crForLeverage((l * WAD) / 100n)!;
      if (cr > floor!) targets.push({ key: String(l), label: `${Number(l) / 100}×`, cr });
    }
    targets.push({ key: "max", label: `Max ${x(leverageAt(floor))}`, cr: floor });
  }
  const target = targets.find((t) => t.key === choice);
  // A target within a point of where the position already is would plan nothing.
  const noop = !!target && (target.cr === undefined ? debt! < DUST_DEBT : crNow !== undefined && target.cr + 1n >= crNow && target.cr <= crNow + 1n);

  // Plan the chosen target: a first pass at a guessed cost, a quote of its total through the pools, then the plan at
  // the quoted cost; for a plan that sells imdUSD, where the peg pool stands now and after the last sale.
  useEffect(() => {
    // A run in progress keeps the plan it started with; the position moving under it is the run itself.
    if (running) return;
    setPlan(undefined);
    setPlanError("");
    setAccepted(false);
    if (!target || !sized || noop) return;
    let live = true;
    (async () => {
      const base = { value: value!, debt: debt!, target: target.cr, floorBetween: floor! };
      const ceiling = ceilingState(v);
      const first = planToTarget({ ...base, costBps: 100n });
      const up = target.cr !== undefined && (debt === 0n || value! * 100n > target.cr * debt!);
      if (first.rounds === 0) throw Error("Nothing to do: the vault's limits leave no room for a round toward this target.");
      let costBps: bigint;
      if (up) {
        const amount = ceiling && ceiling.left < first.stable ? ceiling.left : first.stable;
        if (amount <= 0n) throw Error("The borrowing cap is reached: no new debt until borrowers repay or governance raises it.");
        const [imdOut] = await r.client.readContract({
          address: UNISWAP.quoter,
          abi: QUOTER_PATH,
          functionName: "quoteExactInput",
          args: [{ exactCurrency: IMDUSD, path: [...UP_PATH], exactAmount: amount }],
        });
        const got = (imdOut * imdUsd!) / WAD;
        costBps = ((amount - got) * 10_000n) / amount;
      } else {
        const imdIn = (first.value * WAD) / imdUsd!;
        const [out] = await r.client.readContract({
          address: UNISWAP.quoter,
          abi: QUOTER_PATH,
          functionName: "quoteExactInput",
          args: [{ exactCurrency: IMD, path: [...DOWN_PATH], exactAmount: imdIn }],
        });
        costBps = ((first.value - out) * 10_000n) / first.value;
      }
      // A round deposits (or repays with) the swap's guaranteed minimum, SLIPPAGE_BPS under its quote. A swap that
      // gains (imdUSD above $1 on the way up, under it on the way down) is planned as free: rounds counted on a gain
      // would compound it, and the gain is gone after the first round moves the pool.
      const planned = planToTarget({ ...base, costBps: planCost(costBps) });
      let pegNow: bigint | undefined;
      let pegEnd: bigint | undefined;
      if (up) {
        const [slot0, end] = await Promise.all([
          r.client.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [PEG_POOL_ID] }),
          pegMarginalSell(pegQuoter(r.client), planned.stable),
        ]);
        pegNow = usdAtSqrt(slot0[0]);
        pegEnd = end;
      }
      if (live) setPlan({ ...planned, up, costBps, pegNow, pegEnd });
    })().catch((e) => live && setPlanError(message(e)));
    return () => {
      live = false;
    };
    // Re-plan when the target or the position changes, not on every 15-second snapshot.
  }, [choice, held, debt, !!sized, noop, running]);

  const depeg = !!plan?.up && ((plan.pegNow ?? WAD) < PEG_FLOOR_USD || (plan.pegEnd ?? 0n) < PEG_FLOOR_USD);
  const heldAfter = plan && price ? (plan.valueAfter * WAD) / price : undefined;
  const liqAfter = plan && mat !== undefined && heldAfter !== undefined ? perImd(liquidationPrice(heldAfter, plan.debtAfter, mat)) : undefined;
  const blocked = !sized
    ? "Waiting for your position and the vault's prices."
    : held === 0n
      ? "Deposit collateral first: leverage borrows against it."
      : !fresh
        ? "The vault's prices are out of date or disagree (its primary and spot IMD prices more than its skew apart), so it will not lend or release collateral. Update the price above, then pick a target."
        : "";

  async function go() {
    if (!plan || !target || !actions.sequence || !actions.account || !vault) return;
    setError("");
    setFinished("");
    stop.current = false;
    setRunning(true);
    const me = actions.account;
    // Reads retry twice on a slow or refused RPC answer: a passing timeout should not end a run. Transactions never retry.
    const read = async <T,>(args: any): Promise<T> => {
      for (let i = 0; ; i++) {
        try {
          return (await r.client.readContract(args)) as T;
        } catch (e) {
          if (i >= 2 || !/took too long|timed? ?out|fetch failed|rate limit|429|HTTP request failed/i.test(message(e))) throw e;
          await new Promise((d) => setTimeout(d, 2000 * (i + 1)));
        }
      }
    };
    const position = async () => {
      const [[h], d] = await Promise.all([
        read<readonly [bigint, bigint]>({ ...vault, functionName: "positions", args: [me] }),
        read<bigint>({ ...vault, functionName: "debtOf", args: [me] }),
      ]);
      const now = snap.current;
      const p = now?.feeds.Collateral?.value;
      const usd = now?.feeds.USD?.value;
      if (!p || !usd || !feedsReady(now)) throw Error("The vault's prices went out of date. Update the price, then continue.");
      return { held: h, debt: d, price: p, imdUsd: usd, value: (h * p) / WAD, deadline: (now!.timestamp ?? 0n) + 1800n };
    };
    // A token reaches the router through Permit2: the token approves Permit2, Permit2 approves the router. Exact
    // amounts, for 30 minutes; a step is skipped when the allowance already covers it.
    const approvals = async (token: Address, symbol: string, n: bigint, deadline: bigint): Promise<Call[]> => {
      const [erc, [p2, expires]] = await Promise.all([
        read<bigint>({ address: token, abi: ERC20, functionName: "allowance", args: [me, UNISWAP.permit2] }),
        read<readonly [bigint, number, number]>({ address: UNISWAP.permit2, abi: PERMIT2, functionName: "allowance", args: [me, token, UNISWAP.universalRouter] }),
      ]);
      const calls: Call[] = [];
      if (erc < n) calls.push({ target: { address: token, abi: ERC20 }, fn: "approve", args: [UNISWAP.permit2, n], label: `Approve ${symbol} for Permit2` });
      if (p2 < n || BigInt(expires) < deadline - 1500n)
        calls.push({
          target: { address: UNISWAP.permit2, abi: PERMIT2 },
          fn: "approve",
          args: [token, UNISWAP.universalRouter, n, Number(deadline)],
          label: `Let Uniswap's router spend ${symbol} (30 min)`,
        });
      return calls;
    };
    const router = { address: UNISWAP.universalRouter, abi: UNIVERSAL_ROUTER };
    // A refresh that failed locks the terminal until the next one succeeds (every 15 seconds): wait for it rather than
    // stopping the run on a passing read error.
    const settled = async () => {
      for (let i = 0; i < 60 && !live.current.ready; i++) await new Promise((d) => setTimeout(d, 1000));
      if (!live.current.ready) throw Error(live.current.reason || "The terminal could not refresh its state.");
    };
    const send = async (calls: Call[]) => {
      await settled();
      await live.current.sequence!("loop", { calls, batch: !!live.current.atomic });
    };
    const quote = async (currency: Address, path: typeof UP_PATH, amount: bigint) =>
      (await read<readonly [bigint, bigint]>({
        address: UNISWAP.quoter,
        abi: QUOTER_PATH,
        functionName: "quoteExactInput",
        args: [{ exactCurrency: currency, path: [...path], exactAmount: amount }],
      }))[0];
    let done = 0;
    try {
      for (; done < MAX_ROUNDS; done++) {
        if (stop.current) break;
        await settled();
        const p = await position();
        // Reached, or a round landed past the target: never turn round and go the other way.
        const upNow = target.cr !== undefined && (p.debt === 0n || p.value * 100n > target.cr * p.debt);
        if (upNow !== plan.up) break;
        const left = planToTarget({ value: p.value, debt: p.debt, target: target.cr, floorBetween: floor!, costBps: planCost(plan.costBps) });
        if (left.rounds === 0) break;
        const next = planToTarget({ value: p.value, debt: p.debt, target: target.cr, floorBetween: floor!, costBps: planCost(plan.costBps), limit: 1 });
        const of = `Round ${done + 1} of about ${done + left.rounds}`;
        if (plan.up) {
          const cap = ceilingState(snap.current?.v ?? {});
          const borrow = cap && cap.left < next.stable ? cap.left : next.stable;
          if (borrow < WAD) break;
          const imdOut = await quote(IMDUSD, UP_PATH, borrow);
          const minImd = (imdOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
          const swap = encodePathSwap({ currencyIn: IMDUSD, path: UP_PATH, amountIn: borrow, minOut: minImd });
          const imdAllowance = await read<bigint>({ address: IMD, abi: ERC20, functionName: "allowance", args: [me, vault.address] });
          setProgress(`${of}: borrow ${fmt(borrow, 18, 2)} ${unit()}, swap it to IMD, deposit.`);
          await send([
            { target: vault, fn: "draw", args: [borrow], label: `Borrow ${fmt(borrow, 18, 2)} ${unit()}` },
            ...(await approvals(IMDUSD, unit(), borrow, p.deadline)),
            { target: router, fn: "execute", args: [swap.commands, swap.inputs, p.deadline], label: `Swap ${unit()} for at least ${fmt(minImd, 18, 4)} IMD` },
            ...(imdAllowance < minImd ? [{ target: { address: IMD, abi: ERC20 }, fn: "approve", args: [vault.address, minImd], label: "Approve IMD for the vault" }] : []),
            { target: { address: vault.address, abi: vaultShareAbi }, fn: "lockIMD", args: [minImd], label: `Deposit ${fmt(minImd, 18, 4)} IMD` },
          ]);
        } else {
          const shares = (next.value * WAD) / p.price;
          const withdraw = shares < p.held ? shares : p.held;
          if (withdraw === 0n) break;
          setProgress(`${of}: withdraw ${fmtGem(withdraw)} ${gemUnit()}.`);
          // Its own transaction: sIMD withdrawn in a block cannot be unstaked in that same block.
          await send([{ target: vault, fn: "free", args: [withdraw], label: `Withdraw ${fmtGem(withdraw)} ${gemUnit()}` }]);
          const gem = snap.current!.targets.gem.address;
          const imdIn = await read<bigint>({ address: gem, abi: SHARE, functionName: "previewRedeem", args: [withdraw] });
          const out = await quote(IMD, DOWN_PATH, imdIn);
          const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
          const owed = await read<bigint>({ ...vault, functionName: "debtOf", args: [me] });
          const repay = minOut < owed ? minOut : owed;
          const swap = encodePathSwap({ currencyIn: IMD, path: DOWN_PATH, amountIn: imdIn, minOut });
          setProgress(`${of}: unstake, swap to ${unit()}, repay ${fmt(repay, 18, 2)}.`);
          await send([
            { target: { address: gem, abi: SHARE }, fn: "redeem", args: [withdraw, me, me], label: `Unstake ${fmtGem(withdraw)} ${gemUnit()} to IMD` },
            ...(await approvals(IMD, "IMD", imdIn, p.deadline)),
            { target: router, fn: "execute", args: [swap.commands, swap.inputs, p.deadline], label: `Swap IMD for at least ${fmt(minOut, 18, 2)} ${unit()}` },
            { target: vault, fn: "wipe", args: [repay], label: `Repay ${fmt(repay, 18, 2)} ${unit()}` },
          ]);
        }
      }
      const end = await position();
      const cr = end.debt >= DUST_DEBT ? (end.value * 100n) / end.debt : undefined;
      setFinished(
        `${stop.current ? "Stopped" : "Done"} after ${done} round${done === 1 ? "" : "s"}: leverage ${x(leverageAt(cr))}, ratio ${crText(cr)}.` +
          (end.debt > 0n && end.debt < DUST_DEBT
            ? ` The fee of the last few seconds (${fmt(end.debt, 18, 8)} ${unit()}) is still owed; Repay clears it.`
            : "") +
          " Anything a swap returned above its minimum is in your wallet.",
      );
      setChoice(undefined);
    } catch (e) {
      setError(
        `${done ? `${done} round${done === 1 ? "" : "s"} went through, then the run stopped: ` : "The run stopped before any round went through: "}${message(e)} Pick the target again to continue from where your position is now.`,
      );
    } finally {
      setProgress("");
      setRunning(false);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };
  const backdrop = useBackdropClose(close);
  const short = target?.label.replace("Max ", "").replace("Unwind", "1×");
  const action = !target
    ? "Pick a target"
    : target.cr === undefined
      ? "Repay all and unwind"
      : plan && !plan.up
        ? `Reduce to ${short}`
        : `Leverage to ${short}`;

  return (
    <StillFigures.Provider value={true}>
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="loop-dialog"
      aria-labelledby="loop-heading"
      {...backdrop}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="loop-heading">Loop leverage</h2>
      <p className="micro">
        Leverage borrows {unit()}, swaps it for IMD and deposits it, in rounds, until your position reaches the target.
        Going down does the reverse. More leverage means a higher liquidation price.
      </p>
      <div className="loop-now">
        <Row label="Now">
          {x(levNow)} · {crText(crNow)}
        </Row>
      </div>
      {!fresh && sized && <PriceStatus r={r} s={s} now={s?.timestamp ?? 0n} actions={actions} where="loop" slim />}
      {sized && (
        <div className="loop-targets choice" role="group" aria-label="Target leverage">
          {targets.map((t) => (
            <button
              type="button"
              key={t.key}
              aria-pressed={choice === t.key}
              disabled={busy || !!blocked}
              onClick={() => {
                setChoice(t.key);
                setError("");
                setFinished("");
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      {noop && <p className="micro">Your position is already there.</p>}
      {plan && target && !noop && (
        <div className="loop-plan">
          <Row label="After">
            {x(leverageAt(plan.crAfter))} · {crText(plan.crAfter, plan.debtAfter)}
          </Row>
          <Row label="Liquidation price">{liqAfter === undefined ? "No debt" : `$${fmt(liqAfter)} / IMD`}</Row>
          <Row label={plan.up ? "Borrows" : "Repays"}>
            {fmt(plan.stable, 18, 2)} {unit()}
          </Row>
          <Row
            label={plan.costBps < 0n ? "Swap gain" : "Swap cost"}
            info="What the swaps lose (or gain) against the vault's own IMD price: pool fees, price impact, and imdUSD's distance from $1."
          >
            <span className={plan.costBps > COSTLY_BPS ? "danger-text" : undefined}>
              {pctText(plan.costBps)} ≈ ${fmt(((plan.up ? plan.stable : plan.value) * (plan.costBps < 0n ? -plan.costBps : plan.costBps)) / 10_000n, 18, 2)}
            </span>
          </Row>
          <Row label="Rounds">
            {plan.rounds} {actions.atomic ? "(one signature each)" : "(a few wallet prompts each)"}
          </Row>
          {plan.crAfter !== undefined && plan.crAfter < RECOMMENDED_CR && (
            <p className="micro danger-text">
              Under {String(RECOMMENDED_CR)}% the position can be redeemed against, and a fall in IMD of about{" "}
              {String(((plan.crAfter - (mat ?? 0n)) * 100n) / plan.crAfter)}% reaches the {String(mat)}% minimum, where it is
              liquidated with a penalty.
            </p>
          )}
        </div>
      )}
      {depeg && plan && (
        <label className="loop-check danger-text">
          <input type="checkbox" checked={accepted} disabled={busy} onChange={(e) => setAccepted(e.target.checked)} />
          {unit()} trades at ${fmt(plan.pegNow, 18, 4)} on the pool
          {plan.pegEnd !== undefined && plan.pegEnd < (plan.pegNow ?? WAD) ? `, and these sales take it to $${fmt(plan.pegEnd, 18, 4)}` : ""}: you
          borrow at $1 and sell under it, losing about {pctText(plan.costBps)}, and push {unit()} further from $1. I accept.
        </label>
      )}
      {progress && <p className="micro">{progress}</p>}
      <div role="status" className="action-note">
        {error ? (
          // A run's error stays: it says how far the run got, and the position has moved since the plan.
          <span className="danger-text">{error}</span>
        ) : (
          finished || blocked || planError || (target && !plan && !noop ? "Planning…" : "") || (!actions.ready ? actions.reason : "")
        )}
      </div>
      <div className="button-row">
        {working ? (
          <button type="button" onClick={() => (stop.current = true)}>
            Stop after this round
          </button>
        ) : (
          <button type="button" onClick={close}>
            Close
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={!actions.ready || busy || !plan || !!blocked || noop || (depeg && !accepted)}
          onClick={() => void go()}
        >
          {working ? "Working…" : action}
        </button>
      </div>
      <p className="micro">
        Each round is simulated before it is signed; swaps go through Uniswap from your wallet with at most{" "}
        {pctText(SLIPPAGE_BPS)} slippage. You can stop between rounds.
      </p>
    </dialog>
    </StillFigures.Provider>
  );
}
