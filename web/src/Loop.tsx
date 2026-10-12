// The leverage window: rounds up (Borrow -> swap to IMD -> Deposit) and down (Withdraw -> unstake -> swap to imdUSD
// -> Repay), one round per confirmation, every round quoted against the live pools and the vault's own figures
// before it is signed. The arithmetic and calldata live in leverage.ts (fork-tested: tests/loop.fork.test.mjs).
//
// Limits, each for a reason:
//  * straight after the borrow (before the deposit lands) and straight after the withdrawal (before the repayment
//    lands) the ratio must stay at minCR + BORROW_BUFFER: the vault checks it there, and between two transactions a
//    position sits there for a block or more;
//  * a round never sells imdUSD below $0.9975 on the peg pool (the hook's fee-free band), measured from quotes;
//  * the window recommends stopping at 220% (minCR + gap: below it the position can be redeemed against) and lets
//    the borrower go lower with a warning, never below minCR + BORROW_BUFFER.
import { useEffect, useMemo, useRef, useState } from "react";
import { wallet, type Runtime } from "./config";
import { feedsReady, type Snapshot } from "./state";
import { Choice, FadingError, Info, Row, type Actions, type Call } from "./actions";
import { collateral, fmtGem, gemUnit, perImd, parseGem, vaultShareAbi } from "./collateral";
import { amount, exact, fmt, liquidationPrice, message, BORROW_BUFFER } from "./math";
import { unit } from "./unit";
import { ceilingState } from "./Panes";
import { PERMIT2, UNIVERSAL_ROUTER } from "./infer/swap";
import {
  CAUTION_CR,
  DOWN_PATH,
  DOWN_TO_USDC,
  ERC20,
  IMD,
  IMDUSD,
  LOOP_CHAIN_ID,
  PEG_CEILING_USD,
  PEG_FLOOR_USD,
  PEG_POOL_ID,
  QUOTER_PATH,
  RECOMMENDED_CR,
  SHARE,
  STATE_VIEW,
  UNISWAP,
  UP_PATH,
  downRound,
  encodePathSwap,
  leverageAt,
  maxDown,
  maxUp,
  pegMarginalBuy,
  pegMarginalSell,
  pegQuoter,
  pegSellCap,
  upRound,
  usdAtSqrt,
  type DownRound,
  type UpRound,
} from "./leverage";

/** Slippage allowed on each swap: the round's minimum out is this far under its quote. */
const SLIPPAGE_BPS = 100n;
/** A round losing more than this to the swap is warned about. */
const COSTLY_BPS = 300n;
/** The peg cap is a dozen quotes: re-measured at most this often. */
const PEG_CAP_TTL_MS = 30_000;
const WAD = 10n ** 18n;

/** The loop exists only where its pools do: mainnet, sIMD collateral over IMD, the imdUSD the peg pool trades. */
export function loopAvailable(r: Runtime, s?: Snapshot) {
  const t = s?.targets;
  return (
    r.config.chainId === LOOP_CHAIN_ID &&
    collateral().share &&
    t?.stablecoin?.address.toLowerCase() === IMDUSD.toLowerCase() &&
    t?.underlying?.address.toLowerCase() === IMD.toLowerCase()
  );
}

const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const lev = (cr: bigint | undefined) => {
  const l = leverageAt(cr);
  return l === undefined ? "—" : `${(Number(l) / 1e18).toFixed(2)}×`;
};
const crText = (cr: bigint | undefined) => (cr === undefined ? "No debt" : `${cr}%`);

