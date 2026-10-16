// The liquidity window: add imdUSD + USDC to the peg pool over its band ($0.9524-$1.05), and see, collect from and
// take out of the positions this wallet holds there. Everything goes from the viewer's wallet to Uniswap's
// PositionManager; approvals ride in the same batch when the wallet can batch. The arithmetic and calldata live in
// lp.ts (fork-tested: tests/lp.fork.test.mjs).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import type { Runtime } from "./config";
import type { Snapshot } from "./state";
import { BalanceHint, Choice, FadingError, Info, Row, type Actions, type Call } from "./actions";
import { amount, exact, fmt, message } from "./math";
import { unit } from "./unit";
import { PERMIT2 } from "./infer/swap";
import { ERC20, IMDUSD, PEG_POOL_ID, STATE_VIEW, UNISWAP, USDC, usdAtSqrt } from "./leverage";
import {
  BAND,
  LP_SLIPPAGE_BPS,
  POSITION_MANAGER,
  POSITION_MANAGER_ABI,
  STATE_VIEW_LP,
  TICK_LOWER,
  TICK_UPPER,
  amountsForLiquidity,
  encodeMint,
  encodeRemove,
  feesOwed,
  inPegPool,
  planAdd,
  planMax,
  saltOf,
  type AddPlan,
} from "./lp";

const POOL_TTL_MS = 15_000;
const PM = { address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI };
const BLOCKSCOUT = "https://eth.blockscout.com/api/v2/";
const band = () => {
  const { sqrtA, sqrtB } = BAND();
  return { lo: usdAtSqrt(sqrtA), hi: usdAtSqrt(sqrtB) };
};

type Pool = { sqrtP: bigint; liquidity: bigint; at: number };
type Position = { id: bigint; liquidity: bigint; imdusd: bigint; usdc: bigint; feeImdusd: bigint; feeUsdc: bigint };

// Position ids this browser minted or was told about, per wallet: found again even when the explorer is down.
const storeKey = (me: Address) => `imdusd-lp-positions:${me.toLowerCase()}`;
function remembered(me: Address): bigint[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey(me)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => /^\d{1,30}$/.test(String(x))).map((x) => BigInt(x)) : [];
  } catch {
    return [];
  }
}
function remember(me: Address, ids: bigint[]) {
  try {
    const all = [...new Set([...remembered(me), ...ids].map(String))];
    localStorage.setItem(storeKey(me), JSON.stringify(all));
  } catch {
    /* Storage blocked: the explorer still finds them. */
  }
}

