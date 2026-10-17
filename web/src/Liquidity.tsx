// The imdUSD liquidity window: a swap card (any pair through 0x, Matcha's engine, via imdusd.com/swap/*; imdUSD <-> USDC
// also straight on the peg pool, whichever returns more), add imdUSD + USDC to it over a chosen range (Season 1's peg band $0.99-$1.01 by
// default, or the wide $0.9524-$1.05), and see, collect from and
// take out of the positions this wallet holds there. Everything goes from the viewer's wallet to Uniswap's
// PositionManager; approvals ride in the same batch when the wallet can batch. The arithmetic and calldata live in
// lp.ts (fork-tested: tests/lp.fork.test.mjs).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPublicClient, fallback, http, type Address, type Hex } from "viem";
import type { Runtime } from "./config";
import type { Snapshot } from "./state";
import { BalanceHint, Choice, FadingError, Info, Row, type Actions, type Call, useBackdropClose } from "./actions";
import { amount, exact, fmt, message } from "./math";
import { unit } from "./unit";
import { PERMIT2, UNIVERSAL_ROUTER, encodeSwap } from "./infer/swap";
import {
  ERC20,
  IMDUSD,
  PEG_KEY,
  PEG_POOL_ID,
  STATE_VIEW,
  UNISWAP,
  USDC,
  pegMarginalBuy,
  pegMarginalSell,
  pegQuoter,
  usdAtSqrt,
} from "./leverage";
import {
  ALLOWANCE_HOLDER,
  APPROVE_ABI,
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGES,
  TOKENS,
  TOKEN_META_ABI,
  type SwapAnswer,
  type Token,
  type ZeroXAnswer,
  approvalsFor,
  bestRoute,
  cleanText,
  feeLine,
  formatAmount,
  isEth,
  isPegPair,
  minReceived,
  parseAmount,
  parseCustomTokens,
  quoteStale,
  readSwapAnswer,
  routeName,
  routeSummary,
  same,
  searchTokens,
  swapQuery,
} from "./swap0x";
import {
  BAND,
  LP_SLIPPAGE_BPS,
  POSITION_MANAGER,
  POSITION_MANAGER_ABI,
  STATE_VIEW_LP,
  DEFAULT_RANGE,
  RANGES,
  type RangeKey,
  amountsForLiquidity,
  decodeInfo,
  encodeMint,
  encodeIncrease,
  fitToBalances,
  encodeRemove,
  feesOwed,
  inPegPool,
  planAdd,
  planMax,
  saltOf,
  type AddPlan,
  sharePct,
  describeTrade,
  type TradeSide,
} from "./lp";

const POOL_TTL_MS = 15_000;
const PM = { address: POSITION_MANAGER, abi: POSITION_MANAGER_ABI };
const BLOCKSCOUT = "https://eth.blockscout.com/api/v2/";
const band = (key: RangeKey) => {
  const { sqrtA, sqrtB } = BAND(RANGES[key]);
  return { lo: usdAtSqrt(sqrtA), hi: usdAtSqrt(sqrtB) };
};

type Pool = { sqrtP: bigint; liquidity: bigint; at: number };
/** A position's range in dollars, named when it is one of the window's two. */
const rangeLabel = (p: { tickLower: number; tickUpper: number }) => {
  const { sqrtA, sqrtB } = BAND({ lower: p.tickLower, upper: p.tickUpper });
  const dollars = `$${fmt(usdAtSqrt(sqrtA), 18, 4)} – $${fmt(usdAtSqrt(sqrtB), 18, 4)}`;
  const name = (Object.keys(RANGES) as RangeKey[]).find((k) => RANGES[k].lower === p.tickLower && RANGES[k].upper === p.tickUpper);
  return name === "peg" ? `${dollars} (peg band)` : name === "wide" ? `${dollars} (wide)` : dollars;
};
/** A position, read at its own ticks (either range from this window, or any other range in the pool). */
type Position = {
  id: bigint;
  liquidity: bigint;
  imdusd: bigint;
  usdc: bigint;
  feeImdusd: bigint;
  feeUsdc: bigint;
  tickLower: number;
  tickUpper: number;
};

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

