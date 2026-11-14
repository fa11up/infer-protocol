// The INFER app: one screen, no scrolling. Trading on the left, staking on the right.
import { useEffect, useMemo, useRef, useState } from "react";
import { everyVisible, REFRESH_MS } from "./visible";
import { formatUnits, type Address } from "viem";
import { LAUNCH, LIVE, pct, whole } from "./config";
import { ERC20, STAKED_INFER, DRIPPER, chain, client, wallet, message } from "./chain";
import {
  ALLOWANCE_HOLDER,
  APPROVE_ABI,
  approvalsFor,
  askSwap,
  bestRoute,
  feeLine,
  tradeTokens,
  minReceived,
  routeSummary,
  swapQuery,
  zeroXAddress,
  type Route,
  type Token,
} from "../swap0x";
import {
  NATIVE,
  PERMIT2,
  QUOTER,
  UNIVERSAL_ROUTER,
  encodeSwap,
  minimumOut,
  priceFromSlot0,
  slot0Slot,
} from "./swap";
import {
  Balance,
  Fig,
  Line,
  Shell,
  Switch,
  TxStatus,
  Vanishing,
  notice,
  parseAmount,
  tokens,
  useBalance,
  useTx,
  useSiteWallet,
  useSubjectChanged,
  type Notice,
  type Wallet,
} from "./ui";

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function App() {
  const w = useSiteWallet();
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  // Live state is re-read every 30 seconds (and at once after each of the visitor's own transactions), so a drip,
  // the end of the one-block hold or a trade by someone else shows without a reload. It was every 12 s (one block),
  // which made every visitor's tab a steady stream of RPC calls for figures that rarely move that fast.
  useEffect(() => {
    if (!LIVE) return;
    return everyVisible(refresh, REFRESH_MS);
  }, []);
  return (
    <Shell page="app" depth={0} wallet={w} className="infer-screen">
      <main className="infer-desk" aria-label="Trade and stake INFER">
        <Trade w={w} tick={tick} refresh={refresh} />
        <Stake w={w} tick={tick} refresh={refresh} />
      </main>
    </Shell>
  );
}

// ------------------------------------------------------------------ trade

type Side = "buy" | "sell";

/** Quick amounts in the compact pane, in the token you pay with when buying. */
const QUICK_BUY: Record<string, string[]> = {
  ETH: ["0.01", "0.05", "0.1"],
  WETH: ["0.01", "0.05", "0.1"],
  IMD: ["10", "50", "100"],
  USDC: ["25", "100", "500"],
  USDT: ["25", "100", "500"],
  imdUSD: ["25", "100", "500"],
  WBTC: ["0.001", "0.005", "0.01"],
  cbBTC: ["0.001", "0.005", "0.01"],
};

function TokenSelect({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: Token[];
  value: string;
  onChange: (symbol: string) => void;
}) {
  return (
    <select
      className="infer-token"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {choices.map((t) => (
        <option key={t.symbol} value={t.symbol}>
          {t.symbol}
        </option>
      ))}
    </select>
  );
}