/** The wallet's Uniswap v4 position ids from Blockscout (a hint only: every id is checked on chain). */
async function explorerIds(me: Address): Promise<bigint[]> {
  const get = async (path: string) => {
    const res = await fetch(new URL(path, BLOCKSCOUT), { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw Error(`Blockscout returned ${res.status}`);
    return res.json();
  };
  const isPm = (t: any) => String(t?.address_hash ?? t?.address ?? "").toLowerCase() === POSITION_MANAGER.toLowerCase();
  const collections = await get(`addresses/${me}/nft/collections?type=ERC-721`);
  const mine = (collections.items ?? []).find((c: any) => isPm(c.token));
  if (!mine) return [];
  const ids: bigint[] = (mine.token_instances ?? []).map((i: any) => BigInt(i.id));
  if (ids.length >= Number(mine.amount ?? 0)) return ids;
  // More than the collection preview lists: page through the wallet's NFTs.
  let query = "";
  for (let page = 0; page < 8; page++) {
    const body = await get(`addresses/${me}/nft?type=ERC-721${query}`);
    for (const i of body.items ?? []) if (isPm(i.token)) ids.push(BigInt(i.id));
    if (!body.next_page_params) break;
    query = `&${new URLSearchParams(body.next_page_params).toString()}`;
  }
  return ids;
}

export function LpWindow({
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
  const [tab, setTab] = useState<"add" | "positions">("add");
  const [inputs, setInputs] = useState({ imdusd: "", usdc: "" });
  const [side, setSide] = useState<"imdusd" | "usdc">("imdusd");
  const [pool, setPool] = useState<Pool>();
  const [poolError, setPoolError] = useState("");
  const [wallet, setWallet] = useState<{ imdusd: bigint; usdc: bigint }>();
  const [positions, setPositions] = useState<Position[]>();
  const [scan, setScan] = useState("");
  const [manual, setManual] = useState("");
  const [steps, setSteps] = useState<{ labels: string[]; done: number }>();
  const [error, setError] = useState("");
  const [finished, setFinished] = useState("");
  const me = actions.account;
  const busy = !!actions.busy;
  const working = actions.busy === "lp";
  const atomic = actions.atomic;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // The pool and the wallet's two balances, on their own 15-second clock.
  const readPool = useCallback(async () => {
    try {
      const [[sqrtP], liquidity] = await Promise.all([
        r.client.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW, functionName: "getSlot0", args: [PEG_POOL_ID] }),
        r.client.readContract({ address: UNISWAP.stateView, abi: STATE_VIEW, functionName: "getLiquidity", args: [PEG_POOL_ID] }),
      ]);
      setPool({ sqrtP, liquidity, at: Date.now() });
      setPoolError("");
      if (me) {
        const [a, b] = await Promise.all(
          [IMDUSD, USDC].map(
            (t) => r.client.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
          ),
        );
        setWallet({ imdusd: a, usdc: b });
      }
      return sqrtP;
    } catch (e) {
      setPoolError(message(e));
      return undefined;
    }
  }, [r, me]);
  useEffect(() => {
    void readPool();
    const id = setInterval(() => void readPool(), POOL_TTL_MS);
    return () => clearInterval(id);
  }, [readPool]);

  // The wallet's peg-pool positions: explorer ids and remembered ones, each checked on chain (owner, pool, liquidity).
  const readPositions = useCallback(async () => {
    if (!me) return;
    setScan("Looking for your positions…");
    let ids = remembered(me);
    let note = "";
    try {
      ids = [...ids, ...(await explorerIds(me))];
    } catch {
      note = "The explorer could not be reached, so only positions this browser knows are listed. Add one by its id below.";
    }
    const unique = [...new Set(ids.map(String))].map((x) => BigInt(x));
    const [inside, sqrtP] = await Promise.all([
      r.client.readContract({
        address: UNISWAP.stateView,
        abi: STATE_VIEW_LP,
        functionName: "getFeeGrowthInside",
        args: [PEG_POOL_ID, TICK_LOWER, TICK_UPPER],
      }),
      readPool(),
    ]);
    const { sqrtA, sqrtB } = BAND();
    const found = await Promise.all(
      unique.map(async (id): Promise<Position | undefined> => {
        try {
          const [owner, [, info]] = await Promise.all([
            r.client.readContract({ ...PM, functionName: "ownerOf", args: [id] }),
            r.client.readContract({ ...PM, functionName: "getPoolAndPositionInfo", args: [id] }),
          ]);
          if ((owner as string).toLowerCase() !== me.toLowerCase() || !inPegPool(info)) return undefined;
          const [liquidity, last0, last1] = await r.client.readContract({
            address: UNISWAP.stateView,
            abi: STATE_VIEW_LP,
            functionName: "getPositionInfo",
            args: [PEG_POOL_ID, POSITION_MANAGER, TICK_LOWER, TICK_UPPER, saltOf(id)],
          });
          const held = sqrtP ? amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) : { amount0: 0n, amount1: 0n };
          const fees = feesOwed(liquidity, inside, [last0, last1]);
          return { id, liquidity, imdusd: held.amount0, usdc: held.amount1, feeImdusd: fees.imdusd, feeUsdc: fees.usdc };
        } catch {
          return undefined; // Burned, or not a position: skip it.
        }
      }),
    );
    // A position over another range in this pool is the wallet's too, but the window only manages the band.
    setPositions(found.filter((p): p is Position => !!p));
    setScan(note);
  }, [r, me, readPool]);
  useEffect(() => {
    if (tab === "positions") void readPositions();
  }, [tab, readPositions]);

  // The deposit from whichever box was typed in last; the other box shows what the band needs with it.
  const plan = useMemo((): AddPlan | undefined => {
    if (!pool) return undefined;
    try {
      const n = amount(inputs[side], side === "imdusd" ? 18 : 6);
      return planAdd(pool.sqrtP, side, n);
    } catch {
      return undefined;
    }
  }, [pool, inputs, side]);
  const other = side === "imdusd" ? "usdc" : "imdusd";
  const shown = {
    ...inputs,
    [other]: plan ? exact(other === "imdusd" ? plan.imdusd : plan.usdc, other === "imdusd" ? 18 : 6) : inputs[other],
  };
  const usd = pool ? usdAtSqrt(pool.sqrtP) : undefined;
  const { lo, hi } = band();
  const inBand = usd !== undefined && usd >= lo && usd < hi;
  const short =
    plan && wallet
      ? plan.imdusdMax > wallet.imdusd
        ? `Needs up to ${fmt(plan.imdusdMax, 18, 2)} ${unit()}; the wallet holds ${fmt(wallet.imdusd, 18, 2)}.`
        : plan.usdcMax > wallet.usdc
          ? `Needs up to ${fmt(plan.usdcMax, 6, 2)} USDC; the wallet holds ${fmt(wallet.usdc, 6, 2)}.`
          : ""
      : "";
  const share = plan && pool ? (plan.liquidity * 10_000n) / (pool.liquidity + plan.liquidity) : undefined;
  const max = pool && wallet ? planMax(pool.sqrtP, wallet.imdusd, wallet.usdc) : undefined;

  const run = async (calls: Call[]) => {
    setSteps({ labels: calls.map((c) => c.label), done: 0 });
    await actions.sequence!("lp", { calls, batch: !!atomic, onStep: (done) => setSteps((x) => x && { ...x, done }) });
  };

  async function add() {
    setError("");
    setFinished("");
    try {
      if (!actions.sequence || !me || !s || !plan) throw Error("Not ready.");
      // Re-read the price and re-plan: the review must still hold, within the slippage the mint allows.
      const sqrtP = await readPool();
      if (!sqrtP) throw Error("The peg pool could not be read. Try again.");
      const typed = side === "imdusd" ? plan.imdusd : plan.usdc;
      const now = planAdd(sqrtP, side, amount(inputs[side], side === "imdusd" ? 18 : 6));
      if (!now) throw Error("The price moved out of reach of this deposit. Review it again.");
      const was = side === "imdusd" ? plan.usdc : plan.imdusd;
      const is = side === "imdusd" ? now.usdc : now.imdusd;
      if (typed > 0n && (is > (was * (10_000n + LP_SLIPPAGE_BPS)) / 10_000n || is * (10_000n + LP_SLIPPAGE_BPS) < was * 10_000n))
        throw Error("The pool's price moved since this was shown. The amounts are updated: review them again.");
      const deadline = s.timestamp + 1800n;
      const approvals = async (token: Address, symbol: string, n: bigint): Promise<Call[]> => {
        if (n === 0n) return [];
        const [erc, [p2, expires]] = await Promise.all([
          r.client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [me, UNISWAP.permit2] }) as Promise<bigint>,
          r.client.readContract({ address: UNISWAP.permit2, abi: PERMIT2, functionName: "allowance", args: [me, token, POSITION_MANAGER] }),
        ]);
        const calls: Call[] = [];
        if (erc < n)
          calls.push({ target: { address: token, abi: ERC20 }, fn: "approve", args: [UNISWAP.permit2, n], label: `Approve ${symbol} for Permit2` });
        if (p2 < n || BigInt(expires) < s.timestamp + 300n)
          calls.push({
            target: { address: UNISWAP.permit2, abi: PERMIT2 },
            fn: "approve",
            args: [token, POSITION_MANAGER, n, Number(deadline)],
            label: `Let Uniswap's PositionManager take ${symbol} (30 min)`,
          });
        return calls;
      };
      const id = (await r.client.readContract({ ...PM, functionName: "nextTokenId" })) as bigint;
      await run([
        ...(await approvals(IMDUSD, unit(), now.imdusdMax)),
        ...(await approvals(USDC, "USDC", now.usdcMax)),
        {
          target: PM,
          fn: "modifyLiquidities",
          args: [encodeMint(now, me), deadline],
          label: `Add ${fmt(now.imdusd, 18, 2)} ${unit()} + ${fmt(now.usdc, 6, 2)} USDC to the peg pool`,
        },
      ]);
      // The id read before sending is a guess when others mint in the same block: remember the ids around it,
      // and the on-chain owner check keeps only this wallet's.
      remember(me, [id, id + 1n, id + 2n]);
      setFinished(`Added ${fmt(now.imdusd, 18, 2)} ${unit()} and ${fmt(now.usdc, 6, 2)} USDC. Your position is under "Your positions".`);
      setInputs({ imdusd: "", usdc: "" });
      void readPool();
    } catch (e) {
      setError(message(e));
    }
  }

  async function remove(p: Position, percent: number) {
    setError("");
    setFinished("");
    try {
      if (!actions.sequence || !me || !s) throw Error("Not ready.");
      const sqrtP = await readPool();
      if (!sqrtP) throw Error("The peg pool could not be read. Try again.");
      const { sqrtA, sqrtB } = BAND();
      const all = percent === 100;
      const liquidity = all ? p.liquidity : (p.liquidity * BigInt(percent)) / 100n;
      const out = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
      const what =
        percent === 0
          ? `Collect ${fmt(p.feeImdusd, 18, 4)} ${unit()} + ${fmt(p.feeUsdc, 6, 4)} USDC in fees from #${p.id}`
          : `Take ${percent}% out of #${p.id}: ≈ ${fmt(out.amount0, 18, 2)} ${unit()} + ${fmt(out.amount1, 6, 2)} USDC, with its fees`;
      await run([
        {
          target: PM,
          fn: "modifyLiquidities",
          args: [encodeRemove({ id: p.id, liquidity, all, min0: out.amount0, min1: out.amount1, to: me }), s.timestamp + 1800n],
          label: what,
        },
      ]);
      setFinished(percent === 0 ? "Fees collected to your wallet." : all ? `Position #${p.id} closed; the tokens are in your wallet.` : `Took ${percent}% of #${p.id} to your wallet.`);
      await readPositions();
    } catch (e) {
      setError(message(e));
    }
  }

  const close = () => {
    if (!busy) onClose();
  };
  const ready = actions.ready && !busy;

  return (
    <dialog
      ref={dialog}
      className="loop-dialog"
      aria-labelledby="lp-heading"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="lp-heading">
        Peg pool liquidity{" "}
        <Info
          label="About the peg pool"
          text={`imdUSD/USDC on Uniswap v4 with the PegFeeHook. A liquidity provider holds both tokens and trades between them as the price moves inside the band: under $1 the position holds more ${unit()}, over $1 more USDC. Every step is simulated before it is signed.`}
        />
      </h2>
      <Choice
        label="Liquidity view"
        value={tab}
        onChange={(x) => {
          if (busy) return;
          setTab(x as "add" | "positions");
          setError("");
          setFinished("");
          setSteps(undefined);
        }}
        options={[
          ["add", "Add"],
          ["positions", "Your positions"],
        ]}
      />
      <div className="loop-now">
        <Row label={`${unit()} price`}>{usd !== undefined ? `$${fmt(usd, 18, 4)}` : poolError ? "unreadable" : "…"}</Row>
        <Row
          label="Band"
          info={`Every position from this window covers the band the pool's first deposit used, $${fmt(lo, 18, 4)} to $${fmt(hi, 18, 4)}, where the peg needs depth. Inside it, it earns the pool's 0.01% fee on every swap; the peg hook's surcharge goes to the Treasury, not to liquidity providers.`}
        >
          ${fmt(lo, 18, 4)} – ${fmt(hi, 18, 4)}
        </Row>
        {usd !== undefined && !inBand && (
          <p className="danger-text review-warning">
            The price is outside the band: a new position earns no fees until it comes back, and takes only{" "}
            {usd < lo ? unit() : "USDC"}.
          </p>
        )}
      </div>

      {tab === "add" ? (
        <>
          <p className="micro">
            Type either amount; the other is what the band needs at today's price. Both come from your wallet, and
            the position (a Uniswap v4 NFT) is yours: take it out here at any time.
          </p>
          {(["imdusd", "usdc"] as const).map((k) => (
            <div className="field" key={k}>
              <label>
                {k === "imdusd" ? unit() : "USDC"}
                <input
                  name={`lp-${k}`}
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  value={shown[k]}
                  disabled={busy}
                  onChange={(e) => {
                    setSide(k);
                    setInputs({ imdusd: "", usdc: "", [k]: e.target.value });
                    setError("");
                    setFinished("");
                  }}
                />
              </label>
              <BalanceHint
                b={{ connected: !!me, amount: wallet?.[k], symbol: k === "imdusd" ? unit() : "USDC", decimals: k === "imdusd" ? 18 : 6 }}
                onUse={(text) => {
                  setSide(k);
                  setInputs({ imdusd: "", usdc: "", [k]: text });
                }}
              />
            </div>
          ))}
          {max && (
            <button
              type="button"
              className="lp-max"
              disabled={busy}
              onClick={() => {
                setSide("imdusd");
                setInputs({ imdusd: exact(max.imdusd, 18), usdc: "" });
              }}
            >
              Max both: {fmt(max.imdusd, 18, 2)} {unit()} + {fmt(max.usdc, 6, 2)} USDC
            </button>
          )}
          {plan && (
            <div className="loop-plan">
              <Row label="Deposits">
                {fmt(plan.imdusd, 18, 4)} {unit()} + {fmt(plan.usdc, 6, 4)} USDC
              </Row>
              <Row label="At most" info={`If the price moves before the deposit lands, it may take up to ${(Number(LP_SLIPPAGE_BPS) / 100).toFixed(1)}% more of either token; past that it refuses and nothing is spent.`}>
                {fmt(plan.imdusdMax, 18, 4)} {unit()} + {fmt(plan.usdcMax, 6, 4)} USDC
              </Row>
              <Row label="Share of the pool's active liquidity">
                {share !== undefined ? `${(Number(share) / 100).toFixed(2)}%` : "—"}
              </Row>
            </div>
          )}
          {short && <p className="danger-text review-warning">{short}</p>}
        </>
      ) : (
        <>
          {positions === undefined ? (
            <p className="micro">{scan || "…"}</p>
          ) : positions.length === 0 ? (
            <p className="micro">No positions in the peg pool's band for this wallet. {scan}</p>
          ) : (
            <>
              {scan && <p className="micro">{scan}</p>}
              {positions.map((p) => (
                <div className="loop-plan" key={String(p.id)}>
                  <Row label={`Position #${p.id}`}>
                    {fmt(p.imdusd, 18, 2)} {unit()} + {fmt(p.usdc, 6, 2)} USDC
                  </Row>
                  <Row label="Fees to collect">
                    {fmt(p.feeImdusd, 18, 4)} {unit()} + {fmt(p.feeUsdc, 6, 4)} USDC
                  </Row>
                  <div className="button-row">
                    <button type="button" disabled={!ready || (p.feeImdusd === 0n && p.feeUsdc === 0n)} onClick={() => void remove(p, 0)}>
                      Collect fees
                    </button>
                    {[25, 50, 100].map((pc) => (
                      <button type="button" key={pc} disabled={!ready || p.liquidity === 0n} onClick={() => void remove(p, pc)}>
                        {pc === 100 ? "Close" : `Take ${pc}%`}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              if (!me || !/^\d{1,30}$/.test(manual.trim())) return setError("A position id is a whole number.");
              remember(me, [BigInt(manual.trim())]);
              setManual("");
              void readPositions();
            }}
          >
            <label>
              Add a position by id
              <input name="lp-id" inputMode="numeric" autoComplete="off" value={manual} onChange={(e) => setManual(e.target.value)} />
            </label>
            <button type="submit" disabled={busy || !me}>
              Look up
            </button>
          </form>
          <p className="micro">
            Taking liquidity out pays your share of both tokens at today's price, plus its fees, to your wallet; at most{" "}
            {(Number(LP_SLIPPAGE_BPS) / 100).toFixed(1)}% under what is shown, or nothing happens. Closing burns the
            position's NFT.
          </p>
        </>
      )}

      {atomic !== undefined && tab === "add" && (
        <p className="micro">
          {atomic
            ? "Approvals and the deposit go as one all-or-nothing batch: one signature."
            : "Your wallet signs each approval and the deposit as its own transaction. If one stops, the window says where."}
        </p>
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
        {error ? <FadingError text={error} onDone={() => setError("")} role="none" /> : finished || (!actions.ready ? actions.reason : "")}
      </div>
      <div className="button-row">
        <button type="button" disabled={busy} onClick={close}>
          Close
        </button>
        {tab === "add" && (
          <button type="button" className="primary" disabled={!ready || !plan || !!short || !s} onClick={() => void add()}>
            {working ? "Processing…" : atomic ? "Confirm deposit in wallet" : "Add liquidity"}
          </button>
        )}
      </div>
    </dialog>
  );
}