type Quote<T> = { key: string; round?: T; error?: string };

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
  const [mode, setMode] = useState<"up" | "down">("up");
  const [stop, setStop] = useState(String(RECOMMENDED_CR));
  const [input, setInput] = useState("");
  const [typed, setTyped] = useState("");
  const [atomic, setAtomic] = useState<boolean>();
  const [batch, setBatch] = useState(true);
  const [pegCap, setPegCap] = useState<{ cap: bigint; at: number; usd: bigint }>();
  const [pegError, setPegError] = useState("");
  const [up, setUp] = useState<Quote<UpRound>>();
  const [down, setDown] = useState<Quote<DownRound>>();
  const [steps, setSteps] = useState<{ labels: string[]; done: number }>();
  const [error, setError] = useState("");
  const [finished, setFinished] = useState("");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const v = s?.v ?? {};
  const g = collateral();
  const vault = s?.targets.ParameterizedVault;
  const held = v.positions?.[0] as bigint | undefined;
  const debt = v.debtOf as bigint | undefined;
  const price = s?.feeds.Collateral?.value;
  const imdUsd = s?.feeds.USD?.value;
  const mat = v.mat as bigint | undefined;
  const floorBetween = mat !== undefined ? mat + BORROW_BUFFER : undefined;
  const target = BigInt(stop);
  const sized = held !== undefined && debt !== undefined && !!price && !!imdUsd && mat !== undefined && g.rate > 0n;
  const crNow = sized ? (debt! > 0n ? (held! * price!) / (debt! * 10n ** 16n) : undefined) : undefined;
  const busy = !!actions.busy;
  const working = actions.busy === "loop";

  // Whether the wallet can send an atomic batch (EIP-5792): asked once per account.
  useEffect(() => {
    const p = window.ethereum;
    if (!p || !actions.account) return;
    let live = true;
    wallet(r, p)
      .getCapabilities({ account: actions.account, chainId: r.config.chainId })
      .then((c: any) => live && setAtomic(c?.atomic?.status === "supported" || c?.atomic?.status === "ready"))
      .catch(() => live && setAtomic(false));
    return () => {
      live = false;
    };
  }, [r, actions.account]);

  // The peg pool: its price now and how much imdUSD one round may sell into it. A dozen quotes, so it runs on its
  // own clock (at most every PEG_CAP_TTL_MS) and is not restarted by every 15-second refresh of the snapshot.
  const measuring = useRef(false);
  const mounted = useRef(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (!s || measuring.current || (pegCap && Date.now() - pegCap.at < PEG_CAP_TTL_MS)) return;
    measuring.current = true;
    Promise.all([
      r.client.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [PEG_POOL_ID] }),
      pegSellCap(pegQuoter(r.client)),
    ])
      .then(([slot0, cap]) => {
        if (!mounted.current) return;
        setPegCap({ cap, at: Date.now(), usd: usdAtSqrt(slot0[0]) });
        setPegError("");
      })
      .catch((e) => mounted.current && setPegError(message(e)))
      .finally(() => (measuring.current = false));
  }, [r, !!s, tick, pegCap]);

  // Quote the typed amount once typing pauses.
  useEffect(() => {
    const id = setTimeout(() => setTyped(input), 350);
    return () => clearTimeout(id);
  }, [input]);

  const parsed = useMemo(() => {
    try {
      return mode === "up" ? amount(typed, 18) : parseGem(typed);
    } catch {
      return undefined;
    }
  }, [typed, mode]);

  useEffect(() => {
    if (!sized || parsed === undefined || !s) return;
    const key = `${mode}:${parsed}:${s.block}`;
    let live = true;
    (async () => {
      if (mode === "up") {
        const [quoted, pegAfter] = await Promise.all([
          r.client.readContract({
            address: UNISWAP.quoter,
            abi: QUOTER_PATH,
            functionName: "quoteExactInput",
            args: [{ exactCurrency: IMDUSD, path: [...UP_PATH], exactAmount: parsed }],
          }),
          pegMarginalSell(pegQuoter(r.client), parsed),
        ]);
        const round = upRound({
          borrow: parsed,
          imdOut: quoted[0],
          slippageBps: SLIPPAGE_BPS,
          held: held!,
          debt: debt!,
          price: price!,
          imdUsd: imdUsd!,
          rate: g.rate,
          pegAfter,
        });
        if (live) setUp({ key, round });
      } else {
        const imdIn = (await r.client.readContract({
          address: s.targets.gem.address,
          abi: SHARE,
          functionName: "previewRedeem",
          args: [parsed],
        })) as bigint;
        const [quoted, usdc] = await Promise.all([
          r.client.readContract({
            address: UNISWAP.quoter,
            abi: QUOTER_PATH,
            functionName: "quoteExactInput",
            args: [{ exactCurrency: IMD, path: [...DOWN_PATH], exactAmount: imdIn }],
          }),
          r.client.readContract({
            address: UNISWAP.quoter,
            abi: QUOTER_PATH,
            functionName: "quoteExactInput",
            args: [{ exactCurrency: IMD, path: [...DOWN_TO_USDC], exactAmount: imdIn }],
          }),
        ]);
        const pegAfter = await pegMarginalBuy(pegQuoter(r.client, "buy"), usdc[0]);
        const round = downRound({
          pegAfter,
          withdraw: parsed,
          imdIn,
          imdusdOut: quoted[0],
          slippageBps: SLIPPAGE_BPS,
          held: held!,
          debt: debt!,
          price: price!,
          imdUsd: imdUsd!,
        });
        if (live) setDown({ key, round });
      }
    })().catch(() => {
      const text = "The pools cannot fill this amount. Try a smaller round.";
      if (!live) return;
      if (mode === "up") setUp({ key, error: text });
      else setDown({ key, error: text });
    });
    return () => {
      live = false;
    };
  }, [mode, parsed, s?.block, sized]);

  const ceiling = ceilingState(v);
  const upQuote = up && parsed !== undefined && up.key.startsWith(`up:${parsed}:`) ? up : undefined;
  const downQuote = down && parsed !== undefined && down.key.startsWith(`down:${parsed}:`) ? down : undefined;
  const lastCost = (mode === "up" ? up?.round?.costBps : down?.round?.costBps) ?? (mode === "up" ? 300n : 500n);
  const most = !sized || (mode === "up" && !pegCap)
    ? undefined
    : mode === "up"
      ? maxUp({
          held: held!,
          debt: debt!,
          price: price!,
          floorBetween: floorBetween!,
          target,
          costBps: lastCost,
          pegCap: pegCap?.cap,
          ceilingLeft: ceiling?.left,
        })
      : maxDown({ held: held!, debt: debt!, price: price!, floorBetween: floorBetween!, costBps: lastCost });

  // Why this round cannot be sent, or "".
  const round = mode === "up" ? upQuote?.round : downQuote?.round;
  const refusal = (() => {
    if (!sized) return "Waiting for your position and fresh prices.";
    if (mode === "up" && held === 0n) return "Deposit collateral first: a round borrows against it.";
    if (mode === "down" && debt === 0n) return "No debt to unwind. Withdraw collateral from the Position pane.";
    // Borrowing, and withdrawing with debt, need fresh agreeing prices: say so before anything is quoted.
    if (!feedsReady(s))
      return "The vault's prices are stale or disagree, so it refuses to borrow or withdraw against debt. Close this window and use Update price in the Position pane first.";
    if (parsed === undefined || parsed === 0n) return "";
    if (mode === "up" && ceiling?.reached) return "The borrowing cap is reached: no new debt until borrowers repay or governance raises it.";
    const q = mode === "up" ? upQuote : downQuote;
    if (!q) return "Quoting…";
    if (q.error) return q.error;
    if (round?.crBetween !== undefined && round.crBetween < floorBetween!)
      return mode === "up"
        ? `Straight after the borrow your ratio would be ${round.crBetween}%, under ${floorBetween}%: the vault checks it before the deposit lands. Borrow less.`
        : `Straight after the withdrawal your ratio would be ${round.crBetween}%, under ${floorBetween}%: the vault checks it before the repayment lands. Withdraw less.`;
    if (mode === "up") {
      const u = round as UpRound;
      if (u.crAfter !== undefined && u.crAfter < floorBetween!)
        return `This round would end at ${u.crAfter}%, under ${floorBetween}%. Borrow less.`;
      // Never sell on an unmeasured peg: the cap or this round's own last-unit price must say it stays in the band.
      if (!pegCap) return pegError ? "The peg pool could not be read. Refresh and try again." : "Measuring the peg pool…";
      if (u.pegAfter === undefined || u.pegAfter < PEG_FLOOR_USD || parsed > pegCap.cap)
        return pegCap.cap === 0n
          ? `The peg pool is at or under $0.9975 already: selling ${unit()} into it now would push it further from $1. Try later, or deleverage.`
          : `The peg pool takes about ${fmt(pegCap.cap, 18, 2)} ${unit()} in one round before ${unit()} sells under $0.9975. Borrow less; run another round after.`;
    }
    if (mode === "down" && held !== undefined && parsed > held) return `You have ${fmtGem(held)} ${gemUnit()} deposited.`;
    return "";
  })();

  const warnings: string[] = [];
  if (round && !refusal) {
    const after = round.crAfter;
    if (mode === "up" && after !== undefined && after < RECOMMENDED_CR)
      warnings.push(
        `This round ends at ${after}%, under the recommended ${RECOMMENDED_CR}%. Below ${RECOMMENDED_CR}% your position can be redeemed against: anyone holding ${unit()} can repay part of your debt and take collateral of the same value at the vault's price, unwinding your leverage without asking you.`,
      );
    if (mode === "up" && after !== undefined && after < CAUTION_CR && mat !== undefined)
      warnings.push(
        `At ${after}% a ${pct(((after - mat) * 10_000n) / after)} fall in IMD takes the position to the ${mat}% minimum, where it can be marked and then liquidated with a 20% penalty.`,
      );
    const peg = (round as DownRound).pegAfter;
    if (mode === "down" && peg !== undefined && peg > PEG_CEILING_USD)
      warnings.push(
        `This round buys ${unit()} up to about $${fmt(peg, 18, 4)} on the peg pool. Above $1.0025 the pool charges a surcharge that goes to the Treasury, so a smaller round, or one after the price settles, costs less.`,
      );
    if (round.costBps > COSTLY_BPS)
      warnings.push(
        `This round loses ${pct(round.costBps)} of its value to the swap, measured at the vault's IMD price: the 1% ETH/IMD pool fee, the 0.05% ETH/USDC fee, price impact and the peg pool.`,
      );
  }

  async function send() {
    setError("");
    setFinished("");
    try {
      if (!actions.sequence || !actions.account || !s || !vault || !round) throw Error("Not ready.");
      const me = actions.account;
      const deadline = s.timestamp + 1800n;
      const allowance = (token: `0x${string}`, spender: `0x${string}`) =>
        r.client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [me, spender] }) as Promise<bigint>;
      const permit = (token: `0x${string}`) =>
        r.client.readContract({
          address: UNISWAP.permit2,
          abi: PERMIT2,
          functionName: "allowance",
          args: [me, token, UNISWAP.universalRouter],
        }) as Promise<readonly [bigint, number, number]>;
      // A token reaches the router through Permit2: the token approves Permit2, Permit2 approves the router. Exact
      // amounts, the router's for 30 minutes; a step is skipped when the allowance already covers this round.
      const approvals = async (token: `0x${string}`, symbol: string, n: bigint): Promise<Call[]> => {
        const [erc, [p2, expires]] = await Promise.all([allowance(token, UNISWAP.permit2), permit(token)]);
        const calls: Call[] = [];
        if (erc < n)
          calls.push({ target: { address: token, abi: ERC20 }, fn: "approve", args: [UNISWAP.permit2, n], label: `Approve ${symbol} for Permit2` });
        if (p2 < n || BigInt(expires) < s.timestamp + 300n)
          calls.push({
            target: { address: UNISWAP.permit2, abi: PERMIT2 },
            fn: "approve",
            args: [token, UNISWAP.universalRouter, n, Number(deadline)],
            label: `Let Uniswap's router spend ${symbol} (30 min)`,
          });
        return calls;
      };
      const router = { address: UNISWAP.universalRouter, abi: UNIVERSAL_ROUTER };
      const run = async (calls: Call[]) => {
        setSteps({ labels: calls.map((c) => c.label), done: 0 });
        await actions.sequence!("loop", {
          calls,
          batch: !!atomic && batch,
          onStep: (done) => setSteps((x) => x && { ...x, done }),
        });
      };

      if (mode === "up") {
        const u = round as UpRound;
        const swap = encodePathSwap({ currencyIn: IMDUSD, path: UP_PATH, amountIn: u.borrow, minOut: u.minImd });
        const imdAllowance = await allowance(IMD, vault.address);
        await run([
          { target: vault, fn: "draw", args: [u.borrow], label: `Borrow ${exact(u.borrow)} ${unit()}` },
          ...(await approvals(IMDUSD, unit(), u.borrow)),
          {
            target: router,
            fn: "execute",
            args: [swap.commands, swap.inputs, deadline],
            label: `Swap ${unit()} for at least ${fmt(u.minImd, 18, 4)} IMD`,
          },
          ...(imdAllowance < u.minImd
            ? [{ target: { address: IMD, abi: ERC20 }, fn: "approve", args: [vault.address, u.minImd], label: "Approve IMD for the vault" }]
            : []),
          {
            target: { address: vault.address, abi: vaultShareAbi },
            fn: "lockIMD",
            args: [u.minImd],
            label: `Deposit ${fmt(u.minImd, 18, 4)} IMD`,
          },
        ]);
        setFinished(
          `Round done: borrowed ${fmt(u.borrow, 18, 2)} ${unit()} and deposited ${fmt(u.minImd, 18, 4)} IMD. Any IMD the swap returned above its minimum is in your wallet.`,
        );
      } else {
        const d = round as DownRound;
        // Part one alone: sIMD withdrawn in a block cannot be unstaked in that same block.
        await run([{ target: vault, fn: "free", args: [d.withdraw], label: `Withdraw ${fmtGem(d.withdraw)} ${gemUnit()}` }]);
        // Part two, re-read and re-quoted now that the withdrawal has landed.
        const imdIn = (await r.client.readContract({
          address: s.targets.gem.address,
          abi: SHARE,
          functionName: "previewRedeem",
          args: [d.withdraw],
        })) as bigint;
        const [out] = await r.client.readContract({
          address: UNISWAP.quoter,
          abi: QUOTER_PATH,
          functionName: "quoteExactInput",
          args: [{ exactCurrency: IMD, path: [...DOWN_PATH], exactAmount: imdIn }],
        });
        const minOut = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n;
        if (minOut < d.minImdusd)
          throw Error(
            `The price moved after the withdrawal: the swap now returns at least ${fmt(minOut, 18, 2)} ${unit()}, under the ${fmt(d.minImdusd, 18, 2)} you reviewed. Your ${gemUnit()} is in your wallet; review the round again or repay from the Position pane.`,
          );
        const owed = (await r.client.readContract({ ...vault, functionName: "debtOf", args: [me] })) as bigint;
        const repay = minOut < owed ? minOut : owed;
        const swap = encodePathSwap({ currencyIn: IMD, path: DOWN_PATH, amountIn: imdIn, minOut });
        await run([
          {
            target: { address: s.targets.gem.address, abi: SHARE },
            fn: "redeem",
            args: [d.withdraw, me, me],
            label: `Unstake ${fmtGem(d.withdraw)} ${gemUnit()} to IMD`,
          },
          ...(await approvals(IMD, "IMD", imdIn)),
          {
            target: router,
            fn: "execute",
            args: [swap.commands, swap.inputs, s.timestamp + 1800n],
            label: `Swap IMD for at least ${fmt(minOut, 18, 2)} ${unit()}`,
          },
          { target: vault, fn: "wipe", args: [repay], label: `Repay ${fmt(repay, 18, 2)} ${unit()}` },
        ]);
        setFinished(
          `Round done: withdrew ${fmtGem(d.withdraw)} ${gemUnit()} and repaid ${fmt(repay, 18, 2)} ${unit()}. Any ${unit()} the swap returned above that is in your wallet.`,
        );
      }
      setInput("");
      // The round moved the peg pool: measure it again before the next one.
      setPegCap(undefined);
    } catch (e) {
      const text = message(e);
      // A wallet without EIP-5792 refuses the batch: fall back to one transaction per step.
      if (/wallet_sendCalls|does not support|not supported|method not found|4200/i.test(text)) setAtomic(false);
      setError(text);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };
  const heldAfter = mode === "up" ? (round as UpRound | undefined)?.sharesIn : undefined;
  const liqAfter =
    round && sized && mat !== undefined
      ? mode === "up"
        ? perImd(liquidationPrice(held! + (heldAfter ?? 0n), debt! + (round as UpRound).borrow, mat))
        : perImd(liquidationPrice(held! - (round as DownRound).withdraw, debt! - (round as DownRound).repay, mat))
      : undefined;
  const usingBatch = !!atomic && batch;

  return (
    <dialog
      ref={dialog}
      className="loop-dialog"
      aria-labelledby="loop-heading"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="loop-heading">Leverage</h2>
      <Choice
        label="Direction"
        value={mode}
        onChange={(x) => {
          if (busy) return;
          setMode(x as "up" | "down");
          setInput("");
          setError("");
          setFinished("");
          setSteps(undefined);
        }}
        options={[
          ["up", "Leverage up"],
          ["down", "Deleverage"],
        ]}
      />
      <div className="loop-now">
        <Row label="Ratio now">{crText(crNow)}</Row>
        <Row label="Leverage now">{lev(crNow)}</Row>
        <Row label="Peg pool">{pegCap ? `$${fmt(pegCap.usd, 18, 4)}` : pegError ? "unreadable" : "…"}</Row>
      </div>
      <p className="micro">
        {mode === "up"
          ? `One round borrows ${unit()}, swaps it for IMD through the ${unit()}/USDC, USDC/ETH and ETH/IMD pools, and deposits the IMD as collateral. Repeat for more leverage.`
          : `One round withdraws ${gemUnit()}, unstakes it to IMD, swaps that for ${unit()} through the same three pools, and repays your debt.`}
      </p>
      {mode === "up" && (
        <div className="field">
          <span className="select-label">
            Stop at
            <Info
              label="Stop at"
              text={`The ratio "Max" aims for once the deposit lands. ${RECOMMENDED_CR}% is recommended: below it the position can be redeemed against. The window never goes under ${floorBetween ?? "—"}%.`}
            />
          </span>
          <Choice
            label="Stop at"
            value={stop}
            onChange={setStop}
            options={[
              [String(RECOMMENDED_CR), `${RECOMMENDED_CR}% · recommended`],
              ["200", "200%"],
              ["190", "190%"],
              [String(floorBetween ?? 180n), `${floorBetween ?? 180n}%`],
            ]}
          />
        </div>
      )}
      <div className="field">
        <label>
          {mode === "up" ? `Borrow ${unit()}` : `Withdraw ${gemUnit()}`}
          <input
            name="loop-amount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={input}
            disabled={busy}
            onChange={(e) => {
              setInput(e.target.value);
              setFinished("");
              setError("");
            }}
          />
        </label>
        {most !== undefined && (
          <button
            type="button"
            className="balance-hint balance-use"
            disabled={busy || most === 0n}
            title={mode === "up" ? exact(most) : fmtGem(most, 8)}
            onClick={() => {
              setInput(mode === "up" ? exact(most) : formatGemExact(most));
              setFinished("");
              setError("");
            }}
          >
            Max {mode === "up" ? `${fmt(most, 18, 2)} ${unit()}` : `${fmtGem(most)} ${gemUnit()}`}
          </button>
        )}
      </div>
      {round && !refusal ? (
        <div className="loop-plan">
          {mode === "up" ? (
            <>
              <Row label="You get">≈ {fmt((round as UpRound).imdOut, 18, 4)} IMD</Row>
              <Row label="Deposited (minimum)" info="The swap's guaranteed minimum (1% under the quote) is deposited; anything above it stays in your wallet.">
                {fmt((round as UpRound).minImd, 18, 4)} IMD
              </Row>
              <Row label="Peg after" info={`The price the round's last ${unit()} sells at on the peg pool. Rounds stop at $0.9975.`}>
                {(round as UpRound).pegAfter !== undefined ? `$${fmt((round as UpRound).pegAfter, 18, 4)}` : "—"}
              </Row>
            </>
          ) : (
            <>
              <Row label="Unstakes to">≈ {fmt((round as DownRound).imdIn, 18, 4)} IMD</Row>
              <Row label="Swap returns">≈ {fmt((round as DownRound).imdusdOut, 18, 2)} {unit()}</Row>
              <Row label="Repaid (minimum)" info="The swap's guaranteed minimum, or your whole debt if that is less.">
                {fmt((round as DownRound).repay, 18, 2)} {unit()}
              </Row>
              <Row label="Peg after" info={`The price the round's last ${unit()} costs on the peg pool. Above $1.0025 the pool adds a surcharge.`}>
                {(round as DownRound).pegAfter !== undefined ? `$${fmt((round as DownRound).pegAfter, 18, 4)}` : "—"}
              </Row>
            </>
          )}
          <Row label="Swap cost" info="Value lost in the swap, measured at the vault's own IMD price: pool fees, price impact and any peg-pool surcharge.">
            {pct(round.costBps)}
          </Row>
          <Row label={mode === "up" ? "Ratio after borrow" : "Ratio after withdrawal"} info="Where the position sits between the two halves of the round. The vault checks it here.">
            {crText(round.crBetween)}
          </Row>
          <Row label="Ratio after round">{crText(round.crAfter)}</Row>
          <Row label="Leverage after">{lev(round.crAfter)}</Row>
          <Row label="Liquidation price">{liqAfter !== undefined ? `$${fmt(liqAfter)} / IMD` : "—"}</Row>
        </div>
      ) : null}
      {warnings.map((w) => (
        <p key={w} className="danger-text review-warning" role="alert">
          {w}
        </p>
      ))}
      {atomic !== undefined && (
        <div className="loop-mode">
          {atomic ? (
            <label className="loop-check">
              <input type="checkbox" checked={batch} disabled={busy} onChange={(e) => setBatch(e.target.checked)} />
              One signature: the whole {mode === "up" ? "round" : "second part"} as one all-or-nothing batch
            </label>
          ) : (
            <p className="micro">Your wallet signs each step as its own transaction. If one stops, the window says where.</p>
          )}
          {mode === "down" && (
            <p className="micro">
              Deleveraging is two parts: the withdrawal first, then the rest, because {gemUnit()} withdrawn in a block
              cannot be unstaked in that block.
            </p>
          )}
        </div>
      )}
      {steps && (
        <ol className="loop-steps" aria-label="Steps">
          {steps.labels.map((label, i) => (
            <li key={i} data-state={i < steps.done ? "done" : working && i === steps.done ? "active" : "waiting"}>
              {label}
            </li>
          ))}
        </ol>
      )}
      <div role="status" className="action-note">
        {error ? <FadingError text={error} onDone={() => setError("")} role="none" /> : finished || refusal || (!actions.ready ? actions.reason : "")}
      </div>
      <div className="button-row">
        <button type="button" disabled={busy} onClick={close}>
          Close
        </button>
        <button
          type="button"
          className="primary"
          disabled={!actions.ready || busy || !round || !!refusal || parsed === undefined}
          onClick={() => void send()}
        >
          {working ? "Processing…" : usingBatch ? "Confirm round in wallet" : mode === "up" ? "Start round" : "Start deleverage"}
        </button>
      </div>
      <p className="micro">
        Swaps go to Uniswap's Universal Router from your wallet, {pct(SLIPPAGE_BPS)} slippage at most. Every step is
        simulated before it is signed.
      </p>
    </dialog>
  );
}

/** Every decimal of a raw sIMD amount, for the input box. */
function formatGemExact(v: bigint) {
  return exact(v, collateral().decimals);
}