export function Trade({
  w,
  tick,
  refresh,
  compact = false,
}: {
  w: Wallet;
  tick: number;
  refresh: () => void;
  /** The /buy/ card's sheet: tabs, pay, receive, quick amounts and one button; the rest appears with a quote. */
  compact?: boolean;
}) {
  const c = LAUNCH.contracts;
  const key = LAUNCH.poolKey;
  const pair = LAUNCH.pair;
  const pairToken = c.pair; // NATIVE for ETH
  const { tx, send, clear } = useTx(refresh);
  const [side, setSide] = useState<Side>("buy");
  // What INFER is bought with or sold for. The launch pool only trades its pair; every other token goes through 0x.
  const choices = useMemo(() => tradeTokens(pairToken, pair), [pairToken, pair]);
  const [otherSymbol, setOtherSymbol] = useState(pair);
  const other = choices.find((t) => t.symbol === otherSymbol) ?? choices[0];
  const isPair = other.symbol === pair;
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(LAUNCH.slippageBps);
  const [quote, setQuote] = useState<{ out: bigint; forAmount: bigint } | null>(
    null,
  );
  const [quoteError, setQuoteError] = useState<Notice | null>(null);
  // Why a press of the button sent nothing. Unlike a read quote's error it survives refreshes, until the trade changes.
  const [goError, setGoError] = useState<Notice | null>(null);
  const [preparing, setPreparing] = useState(false);
  // 0x's price for the same amount (Matcha's engine, asked through this site's /swap proxy): the pane trades on
  // whichever of 0x and the launch pool returns more, as the imdUSD terminal's trade box does. `unavailable`
  // (no key yet, or 0x down) just leaves the launch pool.
  const [zx, setZx] = useState<{
    buy: bigint;
    forAmount: bigint;
    route: string;
    unavailable: boolean;
  } | null>(null);
  const [readError, setReadError] = useState<Notice | null>(null);
  const [price, setPrice] = useState<bigint | null>(null);
  const [bal, setBal] = useState<{
    pair: bigint;
    infer: bigint;
    permit: bigint;
    permitExp: bigint;
    erc20ToPermit2: bigint;
    /** The latest block's timestamp: deadlines and expiries are measured against the chain's clock,
     * not the browser's, which may be wrong by more than a deadline. */
    chainNow: bigint;
  } | null>(null);

  const tokenIn: Address | null =
    !LIVE || !c.infer ? null : side === "buy" ? other.address : c.infer;
  const tokenOut: Address | null =
    !LIVE || !c.infer ? null : side === "buy" ? c.infer : other.address;
  const decimalsIn = side === "buy" ? other.decimals : 18;
  const decimalsOut = side === "buy" ? 18 : other.decimals;
  const amountIn = parseAmount(amount, decimalsIn);
  const symbolIn = side === "buy" ? other.symbol : "INFER";
  const symbolOut = side === "buy" ? "INFER" : other.symbol;
  const sellTok: Token | null = tokenIn
    ? { address: zeroXAddress(tokenIn), symbol: symbolIn, name: symbolIn, decimals: decimalsIn }
    : null;
  const buyTok: Token | null = tokenOut
    ? { address: zeroXAddress(tokenOut), symbol: symbolOut, name: symbolOut, decimals: decimalsOut }
    : null;

  // The pool's price, read straight from the PoolManager's storage.
  useEffect(() => {
    if (!LIVE || !key || !c.infer) return;
    const infer = c.infer;
    client
      .getStorageAt({ address: c.poolManager, slot: slot0Slot(key) })
      .then((word) =>
        setPrice(
          word
            ? priceFromSlot0(
                word,
                // pair per INFER: slot0 gives currency1 per currency0, so invert when INFER is currency1
                infer.toLowerCase() === key.currency1.toLowerCase(),
              )
            : 0n,
        ),
      )
      // A failed read keeps the last price rather than showing zero.
      .catch(() => undefined);
  }, [tick, key, c.infer, c.poolManager]);

  // Balances and allowances of the connected account; cleared only when what they describe changes.
  const balSubject = useSubjectChanged(`${w.account}|${side}|${c.infer}|${pairToken}`);
  useEffect(() => {
    if (!LIVE || !c.infer || !w.account) return;
    const account = w.account,
      infer = c.infer;
    let stale = false;
    if (balSubject()) setBal(null);
    (async () => {
      const [pairBal, inferBal] = await Promise.all([
        pairToken === NATIVE
          ? client.getBalance({ address: account })
          : client.readContract({
              address: pairToken,
              abi: ERC20,
              functionName: "balanceOf",
              args: [account],
            }),
        client.readContract({
          address: infer,
          abi: ERC20,
          functionName: "balanceOf",
          args: [account],
        }),
      ]);
      const sellToken = side === "buy" ? pairToken : infer;
      let permit = MAX_UINT160,
        permitExp = MAX_UINT48,
        erc20ToPermit2 = MAX_UINT256;
      if (sellToken !== NATIVE) {
        [[permit, permitExp], erc20ToPermit2] = await Promise.all([
          client
            .readContract({
              address: LAUNCH.router.permit2,
              abi: PERMIT2,
              functionName: "allowance",
              args: [account, sellToken, LAUNCH.router.universalRouter],
            })
            .then(([a, e]) => [BigInt(a), BigInt(e)] as [bigint, bigint]),
          client.readContract({
            address: sellToken,
            abi: ERC20,
            functionName: "allowance",
            args: [account, LAUNCH.router.permit2],
          }),
        ]);
      }
      const { timestamp: chainNow } = await client.getBlock({
        blockTag: "latest",
      });
      if (!stale)
        setBal({
          pair: pairBal,
          infer: inferBal,
          permit,
          permitExp,
          erc20ToPermit2,
          chainNow,
        });
    })().catch((e) => {
      if (!stale)
        setReadError(notice(`Could not read your balances: ${message(e)}`));
    });
    return () => {
      stale = true;
    };
  }, [w.account, tick, side, c.infer, pairToken]);

  // A quote for the amount typed, debounced.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
    if (!LIVE || !key || !tokenIn || !isPair || amountIn === 0n) return;
    let stale = false;
    const t = setTimeout(() => {
      client
        .readContract({
          address: LAUNCH.router.quoter,
          abi: QUOTER,
          functionName: "quoteExactInputSingle",
          args: [
            {
              poolKey: key,
              zeroForOne: tokenIn.toLowerCase() === key.currency0.toLowerCase(),
              exactAmount: amountIn,
              hookData: "0x",
            },
          ],
        })
        // A slower answer for an older amount or token must not land over the newer one.
        .then(([out]) => !stale && setQuote({ out, forAmount: amountIn }))
        .catch((e) => !stale && setQuoteError(notice(message(e))));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [amountIn, tokenIn, isPair, key, tick]);

  // 0x's price for the typed amount, debounced like the pool quote.
  useEffect(() => {
    setZx(null);
    if (!LIVE || !sellTok || !buyTok || amountIn === 0n) return;
    let stale = false;
    const t = setTimeout(async () => {
      const a = await askSwap("price", swapQuery(sellTok, buyTok, amountIn, slippage));
      if (stale) return;
      setZx(
        a.ok
          ? { buy: BigInt(a.body.buyAmount!), forAmount: amountIn, route: routeSummary(a.body), unavailable: false }
          : { buy: 0n, forAmount: amountIn, route: "", unavailable: true },
      );
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, tokenIn, tokenOut, slippage, tick]);

  const directOut = isPair && quote && quote.forAmount === amountIn ? quote.out : undefined;
  const zxOut = zx && zx.forAmount === amountIn && !zx.unavailable ? zx.buy : undefined;
  const route: Route | undefined = bestRoute(zxOut, directOut);
  const out = route === "0x" ? zxOut : route === "direct" ? directOut : undefined;
  const minOutShown = out === undefined ? undefined : minimumOut(out, slippage);

  const needsErc20Approve =
    bal && tokenIn && tokenIn !== NATIVE && bal.erc20ToPermit2 < amountIn;
  const needsPermit =
    bal &&
    tokenIn &&
    tokenIn !== NATIVE &&
    (bal.permit < amountIn || bal.permitExp <= bal.chainNow);
  // The pay box's balance: the pair token (which exists before launch) on a buy, INFER on a sell.
  const balanceIn = useBalance(
    w.account,
    side === "buy" ? other.address : (c.infer ?? null),
    tick,
  );
  const insufficient = typeof balanceIn === "bigint" && amountIn > balanceIn;
  // The trade as the form has it now, to tell whether it changed during a wait for the firm quote.
  const tradeKey = `${tokenIn}|${tokenOut}|${amountIn}|${slippage}`;
  const latestTrade = useRef(tradeKey);
  latestTrade.current = tradeKey;
  useEffect(() => setGoError(null), [tradeKey]);

  /** The 0x route: a firm quote for this wallet, checked, then one approval step or the swap itself. */
  async function goZeroX(account: Address, p: NonNullable<Wallet["provider"]>) {
    if (!sellTok || !buyTok || out === undefined) return;
    const asked = tradeKey;
    const a = await askSwap("quote", swapQuery(sellTok, buyTok, amountIn, slippage, account));
    if (latestTrade.current !== asked) {
      setGoError(notice("You changed the trade while its quote was loading. Nothing was sent. Press the button again."));
      return;
    }
    if (!a.ok) {
      setGoError(notice(a.error));
      refresh();
      return;
    }
    const q = a.body;
    const tx = q.transaction;
    if (!tx || tx.to.toLowerCase() !== ALLOWANCE_HOLDER.toLowerCase() || !/^0x[0-9a-fA-F]+$/.test(tx.data)) {
      setGoError(notice("0x returned a transaction for an unexpected contract. Nothing was sent."));
      return;
    }
    const value = BigInt(tx.value ?? "0");
    if (tokenIn === NATIVE ? value !== amountIn : value !== 0n) {
      setGoError(notice("0x's transaction would send a different amount of ETH than this trade. Nothing was sent."));
      return;
    }
    if (q.sellAmount !== undefined && BigInt(q.sellAmount) !== amountIn) {
      setGoError(notice("0x quoted a different amount than this trade. Nothing was sent."));
      return;
    }
    const minOut = minReceived(BigInt(q.buyAmount!), slippage, q.minBuyAmount);
    if (minOut < minimumOut(out, slippage)) {
      setGoError(notice(`The price moved: 0x now returns at least ${tokens(minOut, 4, decimalsOut)} ${symbolOut}. Check the quote again.`));
      refresh();
      return;
    }
    const approvals = approvalsFor(sellTok, amountIn, q.issues?.allowance);
    if (approvals.length) {
      const first = approvals[0];
      await send(
        first.amount === 0n ? `Reset the ${symbolIn} allowance first` : `Approve ${symbolIn} for 0x`,
        async () => {
          const { request } = await client.simulateContract({
            account,
            address: sellTok.address,
            abi: APPROVE_ABI,
            functionName: "approve",
            args: [first.spender, first.amount],
          });
          return wallet(p).writeContract(request);
        },
      );
      return;
    }
    const sent = await send(side === "buy" ? "Buy INFER via Matcha/0x" : "Sell INFER via Matcha/0x", async () => {
      await client.call({ account, to: tx.to, data: tx.data, value });
      return wallet(p).sendTransaction({ account, chain, to: tx.to, data: tx.data, value });
    });
    if (sent) setAmount("");
  }

  /** The button: one press at a time, and whatever stops it is said on the form. */
  async function go() {
    if (preparing) return;
    setGoError(null);
    setPreparing(true);
    try {
      await goTrade();
    } catch (e) {
      setGoError(notice(message(e)));
    } finally {
      setPreparing(false);
    }
  }

  async function goTrade() {
    if (!w.account || !key || !tokenIn || !tokenOut || out === undefined || amountIn === 0n) return;
    const account = w.account;
    const p = w.provider!;
    if (route === "0x") return goZeroX(account, p);
    if (!quote) return;
    // The chain's clock, read now: a 20-minute swap deadline and a 30-day permit from it.
    const { timestamp: now } = await client.getBlock({ blockTag: "latest" });
    if (needsErc20Approve) {
      await send(
        `Approve ${side === "buy" ? pair : "INFER"} for Permit2`,
        async () => {
          const { request } = await client.simulateContract({
            account,
            address: tokenIn,
            abi: ERC20,
            functionName: "approve",
            args: [LAUNCH.router.permit2, MAX_UINT256],
          });
          return wallet(p).writeContract(request);
        },
      );
      return;
    }
    if (needsPermit) {
      await send("Permit the router", async () => {
        const { request } = await client.simulateContract({
          account,
          address: LAUNCH.router.permit2,
          abi: PERMIT2,
          functionName: "approve",
          args: [
            tokenIn,
            LAUNCH.router.universalRouter,
            MAX_UINT160,
            Number(now + 30n * 24n * 3600n),
          ],
        });
        return wallet(p).writeContract(request);
      });
      return;
    }
    const minOut = minimumOut(quote.out, slippage);
    const { commands, inputs, value } = encodeSwap({
      key,
      tokenIn,
      amountIn,
      minOut,
    });
    const sent = await send(side === "buy" ? "Buy INFER" : "Sell INFER", async () => {
      const { request } = await client.simulateContract({
        account,
        address: LAUNCH.router.universalRouter,
        abi: UNIVERSAL_ROUTER,
        functionName: "execute",
        args: [commands, inputs, now + 20n * 60n],
        value,
      });
      return wallet(p).writeContract(request);
    });
    if (sent) setAmount("");
  }

  const button = !LIVE
    ? "Trading opens at launch"
    : preparing
      ? "Getting a firm quote…"
    : !w.account
      ? "Connect a wallet"
      : amountIn === 0n
        ? "Enter an amount"
        : insufficient
          ? `Not enough ${symbolIn}`
          : !bal
            ? "Reading your balances…"
            : route === "0x"
              ? side === "buy"
                ? "Buy INFER"
                : "Sell INFER"
              : needsErc20Approve
                ? `Approve ${symbolIn}`
                : needsPermit
                  ? "Permit the router"
                  : side === "buy"
                    ? "Buy INFER"
                    : "Sell INFER";

  const quick =
    side === "buy"
      ? (QUICK_BUY[other.symbol] ?? []).map((v) => [`${v} ${other.symbol}`, v] as const)
      : bal && bal.infer > 0n
        ? ([25n, 50n, 100n] as const).map(
            (pc) =>
              [
                pc === 100n ? "Max" : `${pc}%`,
                formatUnits((bal.infer * pc) / 100n, 18),
              ] as const,
          )
        : [];

  return (
    <section
      className={`infer-pane infer-trade${compact ? " infer-trade-compact" : ""}`}
      aria-labelledby="trade-heading"
    >
      <header className="infer-pane-head">
        <h1 id="trade-heading" className={compact ? "sr-only" : undefined}>
          Trade
        </h1>
        <Switch
          label="Side"
          value={side}
          options={[
            ["buy", "Buy"],
            ["sell", "Sell"],
          ]}
          onChange={setSide}
        />
      </header>

      <form
        className="infer-ticket"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="infer-field">
          <span className="infer-field-k">
            You pay
            <Balance
              wallet={w}
              account={w.account}
              value={balanceIn}
              symbol={symbolIn}
              decimals={decimalsIn}
              onUse={setAmount}
            />
          </span>
          <span className="infer-field-row">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              disabled={!LIVE}
              aria-label={`Amount of ${symbolIn} to pay`}
            />
            {side === "buy" && LIVE ? (
              <TokenSelect
              label="Token to pay with"
              choices={choices}
              value={other.symbol}
              onChange={(v) => {
                setOtherSymbol(v);
                setAmount("");
              }}
            />
            ) : (
              <b>{symbolIn}</b>
            )}
          </span>
        </div>
        <div className="infer-perforation" aria-hidden="true" />
        <div className="infer-field">
          <span className="infer-field-k">You receive</span>
          <span className="infer-field-row">
            <output aria-live="polite" aria-label="You receive">
              {out !== undefined
                ? tokens(out, 4, decimalsOut)
                : amountIn === 0n
                  ? "0"
                  : quoteError || (!isPair && zx?.unavailable)
                    ? "no quote"
                    : "…"}
            </output>
            {side === "sell" && LIVE ? (
              <TokenSelect
              label="Token to receive"
              choices={choices}
              value={other.symbol}
              onChange={(v) => {
                setOtherSymbol(v);
                setAmount("");
              }}
            />
            ) : (
              <b>{symbolOut}</b>
            )}
          </span>
        </div>
        {compact && quick.length > 0 && (
          <div className="infer-quick" role="group" aria-label="Amount">
            <span>amount</span>
            {quick.map(([label, v]) => (
              <button
                key={label}
                type="button"
                aria-pressed={amount === v}
                disabled={!LIVE}
                onClick={() => setAmount(v)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {(!compact || amountIn > 0n) && (
          <dl className="infer-lines">
            <Line
              k={compact ? "Rate" : "Price"}
              v={
                !LIVE
                  ? "set at launch"
                  : price === null
                    ? "…"
                    : price === 0n
                      ? "unavailable"
                      : `${tokens(price, 6)} ${pair} per INFER`
              }
            />
            <Line
              k="Minimum received"
              v={
                minOutShown !== undefined
                  ? `${tokens(minOutShown, 4, decimalsOut)} ${symbolOut}`
                  : "—"
              }
            />
            {!compact && (
              <Line
                k="Slippage"
                v={
                  <span
                    className="infer-slippage"
                    role="radiogroup"
                    aria-label="Slippage tolerance"
                  >
                    {[50, 100, 300].map((bps) => (
                      <button
                        key={bps}
                        type="button"
                        role="radio"
                        aria-checked={slippage === bps}
                        onClick={() => setSlippage(bps)}
                      >
                        {bps / 100}%
                      </button>
                    ))}
                  </span>
                }
              />
            )}
            <Line
              k="Route"
              v={
                !LIVE
                  ? "the launch pool"
                  : route === "0x"
                    ? `Matcha/0x · ${zx?.route || "best price"}`
                    : route === "direct"
                      ? `Uniswap v4 · ${pair}/INFER · ${key ? `${key.fee / 10_000}% fee` : ""}`
                      : "…"
              }
            />
            {!compact && route === "0x" && sellTok && buyTok && (
              <Line k="Fee" v={feeLine(sellTok.address, buyTok.address)} />
            )}
          </dl>
        )}
        {quoteError && (
          <Vanishing
            key={quoteError.id}
            className="infer-warn"
            onDone={() => setQuoteError(null)}
          >
            {quoteError.text}
          </Vanishing>
        )}
        {goError && (
          <Vanishing
            key={goError.id}
            className="infer-warn"
            onDone={() => setGoError(null)}
          >
            {goError.text}
          </Vanishing>
        )}
        {readError && (
          <Vanishing
            key={readError.id}
            className="infer-warn"
            onDone={() => setReadError(null)}
          >
            {readError.text}
          </Vanishing>
        )}
        {/* With no account the big button connects: on /buy/ there is no masthead Connect, and the amount
            box's "disconnected" label alone was too easy to miss (as on the home page, 2026-10-11). */}
        {LIVE && !w.account ? (
          <button className="infer-go" type="button" disabled={w.busy} onClick={() => void w.connect()}>
            {button}
          </button>
        ) : (
          <button
            className="infer-go"
            type="submit"
            disabled={
              !LIVE ||
              preparing ||
              !bal ||
              amountIn === 0n ||
              insufficient ||
              out === undefined ||
              tx.status === "pending"
            }
          >
            {button}
          </button>
        )}
        <TxStatus tx={tx} onDone={clear} />
      </form>

      {!compact && (
        <footer className="infer-pane-foot">
          <dl className="infer-lines">
            <Line
              k="Pool"
              v={
                <>
                  {LAUNCH.pair}/INFER,{" "}
                  {pct(
                    LAUNCH.allocation.find((a) => a.key === "pool")?.bps ??
                      null,
                  ) ?? "—"}{" "}
                  of supply, held by the factory for good
                </>
              }
            />
            <Line
              k="Opening cap"
              v={
                <Fig
                  v={whole(LAUNCH.openingMarketCapImd, 0)}
                  unit={LAUNCH.pair}
                />
              }
            />
            <Line
              k="Fees"
              v={
                <>
                  <Fig v={pct(LAUNCH.fees.treasuryBps)} /> of pool fees to the
                  Treasury
                </>
              }
            />
          </dl>
          <p className="infer-fine">
            Each trade is quoted on the launch pool and on 0x (the engine
            behind Matcha) and goes from your wallet to whichever returns more;
            this page only quotes and prepares it.
          </p>
        </footer>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ stake

function Stake({
  w,
  tick,
  refresh,
}: {
  w: Wallet;
  tick: number;
  refresh: () => void;
}) {
  const c = LAUNCH.contracts;
  const { tx, send, clear } = useTx(refresh);
  const [readError, setReadError] = useState<Notice | null>(null);
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [amount, setAmount] = useState("");
  const [st, setSt] = useState<{
    total: bigint;
    totalShares: bigint;
    rate: bigint;
    buffer: bigint;
    releasable: bigint;
    infer: bigint;
    shares: bigint;
    worth: bigint;
    allowance: bigint;
    maxRedeem: bigint;
  } | null>(null);

  const stakeSubject = useSubjectChanged(`${w.account}|${c.infer}|${c.stakedInfer}`);
  useEffect(() => {
    if (!LIVE || !c.infer || !c.stakedInfer) return;
    const infer = c.infer,
      vault = c.stakedInfer,
      dripper = c.dripper;
    const account = w.account;
    let stale = false;
    if (stakeSubject()) setSt(null);
    (async () => {
      const [total, totalShares, rate, buffer, releasable] = await Promise.all([
        client.readContract({
          address: vault,
          abi: STAKED_INFER,
          functionName: "totalAssets",
        }),
        client.readContract({
          address: vault,
          abi: STAKED_INFER,
          functionName: "totalSupply",
        }),
        client.readContract({
          address: vault,
          abi: STAKED_INFER,
          functionName: "convertToAssets",
          args: [10n ** 24n],
        }),
        dripper
          ? client.readContract({
              address: infer,
              abi: ERC20,
              functionName: "balanceOf",
              args: [dripper],
            })
          : Promise.resolve(0n),
        dripper
          ? client.readContract({
              address: dripper,
              abi: DRIPPER,
              functionName: "releasable",
            })
          : Promise.resolve(0n),
      ]);
      let bal = 0n,
        shares = 0n,
        worth = 0n,
        allowance = 0n,
        maxRedeem = 0n;
      if (account) {
        [bal, shares, allowance, maxRedeem] = await Promise.all([
          client.readContract({
            address: infer,
            abi: ERC20,
            functionName: "balanceOf",
            args: [account],
          }),
          client.readContract({
            address: vault,
            abi: STAKED_INFER,
            functionName: "balanceOf",
            args: [account],
          }),
          client.readContract({
            address: infer,
            abi: ERC20,
            functionName: "allowance",
            args: [account, vault],
          }),
          client.readContract({
            address: vault,
            abi: STAKED_INFER,
            functionName: "maxRedeem",
            args: [account],
          }),
        ]);
        worth = await client.readContract({
          address: vault,
          abi: STAKED_INFER,
          functionName: "convertToAssets",
          args: [shares],
        });
      }
      if (!stale)
        setSt({
          total,
          totalShares,
          rate,
          buffer,
          releasable,
          infer: bal,
          shares,
          worth,
          allowance,
          maxRedeem,
        });
    })().catch((e) => {
      if (!stale)
        setReadError(notice(`Could not read the vault: ${message(e)}`));
    });
    return () => {
      stale = true;
    };
  }, [w.account, tick, c.infer, c.stakedInfer, c.dripper]);

  // Staking is entered in INFER (18 decimals), unstaking in sINFER (24-decimal shares).
  const unit = mode === "stake" ? "INFER" : "sINFER";
  const decimals = mode === "stake" ? 18 : 24;
  const wei = parseAmount(amount, decimals);
  const balance = useBalance(
    w.account,
    (mode === "stake" ? c.infer : c.stakedInfer) ?? null,
    tick,
  );
  // What the shares being unstaked are worth, at the vault's own rate.
  const unstakeWorth =
    st && mode === "unstake" && st.shares !== 0n
      ? (st.worth * wei) / st.shares
      : 0n;
  const insufficient = typeof balance === "bigint" && wei > balance;
  // Shares minted this block cannot leave it yet: the hold is what stops the unstake, not the balance.
  const held =
    mode === "unstake" && !!st && !insufficient && wei > st.maxRedeem;
  const share =
    st && st.totalShares !== 0n
      ? Number((st.shares * 1_000_000n) / st.totalShares) / 10_000
      : 0;

  async function go() {
    if (!w.account || !c.infer || !c.stakedInfer || !st || wei === 0n) return;
    const account = w.account,
      infer = c.infer,
      vault = c.stakedInfer,
      p = w.provider!;
    let sent = false;
    if (mode === "stake") {
      if (st.allowance < wei) {
        await send("Approve INFER", async () => {
          const { request } = await client.simulateContract({
            account,
            address: infer,
            abi: ERC20,
            functionName: "approve",
            args: [vault, wei],
          });
          return wallet(p).writeContract(request);
        });
        return;
      }
      sent = await send("Stake", async () => {
        const { request } = await client.simulateContract({
          account,
          address: vault,
          abi: STAKED_INFER,
          functionName: "deposit",
          args: [wei, account],
        });
        return wallet(p).writeContract(request);
      });
    } else {
      // The input is sINFER shares; the button is disabled while the one-block hold covers them.
      const shares = wei;
      if (shares === 0n || shares > st.maxRedeem) return;
      sent = await send("Unstake", async () => {
        const { request } = await client.simulateContract({
          account,
          address: vault,
          abi: STAKED_INFER,
          functionName: "redeem",
          args: [shares, account, account],
        });
        return wallet(p).writeContract(request);
      });
    }
    if (sent) setAmount("");
  }

  const button = !LIVE ? (
    "Staking opens with the token"
  ) : !w.account ? (
    "Connect a wallet to stake"
  ) : wei === 0n ? (
    "Enter an amount"
  ) : insufficient ? (
    mode === "stake" ? (
      "Not enough INFER"
    ) : (
      <span className="infer-case">More sINFER than you hold</span>
    )
  ) : mode === "stake" ? (
    st && st.allowance < wei ? (
      "Approve INFER"
    ) : (
      "Stake"
    )
  ) : !st ? (
    "Reading the vault…"
  ) : held ? (
    "Wait one block"
  ) : (
    "Unstake"
  );

  return (
    <section className="infer-pane infer-stake" aria-labelledby="stake-heading">
      <header className="infer-pane-head">
        <h1 id="stake-heading">Stake</h1>
        <Switch
          label="Direction"
          value={mode}
          options={[
            ["stake", "Stake"],
            ["unstake", "Unstake"],
          ]}
          onChange={setMode}
        />
      </header>

      <div className="infer-stats" role="group" aria-label="Your stake">
        <div className="infer-stat big">
          <span>Your stake</span>
          <strong>{w.account && LIVE ? tokens(st?.worth) : "—"}</strong>
          <small>INFER, redeemable now</small>
        </div>
        <div className="infer-stat">
          <span>Your share</span>
          <strong>{w.account && LIVE && st ? `${share}%` : "—"}</strong>
          <small>of everything staked</small>
        </div>
        <div className="infer-stat">
          <span className="infer-case">sINFER held</span>
          <strong>{w.account && LIVE ? tokens(st?.shares, 4, 24) : "—"}</strong>
          <small>24-decimal sINFER</small>
        </div>
        <div className="infer-stat">
          <span>In your wallet</span>
          <strong>{w.account && LIVE ? tokens(st?.infer) : "—"}</strong>
          <small>INFER, unstaked</small>
        </div>
      </div>

      <form
        className="infer-ticket"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className="infer-field">
          <span className="infer-field-k">
            {mode === "stake" ? "Stake" : "Unstake"}
            <Balance
              wallet={w}
              account={w.account}
              value={balance}
              symbol={unit}
              decimals={decimals}
              onUse={setAmount}
            />
          </span>
          <span className="infer-field-row">
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              disabled={!LIVE}
              aria-label={`${unit} to ${mode}`}
            />
            <b className="infer-case">{unit}</b>
          </span>
        </div>
        {mode === "unstake" && LIVE && (
          <dl className="infer-lines">
            <Line k="You receive" v={`${tokens(unstakeWorth, 4)} INFER`} />
          </dl>
        )}
        <button
          className="infer-go"
          disabled={
            !LIVE ||
            !w.account ||
            !st ||
            wei === 0n ||
            insufficient ||
            held ||
            tx.status === "pending"
          }
        >
          {button}
        </button>
        <TxStatus tx={tx} onDone={clear} />
        {readError && (
          <Vanishing
            key={readError.id}
            className="infer-warn"
            onDone={() => setReadError(null)}
          >
            {readError.text}
          </Vanishing>
        )}
      </form>

      <footer className="infer-pane-foot">
        <dl className="infer-lines">
          <Line
            k="Staked in total"
            v={LIVE ? `${tokens(st?.total, 0)} INFER` : "—"}
          />
          <Line k="1 sINFER" v={LIVE ? `${tokens(st?.rate, 6)} INFER` : "—"} />
          <Line
            k="Rewards waiting to drip"
            v={
              LIVE && c.dripper
                ? `${tokens(st?.buffer, 0)} INFER · ${tokens(st?.releasable, 2)} releasable now`
                : "—"
            }
          />
        </dl>
        <p className="infer-fine">
          The Treasury buys INFER with the protocol's revenue and drips it into
          the vault over about a week, so each sINFER is worth more INFER over
          time.
        </p>
      </footer>
    </section>
  );
}