// ---- The swap card's plumbing ----------------------------------------------------------------------------
/** One price check: 0x's answer (or why there is none) and, for imdUSD <-> USDC, the peg pool's. */
type PriceView = {
  key: string;
  zeroX?: ZeroXAnswer;
  zeroXError?: string;
  unavailable?: boolean;
  direct?: bigint;
  directEnd?: bigint;
  directError?: string;
};
/** A firm 0x quote for the connected wallet, and the least it promised. */
type Review = { key: string; quote: ZeroXAnswer; at: number; min: bigint };
const CUSTOM_KEY = "imdusd-swap-tokens";
function loadCustoms(): Token[] {
  try {
    return parseCustomTokens(localStorage.getItem(CUSTOM_KEY));
  } catch {
    return [];
  }
}
function saveCustoms(list: Token[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.map(({ address, symbol, name, decimals }) => ({ address, symbol, name, decimals }))));
  } catch {
    /* Storage blocked: the token works for this visit only. */
  }
}
/** imdusd.com/swap/price or /quote. Anything that is not the Worker's JSON (a network failure, a page) is "unavailable". */
async function askSwap(kind: "price" | "quote", q: URLSearchParams): Promise<SwapAnswer> {
  const down = { ok: false, unavailable: true, error: "Swaps are temporarily unavailable." } as const;
  try {
    const res = await fetch(`/swap/${kind}?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!/json/.test(res.headers.get("content-type") ?? "")) return down;
    return readSwapAnswer(res.status, await res.json());
  } catch {
    return down;
  }
}
const rateText = (amountIn: bigint, out: bigint, a: Token, b: Token) => {
  const r = Number(out) / 10 ** b.decimals / (Number(amountIn) / 10 ** a.decimals);
  return `1 ${a.symbol} = ${r.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${b.symbol}`;
};

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
  const [tab, setTab] = useState<"add" | "positions" | "trade">("add");
  // Trade tab: a swap card. Any pair through 0x (Matcha's engine, via imdusd.com/swap/*, which sets the fee);
  // imdUSD <-> USDC also on the peg pool directly, and whichever returns more.
  const [sellT, setSellT] = useState<Token>(() => TOKENS.find((t) => same(t.address, USDC))!);
  const [buyT, setBuyT] = useState<Token>(() => TOKENS.find((t) => same(t.address, IMDUSD))!);
  const [sellText, setSellText] = useState("");
  const [slip, setSlip] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [picker, setPicker] = useState<"sell" | "buy">();
  const [pickQuery, setPickQuery] = useState("");
  const [pasted, setPasted] = useState<{ address: Address; token?: Token; held?: bigint; error?: string }>();
  const [customs, setCustoms] = useState<Token[]>(loadCustoms);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [price, setPrice] = useState<PriceView>();
  const [review, setReview] = useState<Review>();
  const [accepted, setAccepted] = useState(false);
  const [finishedTx, setFinishedTx] = useState<Hex>();
  const [inputs, setInputs] = useState({ imdusd: "", usdc: "" });
  const [side, setSide] = useState<"imdusd" | "usdc">("imdusd");
  // Season 1's band by default: only liquidity between $0.99 and $1.01 earns points (points/season1.ts).
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
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
    const sqrtP = await readPool();
    const found = await Promise.all(
      unique.map(async (id): Promise<Position | undefined> => {
        try {
          const [owner, [, info]] = await Promise.all([
            r.client.readContract({ ...PM, functionName: "ownerOf", args: [id] }),
            r.client.readContract({ ...PM, functionName: "getPoolAndPositionInfo", args: [id] }),
          ]);
          if ((owner as string).toLowerCase() !== me.toLowerCase() || !inPegPool(info)) return undefined;
          // Every read at the position's OWN ticks: liquidity, fee growth and amounts are all keyed by them.
          const { tickLower, tickUpper } = decodeInfo(info);
          const [[liquidity, last0, last1], inside] = await Promise.all([
            r.client.readContract({
              address: UNISWAP.stateView,
              abi: STATE_VIEW_LP,
              functionName: "getPositionInfo",
              args: [PEG_POOL_ID, POSITION_MANAGER, tickLower, tickUpper, saltOf(id)],
            }),
            r.client.readContract({
              address: UNISWAP.stateView,
              abi: STATE_VIEW_LP,
              functionName: "getFeeGrowthInside",
              args: [PEG_POOL_ID, tickLower, tickUpper],
            }),
          ]);
          const { sqrtA, sqrtB } = BAND({ lower: tickLower, upper: tickUpper });
          const held = sqrtP ? amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) : { amount0: 0n, amount1: 0n };
          const fees = feesOwed(liquidity, inside, [last0, last1]);
          return { id, liquidity, imdusd: held.amount0, usdc: held.amount1, feeImdusd: fees.imdusd, feeUsdc: fees.usdc, tickLower, tickUpper };
        } catch {
          return undefined; // Burned, or not a position: skip it.
        }
      }),
    );
    const list = found.filter((p): p is Position => !!p);
    setPositions(list);
    setScan(note);
    return list;
  }, [r, me, readPool]);
  useEffect(() => {
    // The Add tab needs them too: a deposit over a range the wallet already holds goes into that position.
    if (tab === "positions" || tab === "add") void readPositions();
  }, [tab, readPositions]);

  // The deposit from whichever box was typed in last; the other box shows what the band needs with it.
  const plan = useMemo((): AddPlan | undefined => {
    if (!pool) return undefined;
    try {
      const n = amount(inputs[side], side === "imdusd" ? 18 : 6);
      return planAdd(pool.sqrtP, side, n, RANGES[range]);
    } catch {
      return undefined;
    }
  }, [pool, inputs, side, range]);
  const other = side === "imdusd" ? "usdc" : "imdusd";
  const shown = {
    ...inputs,
    [other]: plan ? exact(other === "imdusd" ? plan.imdusd : plan.usdc, other === "imdusd" ? 18 : 6) : inputs[other],
  };
  const usd = pool ? usdAtSqrt(pool.sqrtP) : undefined;
  const { lo, hi } = band(range);
  const inBand = usd !== undefined && usd >= lo && usd < hi;
  const short =
    plan && wallet
      ? plan.imdusd > wallet.imdusd
        ? `Needs ${fmt(plan.imdusd, 18, 2)} ${unit()}; the wallet holds ${fmt(wallet.imdusd, 18, 2)}.`
        : plan.usdc > wallet.usdc
          ? `Needs ${fmt(plan.usdc, 6, 2)} USDC; the wallet holds ${fmt(wallet.usdc, 6, 2)}.`
          : ""
      : "";
  // Share in millionths, so a small deposit is not floored to 0.00% (whole basis points did that for 100 imdUSD).
  const share = plan && pool ? (plan.liquidity * 1_000_000n) / (pool.liquidity + plan.liquidity) : undefined;
  const max = pool && wallet ? planMax(pool.sqrtP, wallet.imdusd, wallet.usdc, RANGES[range]) : undefined;

  // Public RPCs straight, for tokens pasted in: imdusd.com/rpc serves only the contracts the terminal names.
  const open = useMemo(
    () => createPublicClient({ chain: r.chain, transport: fallback(r.config.network.rpcUrls.map((u) => http(u, { timeout: 8000, retryCount: 0 }))) }),
    [r],
  );
  const reader = (t: Token) => (t.custom ? open : r.client);
  const sellAmount = useMemo(() => parseAmount(sellText, sellT.decimals), [sellText, sellT]);
  const key = `${sellT.address}:${buyT.address}:${sellAmount ?? ""}:${slip}`;
  const peg = isPegPair(sellT.address, buyT.address);
  const pegSide: TradeSide = same(sellT.address, IMDUSD) ? "sell" : "buy";

  // The two tokens' balances, with the pool's 15-second clock.
  const readBalances = useCallback(async () => {
    if (!me) return setBalances({});
    const one = async (t: Token): Promise<[string, bigint] | undefined> => {
      try {
        const b = isEth(t)
          ? await r.client.getBalance({ address: me })
          : ((await reader(t).readContract({ address: t.address, abi: TOKEN_META_ABI, functionName: "balanceOf", args: [me] })) as bigint);
        return [t.address.toLowerCase(), b];
      } catch {
        return undefined;
      }
    };
    const got = await Promise.all([sellT, buyT].map(one));
    // Merged, keyed by token: a slower read for the tokens picked before cannot blank the ones picked now.
    setBalances((old) => ({ ...old, ...Object.fromEntries(got.filter((x): x is [string, bigint] => !!x)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, me, sellT, buyT, open]);
  useEffect(() => {
    if (tab === "trade") void readBalances();
  }, [tab, readBalances, pool?.at]);
  useEffect(() => setBalances({}), [me]);

  // The price, a moment after typing stops and again with the pool's clock: 0x's (no wallet needed) and, for
  // imdUSD <-> USDC, the peg pool's from Uniswap's V4 Quoter.
  // A refresh never cancels a check in flight (under load the peg pool's bisection can outlast the 15-second clock):
  // an answer is kept while its key is still the card's, and a refresh waits for the one before it.
  const priceKey = useRef(key);
  priceKey.current = key;
  const pricing = useRef("");
  useEffect(() => {
    if (tab !== "trade" || sellAmount === undefined) return setPrice(undefined);
    const id = setTimeout(async () => {
      if (pricing.current === key) return;
      pricing.current = key;
      const direct = async () => {
        try {
          const quote = pegQuoter(r.client, pegSide);
          const [out, end] = await Promise.all([
            quote(sellAmount),
            (pegSide === "sell" ? pegMarginalSell : pegMarginalBuy)(quote, sellAmount).catch(() => undefined),
          ]);
          return out === undefined ? { error: "The peg pool cannot fill this amount." } : { out, end };
        } catch (e) {
          return { error: `The peg pool could not be read: ${message(e)}` };
        }
      };
      const [zx, d] = await Promise.all([askSwap("price", swapQuery(sellT, buyT, sellAmount, slip)), peg ? direct() : undefined]);
      if (pricing.current === key) pricing.current = "";
      if (priceKey.current !== key) return;
      setPrice({
        key,
        zeroX: zx.ok ? zx.body : undefined,
        zeroXError: zx.ok ? undefined : zx.error,
        unavailable: !zx.ok && zx.unavailable,
        direct: d && "out" in d ? d.out : undefined,
        directEnd: d && "out" in d ? d.end : undefined,
        directError: d && "error" in d ? d.error : undefined,
      });
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r, tab, key, pool?.at]);
  const quoted = price?.key === key ? price : undefined;
  const zeroOut = quoted?.zeroX ? BigInt(quoted.zeroX.buyAmount!) : undefined;
  const route = quoted ? bestRoute(zeroOut, quoted.direct) : undefined;
  const out = route === "0x" ? zeroOut : route === "direct" ? quoted?.direct : undefined;
  const reviewed = route === "0x" && review?.key === key ? review : undefined;
  // imdUSD <-> USDC by either route: the price against $1, and the under-$0.9975 check for sales.
  const pegView =
    peg && out !== undefined && sellAmount !== undefined && usd !== undefined
      ? describeTrade(pegSide, sellAmount, out, usd, route === "direct" ? quoted?.directEnd : undefined, slip)
      : undefined;
  const minOut =
    route === "0x" && zeroOut !== undefined ? (reviewed?.min ?? minReceived(zeroOut, slip, quoted?.zeroX?.minBuyAmount)) : pegView?.minOut;
  const held = (t: Token) => balances[t.address.toLowerCase()];
  const sellHeld = held(sellT);
  const tradeShort =
    me && sellAmount !== undefined && sellHeld !== undefined && sellAmount > sellHeld
      ? `The wallet holds ${formatAmount(sellHeld, sellT.decimals)} ${sellT.symbol}.`
      : "";
  const quoteNote =
    sellAmount === undefined || route
      ? ""
      : !quoted
        ? "Quoting…"
        : peg
          ? (quoted.directError ?? "No route can fill this amount.")
          : quoted.unavailable
            ? "Swaps are temporarily unavailable."
            : (quoted.zeroXError ?? "No route can fill this amount.");
  const tokens = useMemo(() => [...TOKENS, ...customs], [customs]);
  const found = searchTokens(tokens, pickQuery);
  const unverified = [sellT, buyT].filter((t) => t.custom);

  // A pasted address: read the token's own symbol, name and decimals (and this wallet's balance) from chain.
  useEffect(() => {
    const at = found.paste;
    if (!picker || !at) return setPasted(undefined);
    let live = true;
    setPasted({ address: at });
    (async () => {
      try {
        const read = (functionName: "symbol" | "name" | "decimals") => open.readContract({ address: at, abi: TOKEN_META_ABI, functionName });
        const [symbol, name, decimals, bal] = await Promise.all([
          read("symbol"),
          read("name").catch(() => ""),
          read("decimals"),
          me ? open.readContract({ address: at, abi: TOKEN_META_ABI, functionName: "balanceOf", args: [me] }).catch(() => undefined) : undefined,
        ]);
        const d = Number(decimals);
        if (!Number.isInteger(d) || d > 36) throw Error("bad decimals");
        const token: Token = { address: at, symbol: cleanText(symbol, 16) || "???", name: cleanText(name, 40), decimals: d, custom: true };
        if (live) setPasted({ address: at, token, held: bal as bigint | undefined });
      } catch {
        if (live) setPasted({ address: at, error: "No ERC-20 token at this address on Ethereum (it has no symbol or decimals)." });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker, found.paste, open, me]);

  const resetTrade = () => {
    setAccepted(false);
    setReview(undefined);
    setError("");
    setFinished("");
    setFinishedTx(undefined);
  };
  function choose(t: Token) {
    if (t.custom && !customs.some((c) => same(c.address, t.address))) {
      const next = [...customs, t];
      setCustoms(next);
      saveCustoms(next);
    }
    const other = picker === "sell" ? buyT : sellT;
    // Picking the other side's token swaps the two, as every DEX card does.
    if (same(t.address, other.address)) {
      setSellT(buyT);
      setBuyT(sellT);
    } else if (picker === "sell") setSellT(t);
    else setBuyT(t);
    setPicker(undefined);
    setPickQuery("");
    resetTrade();
  }
  function flip() {
    setSellT(buyT);
    setBuyT(sellT);
    setSellText(out !== undefined ? formatAmount(out, buyT.decimals, 8).replace(/,/g, "") : sellText);
    resetTrade();
  }

  const run = async (calls: Call[]) => {
    setSteps({ labels: calls.map((c) => c.label), done: 0 });
    return actions.sequence!("lp", { calls, batch: !!atomic, onStep: (done) => setSteps((x) => x && { ...x, done }) });
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
      const now = planAdd(sqrtP, side, amount(inputs[side], side === "imdusd" ? 18 : 6), RANGES[range]);
      if (!now) throw Error("The price moved out of reach of this deposit. Review it again.");
      const was = side === "imdusd" ? plan.usdc : plan.imdusd;
      const is = side === "imdusd" ? now.usdc : now.imdusd;
      if (typed > 0n && (is > (was * (10_000n + LP_SLIPPAGE_BPS)) / 10_000n || is * (10_000n + LP_SLIPPAGE_BPS) < was * 10_000n))
        throw Error("The pool's price moved since this was shown. The amounts are updated: review them again.");
      // Balances read now, not the 15-second ones: right after a deposit those still show what it spent.
      const [heldImdusd, heldUsdc] = await Promise.all(
        [IMDUSD, USDC].map(
          (t) => r.client.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
        ),
      );
      setWallet({ imdusd: heldImdusd, usdc: heldUsdc });
      const fit = fitToBalances(now, heldImdusd, heldUsdc);
      if (!fit) throw Error("This deposit needs more than the wallet holds now. The balances are updated: lower the amount.");
      // Same range already held: add to that position (the largest, if several) instead of minting another NFT.
      const held = (positions ?? (await readPositions()) ?? []).filter(
        (p) => p.tickLower === fit.tickLower && p.tickUpper === fit.tickUpper && p.liquidity > 0n,
      );
      const into = held.sort((a, b) => (a.liquidity > b.liquidity ? -1 : 1))[0];
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
        ...(await approvals(IMDUSD, unit(), fit.imdusdMax)),
        ...(await approvals(USDC, "USDC", fit.usdcMax)),
        {
          target: PM,
          fn: "modifyLiquidities",
          args: [into ? encodeIncrease(fit, into.id) : encodeMint(fit, me), deadline],
          label: `Add ${fmt(fit.imdusd, 18, 2)} ${unit()} + ${fmt(fit.usdc, 6, 2)} USDC ${into ? `to your position #${into.id}` : "to the peg pool"}`,
        },
      ]);
      if (!into) {
        // The id read before sending is a guess when others mint in the same block: remember the ids around it,
        // and the on-chain owner check keeps only this wallet's.
        remember(me, [id, id + 1n, id + 2n]);
      }
      setFinished(
        into
          ? `Added ${fmt(fit.imdusd, 18, 2)} ${unit()} and ${fmt(fit.usdc, 6, 2)} USDC to your position #${into.id}.`
          : `Added ${fmt(fit.imdusd, 18, 2)} ${unit()} and ${fmt(fit.usdc, 6, 2)} USDC. Your position is under "Your positions".`,
      );
      void readPositions();
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
      const { sqrtA, sqrtB } = BAND({ lower: p.tickLower, upper: p.tickUpper });
      const all = percent === 100;
      // The position as it is now, not as last listed: right after a take, the list can still show the liquidity
      // before it, and minimums from that make the close revert.
      const held = (await r.client.readContract({ ...PM, functionName: "getPositionLiquidity", args: [p.id] })) as bigint;
      const liquidity = all ? held : (held * BigInt(percent)) / 100n;
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

  /** A firm 0x quote for this wallet, checked: sent to AllowanceHolder, with the ETH this trade sells and no other. */
  async function firmQuote(): Promise<Review> {
    if (!me || sellAmount === undefined) throw Error("Not ready.");
    const a = await askSwap("quote", swapQuery(sellT, buyT, sellAmount, slip, me));
    if (!a.ok) throw Error(a.error);
    const q = a.body;
    const tx = q.transaction;
    if (!tx || !same(tx.to, ALLOWANCE_HOLDER) || !/^0x[0-9a-fA-F]+$/.test(tx.data))
      throw Error("0x returned a transaction for an unexpected contract. Nothing was sent.");
    const value = BigInt(tx.value ?? "0");
    if (isEth(sellT) ? value !== sellAmount : value !== 0n)
      throw Error("0x's transaction would send a different amount of ETH than this trade. Nothing was sent.");
    if (q.sellAmount !== undefined && BigInt(q.sellAmount) !== sellAmount) throw Error("0x quoted a different amount to sell. Review it again.");
    return { key, quote: q, at: Date.now(), min: minReceived(BigInt(q.buyAmount!), slip, q.minBuyAmount) };
  }

  /** 0x route, first click: fetch the firm quote for this wallet and show what it promises. */
  async function reviewSwap() {
    setError("");
    setFinished("");
    try {
      setReview(await firmQuote());
    } catch (e) {
      setError(message(e));
    }
  }

  async function swap() {
    setError("");
    setFinished("");
    setFinishedTx(undefined);
    try {
      if (!actions.sequence || !me || sellAmount === undefined || !route || minOut === undefined) throw Error("Not ready.");
      const label = `Swap ${formatAmount(sellAmount, sellT.decimals)} ${sellT.symbol} for at least ${formatAmount(minOut, buyT.decimals)} ${buyT.symbol}`;
      const balanceOf = (t: Token) =>
        isEth(t)
          ? r.client.getBalance({ address: me })
          : (reader(t).readContract({ address: t.address, abi: TOKEN_META_ABI, functionName: "balanceOf", args: [me] }) as Promise<bigint>);
      const calls: Call[] = [];
      if (route === "0x") {
        if (!reviewed) throw Error("Review the swap first.");
        // A quote over 20 seconds old is fetched again, and must still promise at least what was shown.
        let firm = reviewed;
        if (quoteStale(firm.at)) {
          firm = await firmQuote();
          if (firm.min < reviewed.min) {
            setReview(firm);
            throw Error(`The price moved since this was shown: it now returns at least ${formatAmount(firm.min, buyT.decimals)} ${buyT.symbol}. Review it again.`);
          }
        }
        const tx = firm.quote.transaction!;
        for (const a of approvalsFor(sellT, sellAmount, firm.quote.issues?.allowance))
          calls.push({
            target: { address: sellT.address, abi: APPROVE_ABI },
            fn: "approve",
            args: [a.spender, a.amount],
            label: a.amount === 0n ? `Reset the ${sellT.symbol} allowance to 0 first (USDT requires it)` : `Approve exactly ${formatAmount(sellAmount, sellT.decimals)} ${sellT.symbol} for 0x's AllowanceHolder`,
          });
        calls.push({ target: { address: tx.to, abi: [] }, fn: "swap", args: [], data: tx.data, value: BigInt(tx.value ?? "0"), label: `${label} via Matcha/0x` });
      } else {
        if (!s || !pegView) throw Error("Not ready.");
        const tokenIn = sellT.address;
        // Quote again: the swap must still return at least what the review promised.
        const fresh = await pegQuoter(r.client, pegSide)(sellAmount);
        if (fresh === undefined || fresh < pegView.minOut)
          throw Error("The pool's price moved since this was shown. The quote is updated: review it again.");
        const deadline = s.timestamp + 1800n;
        const [erc, [p2, expires]] = await Promise.all([
          r.client.readContract({ address: tokenIn, abi: ERC20, functionName: "allowance", args: [me, UNISWAP.permit2] }) as Promise<bigint>,
          r.client.readContract({ address: UNISWAP.permit2, abi: PERMIT2, functionName: "allowance", args: [me, tokenIn, UNISWAP.universalRouter] }),
        ]);
        if (erc < sellAmount)
          calls.push({ target: { address: tokenIn, abi: ERC20 }, fn: "approve", args: [UNISWAP.permit2, sellAmount], label: `Approve ${sellT.symbol} for Permit2` });
        if (p2 < sellAmount || BigInt(expires) < s.timestamp + 300n)
          calls.push({
            target: { address: UNISWAP.permit2, abi: PERMIT2 },
            fn: "approve",
            args: [tokenIn, UNISWAP.universalRouter, sellAmount, Number(deadline)],
            label: `Let Uniswap's router take ${sellT.symbol} (30 min)`,
          });
        const call = encodeSwap({ key: PEG_KEY, tokenIn, amountIn: sellAmount, minOut: pegView.minOut });
        calls.push({
          target: { address: UNISWAP.universalRouter, abi: UNIVERSAL_ROUTER },
          fn: "execute",
          args: [call.commands, call.inputs, deadline],
          label: `${label} on the peg pool`,
        });
      }
      const before = await balanceOf(buyT);
      const hash = await run(calls);
      const after = await balanceOf(buyT).catch(() => before);
      setFinished(
        `Swapped ${formatAmount(sellAmount, sellT.decimals)} ${sellT.symbol} for ${formatAmount(after > before ? after - before : 0n, buyT.decimals)} ${buyT.symbol} (${routeName(route)}).`,
      );
      setFinishedTx(hash);
      setSellText("");
      setAccepted(false);
      setReview(undefined);
      void readPool();
      void readBalances();
    } catch (e) {
      setError(message(e));
    }
  }

  const close = () => {
    if (!busy) onClose();
  };
  const backdrop = useBackdropClose(close);
  const ready = actions.ready && !busy;

  return (
    <dialog
      ref={dialog}
      className="loop-dialog"
      aria-labelledby="lp-heading"
      {...backdrop}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <h2 id="lp-heading">
        imdUSD liquidity{" "}
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
          setTab(x as "add" | "positions" | "trade");
          setPicker(undefined);
          setError("");
          setFinished("");
          setSteps(undefined);
        }}
        options={[
          ["trade", "Trade"],
          ["add", "Add"],
          ["positions", "Your positions"],
        ]}
      />
      <div className="loop-now">
        <Row label={`${unit()} price`}>{usd !== undefined ? `$${fmt(usd, 18, 4)}` : poolError ? "unreadable" : "…"}</Row>
        {tab === "add" && (
          <>
            <Row
              label="Band"
              info={
                range === "peg"
                  ? `Season 1's band, $${fmt(lo, 18, 4)} to $${fmt(hi, 18, 4)}: all of this position's liquidity sits where Season 1 points are earned, about five times the depth at the peg of the wide range for the same deposit. If the price leaves the band the position holds one token only and earns no fees or points until it comes back. Inside it, it earns the pool's 0.01% fee on every swap; the peg hook's surcharge goes to the Treasury.`
                  : `The band the pool's first deposit used, $${fmt(lo, 18, 4)} to $${fmt(hi, 18, 4)}: it keeps earning fees through a bigger move, but only its slice between $0.99 and $1.01 earns Season 1 points. Inside it, it earns the pool's 0.01% fee on every swap; the peg hook's surcharge goes to the Treasury.`
              }
            >
              ${fmt(lo, 18, 4)} – ${fmt(hi, 18, 4)}
            </Row>
            {usd !== undefined && !inBand && (
              <p className="danger-text review-warning">
                The price is outside the band: a new position earns no fees until it comes back, and takes only{" "}
                {usd < lo ? unit() : "USDC"}.
              </p>
            )}
          </>
        )}
      </div>

      {tab === "trade" && picker ? (
        <div className="swap-picker">
          <div className="field">
            <label>
              {picker === "sell" ? "Pay with" : "Receive"}: search, or paste a token address
              <input
                name="swap-search"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                placeholder="ETH, USDC, 0x…"
                value={pickQuery}
                onChange={(e) => setPickQuery(e.target.value)}
              />
            </label>
          </div>
          <ul className="swap-tokens" aria-label="Tokens">
            {found.matches.map((t) => (
              <li key={t.address}>
                <button type="button" aria-pressed={same(t.address, (picker === "sell" ? sellT : buyT).address)} onClick={() => choose(t)}>
                  <b>{t.symbol}</b>
                  <span>{t.custom ? `${t.name} · imported, unverified` : t.name}</span>
                </button>
              </li>
            ))}
          </ul>
          {found.matches.length === 0 && !found.paste && <p className="micro">No listed token matches. Paste its address instead.</p>}
          {found.paste &&
            (pasted?.token ? (
              <div className="loop-plan swap-paste">
                <Row label="Token">
                  {pasted.token.symbol}
                  {pasted.token.name ? ` · ${pasted.token.name}` : ""}
                </Row>
                <Row label="Decimals">{pasted.token.decimals}</Row>
                {me && <Row label="In your wallet">{formatAmount(pasted.held, pasted.token.decimals)}</Row>}
                <p className="danger-text review-warning">
                  Unverified token: check the address. Anyone can deploy a token with any name and symbol; this one is
                  not on the terminal's list.
                </p>
                <button type="button" onClick={() => choose(pasted.token!)}>
                  Use {pasted.token.symbol}
                </button>
              </div>
            ) : (
              <p className="micro">{pasted?.error ?? "Reading the token from chain…"}</p>
            ))}
        </div>
      ) : tab === "trade" ? (
        <>
          <div className="swap-card">
            <div className="swap-side">
              <div className="swap-head">
                <label htmlFor="swap-sell">You pay</label>
                {me ? (
                  <button
                    type="button"
                    className="swap-balance"
                    disabled={busy || !sellHeld}
                    title="Use the whole balance"
                    onClick={() => {
                      // Ether keeps a little back for gas.
                      const keep = isEth(sellT) ? 3n * 10n ** 15n : 0n;
                      const max = sellHeld && sellHeld > keep ? sellHeld - keep : 0n;
                      setSellText(max > 0n ? exact(max, sellT.decimals) : "");
                      resetTrade();
                    }}
                  >
                    Balance {sellHeld === undefined ? "…" : formatAmount(sellHeld, sellT.decimals)} · Max
                  </button>
                ) : (
                  <BalanceHint b={{ connected: false, amount: undefined, symbol: sellT.symbol, decimals: sellT.decimals }} onUse={() => {}} />
                )}
              </div>
              <div className="swap-row">
                <input
                  id="swap-sell"
                  name="swap-sell"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0"
                  value={sellText}
                  disabled={busy}
                  onChange={(e) => {
                    setSellText(e.target.value);
                    resetTrade();
                  }}
                />
                <button type="button" className="swap-token" disabled={busy} aria-label={`Pay with ${sellT.symbol}: change token`} onClick={() => setPicker("sell")}>
                  {sellT.symbol} <span aria-hidden="true">▾</span>
                </button>
              </div>
            </div>
            <button type="button" className="swap-flip" disabled={busy} aria-label="Flip the two tokens" title="Flip" onClick={flip}>
              ↓↑
            </button>
            <div className="swap-side">
              <div className="swap-head">
                <span>You receive</span>
                {me && <span className="swap-held">Balance {held(buyT) === undefined ? "…" : formatAmount(held(buyT), buyT.decimals)}</span>}
              </div>
              <div className="swap-row">
                <output className="swap-out" aria-label="You receive" data-route={route ?? ""}>
                  {out !== undefined ? formatAmount(out, buyT.decimals) : sellAmount !== undefined && !quoteNote ? "…" : "0"}
                </output>
                <button type="button" className="swap-token" disabled={busy} aria-label={`Receive ${buyT.symbol}: change token`} onClick={() => setPicker("buy")}>
                  {buyT.symbol} <span aria-hidden="true">▾</span>
                </button>
              </div>
            </div>
          </div>
          {sellText.trim() !== "" && sellAmount === undefined && (
            <p className="danger-text review-warning">Enter an amount with at most {sellT.decimals} decimal places.</p>
          )}
          {quoteNote && <p className="micro swap-note">{quoteNote}</p>}
          {unverified.map((t) => (
            <p className="danger-text review-warning" key={t.address}>
              {t.symbol} is an unverified token ({t.address}): check the address.
            </p>
          ))}
          {route && out !== undefined && sellAmount !== undefined && minOut !== undefined && (
            <div className="loop-plan">
              <Row label="Rate">{rateText(sellAmount, out, sellT, buyT)}</Row>
              <Row
                label="Route"
                info={
                  route === "0x"
                    ? "0x's Swap API, the engine behind Matcha, splits the trade across the pools that return the most. The swap goes through 0x's AllowanceHolder contract, which takes only the approved amount."
                    : "Straight on the imdUSD/USDC peg pool (Uniswap v4, PegFeeHook) through Uniswap's router: here it returns at least as much as 0x."
                }
              >
                {routeName(route)}
                {route === "0x" && quoted?.zeroX ? ` (${routeSummary(quoted.zeroX)})` : ""}
              </Row>
              <Row
                label="Minimum received"
                info={`If the price moves before the swap lands it may return up to ${(slip / 100).toFixed(1)}% less; under that it refuses and nothing is spent.`}
              >
                {formatAmount(minOut, buyT.decimals)} {buyT.symbol}
              </Row>
              <div className="row swap-slip">
                <span>Slippage</span>
                <Choice
                  label="Slippage"
                  value={String(slip)}
                  onChange={(x) => {
                    if (busy) return;
                    setSlip(Number(x));
                    resetTrade();
                  }}
                  options={SLIPPAGES.map((b) => [String(b), `${b / 100}%`] as const)}
                />
              </div>
              <Row
                label="Fee"
                info="On swaps through the terminal where neither side is imdUSD, 0.1% of what you receive goes to the imdUSD Treasury (already in the amount shown). imdUSD trades carry none."
              >
                {feeLine(sellT.address, buyT.address)}
              </Row>
              {route === "0x" && quoted?.zeroX?.totalNetworkFee && (
                <Row label="Network fee">≈ {formatAmount(BigInt(quoted.zeroX.totalNetworkFee), 18, 3)} ETH</Row>
              )}
              {route === "0x" && quoted?.zeroX?.estimatedPriceImpact && (
                <Row label="Price impact">{Number(quoted.zeroX.estimatedPriceImpact).toFixed(2)}%</Row>
              )}
              {pegView && (
                <Row label="Against $1" info={`The average price against $1 per ${unit()}, with fees, price impact and any peg-hook surcharge included.`}>
                  {pegView.avg === 10n ** 18n
                    ? "at $1"
                    : `${(Math.abs(Number(pegView.avg - 10n ** 18n)) / 1e16).toFixed(2)}% ${pegView.avg < 10n ** 18n ? "under" : "over"} $1`}
                </Row>
              )}
              {route === "direct" && quoted?.directEnd !== undefined && (
                <Row label="Price after" info="What the last unit of this trade gets; the pool's price moves to about here.">
                  ${fmt(quoted.directEnd, 18, 4)}
                </Row>
              )}
              {reviewed && <Row label="Quote">firm for this wallet; fetched again if over 20 s old when you confirm</Row>}
            </div>
          )}
          {peg && route === "direct" && quoted?.unavailable && (
            <p className="micro">Matcha/0x is unavailable right now, so this trades on the peg pool directly.</p>
          )}
          {pegView?.overCeiling && (
            <p className="review-warning">
              This purchase takes the price past $1.0025, so the peg hook's surcharge applies to it (already in the
              quote). Buying less keeps it inside the fee-free band.
            </p>
          )}
          {pegView?.underFloor && (
            <label className="loop-check danger-text">
              <input type="checkbox" checked={accepted} disabled={busy} onChange={(e) => setAccepted(e.target.checked)} />
              <span>
                This sells {unit()} under $0.9975: it pays the peg hook's surcharge, costs about{" "}
                {(pegView.costBps / 100).toFixed(2)}% against $1, and pushes {unit()} further from $1. I accept.
              </span>
            </label>
          )}
          {tradeShort && <p className="danger-text review-warning">{tradeShort}</p>}
        </>
      ) : tab === "add" ? (
        <>
          <Choice
            label="Range for a new position"
            value={range}
            onChange={(x) => {
              if (busy) return;
              setRange(x as RangeKey);
              setError("");
              setFinished("");
            }}
            options={[
              ["peg", "Peg band $0.99–$1.01 (earns Season 1 points)"],
              ["wide", "Wide $0.95–$1.05"],
            ]}
          />
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
              <Row label="Goes into" info="A deposit over a range you already hold adds to that position; otherwise it opens a new one (a Uniswap v4 NFT).">
                {(() => {
                  const into = positions
                    ?.filter((p) => p.tickLower === plan.tickLower && p.tickUpper === plan.tickUpper && p.liquidity > 0n)
                    .sort((a, b) => (a.liquidity > b.liquidity ? -1 : 1))[0];
                  return into ? `Your position #${into.id}` : "A new position";
                })()}
              </Row>
              <Row label="Deposits">
                {fmt(plan.imdusd, 18, 4)} {unit()} + {fmt(plan.usdc, 6, 4)} USDC
              </Row>
              <Row label="At most" info={`If the price moves before the deposit lands, it may take up to ${(Number(LP_SLIPPAGE_BPS) / 100).toFixed(1)}% more of either token; past that it refuses and nothing is spent.`}>
                {(() => {
                  // Never more than the wallet holds: the maxima sent are capped at the balances.
                  const cap = (wallet && fitToBalances(plan, wallet.imdusd, wallet.usdc)) || plan;
                  return `${fmt(cap.imdusdMax, 18, 4)} ${unit()} + ${fmt(cap.usdcMax, 6, 4)} USDC`;
                })()}
              </Row>
              <Row label="Share of the pool's active liquidity">
                {share !== undefined ? sharePct(share) : "—"}
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
            <p className="micro">No positions in the peg pool for this wallet. {scan}</p>
          ) : (
            <>
              {scan && <p className="micro">{scan}</p>}
              {positions.map((p) => (
                <div className="loop-plan" key={String(p.id)}>
                  <Row label={`Position #${p.id}`}>
                    {fmt(p.imdusd, 18, 2)} {unit()} + {fmt(p.usdc, 6, 2)} USDC
                  </Row>
                  <Row label="Range">{rangeLabel(p)}</Row>
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

      {atomic !== undefined && (tab === "add" || (tab === "trade" && !picker)) && (
        <p className="micro">
          {atomic
            ? `Approvals and the ${tab === "add" ? "deposit" : "swap"} go as one all-or-nothing batch: one signature.`
            : `Your wallet signs each approval and the ${tab === "add" ? "deposit" : "swap"} as its own transaction. If one stops, the window says where.`}
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
        {error ? (
          <FadingError text={error} onDone={() => setError("")} role="none" />
        ) : finished ? (
          <>
            {finished}
            {finishedTx && (
              <>
                {" "}
                <a href={`${r.config.network.explorer}/tx/${finishedTx}`} target="_blank" rel="noreferrer">
                  View the transaction
                </a>
              </>
            )}
          </>
        ) : !actions.ready ? (
          actions.reason
        ) : (
          ""
        )}
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
        {tab === "trade" && !picker && (
          <button
            type="button"
            className="primary"
            disabled={
              !ready || !route || sellAmount === undefined || !!tradeShort || (route === "direct" && !s) || (!!pegView?.underFloor && !accepted)
            }
            onClick={() => void (route === "0x" && !reviewed ? reviewSwap() : swap())}
          >
            {working ? "Processing…" : route === "0x" && !reviewed ? "Review swap" : atomic ? "Confirm swap in wallet" : "Swap"}
          </button>
        )}
        {tab === "trade" && picker && (
          <button type="button" disabled={busy} onClick={() => (setPicker(undefined), setPickQuery(""))}>
            Back
          </button>
        )}
      </div>
    </dialog>
  );
}
