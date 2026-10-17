// /claim: the minimal page. Connect, see what is yours, take it.
import { useEffect, useState } from "react";
import { everyVisible, REFRESH_MS } from "./visible";
import { formatUnits, parseUnits, type Address } from "viem";
import { LAUNCH, LIVE, whole } from "./config";
import { FUEL_GIFT, MOON, advanceWith, blocksToTime, moonState, type MoonState } from "./moon";
import {
  ERC20,
  LEGACY_REDEEMER,
  SEASON_VAULT,
  client,
  leafFile,
  message,
  wallet,
} from "./chain";
import {
  Line,
  Shell,
  TxStatus,
  tokens,
  useTx,
  useSiteWallet,
  Balance,
  Vanishing,
  notice,
  parseAmount,
  useBalances,
  type Notice,
} from "./ui";

/** One opened season as the vault reports it (seasons are opened by the governor, not on a clock). */
type SeasonView = {
  index: number;
  start: bigint;
  end: bigint;
  hasRoot: boolean;
  /** Last moment to claim (register); 0 before the season's list is set. */
  deadline: bigint;
  expired: boolean;
  amount: bigint;
  paid: bigint;
  releasable: bigint;
};

const day = (t: bigint) => new Date(Number(t) * 1000).toISOString().slice(0, 10);

/** A season's line, from the chain's clock: announced, running, awaiting its list, claimable, paying, or closed. */
function seasonState(s: SeasonView, now: bigint): string {
  if (now < s.start) return `opens ${day(s.start)}`;
  if (now < s.end) return `running until ${day(s.end)}`;
  if (!s.hasRoot) return s.expired ? "closed" : "list pending";
  if (s.amount !== 0n) return `${tokens(s.paid)} of ${tokens(s.amount)} released`;
  return s.expired || now >= s.deadline ? "closed" : `claim by ${day(s.deadline)}`;
}

export function Claim() {
  const w = useSiteWallet();
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  // Live state is re-read every twelve seconds, Ethereum's block time, so a new block (the end of
  // the one-block hold, a drip, a trade by someone else) shows without a reload.
  useEffect(() => {
    if (!LIVE) return;
    return everyVisible(refresh, REFRESH_MS);
  }, []);
  const { tx, send, clear } = useTx(refresh);
  const [readError, setReadError] = useState<Notice | null>(null);
  const c = LAUNCH.contracts;
  const [seasons, setSeasons] = useState<SeasonView[] | null>(null);
  const [legacy, setLegacy] = useState<
    Record<string, { balance: bigint; allowance: bigint; left: bigint }>
  >({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // The chain's clock, read with the seasons: a season has ended when the chain says so, not the browser.
  const [now, setNow] = useState<bigint>(0n);
  // Each redemption box's balance, read whenever a wallet is connected and the legacy token is known.
  const legacyBalances = useBalances(
    w.account,
    LAUNCH.redemptions.map((r) => r.token),
    tick,
  );

  useEffect(() => {
    if (!LIVE || !c.seasonVault) return;
    const vault = c.seasonVault,
      account = w.account;
    let stale = false;
    (async () => {
      const { timestamp } = await client.getBlock({ blockTag: "latest" });
      const [count, length, registration] = await Promise.all(
        (["opened", "SEASON", "REGISTRATION"] as const).map((functionName) =>
          client.readContract({ address: vault, abi: SEASON_VAULT, functionName }),
        ),
      );
      const views: SeasonView[] = [];
      for (let s = 0; s < Number(count); s++) {
        const season = await client.readContract({
          address: vault,
          abi: SEASON_VAULT,
          functionName: "season",
          args: [BigInt(s)],
        });
        let amount = 0n,
          paid = 0n,
          releasable = 0n;
        if (account) {
          [[amount, paid], releasable] = await Promise.all([
            client.readContract({
              address: vault,
              abi: SEASON_VAULT,
              functionName: "entitlements",
              args: [BigInt(s), account],
            }),
            client.readContract({
              address: vault,
              abi: SEASON_VAULT,
              functionName: "releasable",
              args: [BigInt(s), account],
            }),
          ]);
        }
        const hasRoot = season.rootSetAt !== 0n;
        views.push({
          index: s,
          start: season.start,
          end: season.start + length,
          hasRoot,
          deadline: hasRoot ? season.rootSetAt + registration : 0n,
          expired: season.expired,
          amount,
          paid,
          releasable,
        });
      }
      if (!stale) {
        setNow(timestamp);
        setSeasons(views);
      }
    })().catch((e) => {
      if (!stale)
        setReadError(notice(`Could not read the chain: ${message(e)}`));
    });
    return () => {
      stale = true;
    };
  }, [w.account, tick, c.seasonVault]);

  // Each redemption token's full-moon clock (MXXN's moonConfig), read for every visitor: a token without one reverts
  // and simply has no clock.
  // `fuel`: the redeemer's own balance of the token, which its advanceClock burns 1 wei at a time.
  const [moons, setMoons] = useState<Record<string, MoonState & { fuel: bigint }>>({});
  useEffect(() => {
    if (!LIVE) return;
    let stale = false;
    (async () => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const out: Record<string, MoonState & { fuel: bigint }> = {};
      await Promise.all(
        LAUNCH.redemptions.map(async (r) => {
          if (!r.token) return;
          try {
            const [[start, end], fuel] = await Promise.all([
              client.readContract({ address: r.token, abi: MOON, functionName: "moonConfig" }),
              c.legacyRedeemer
                ? client.readContract({ address: r.token, abi: MOON, functionName: "balanceOf", args: [c.legacyRedeemer] })
                : 0n,
            ]);
            out[r.key] = { ...moonState(start, end, head), fuel };
          } catch {
            /* no moon clock on this token */
          }
        }),
      );
      if (!stale) setMoons(out);
    })().catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [tick, c.legacyRedeemer]);

  useEffect(() => {
    if (!LIVE || !c.legacyRedeemer || !w.account) return;
    const redeemer = c.legacyRedeemer,
      account = w.account;
    let stale = false;
    (async () => {
      const out: typeof legacy = {};
      for (const r of LAUNCH.redemptions) {
        if (!r.token) continue;
        const [balance, allowance, redeemed] = await Promise.all([
          client.readContract({
            address: r.token,
            abi: ERC20,
            functionName: "balanceOf",
            args: [account],
          }),
          client.readContract({
            address: r.token,
            abi: ERC20,
            functionName: "allowance",
            args: [account, redeemer],
          }),
          client.readContract({
            address: redeemer,
            abi: LEGACY_REDEEMER,
            functionName: "redeemed",
            args: [r.token],
          }),
        ]);
        const allocation = parseUnits(r.allocation ?? "0", 18);
        out[r.key] = {
          balance,
          allowance,
          left: allocation > redeemed ? allocation - redeemed : 0n,
        };
      }
      if (!stale) setLegacy(out);
    })().catch((e) => {
      if (!stale)
        setReadError(notice(`Could not read the chain: ${message(e)}`));
    });
    return () => {
      stale = true;
    };
  }, [w.account, tick, c.legacyRedeemer]);

  async function claimSeason(s: SeasonView) {
    if (!w.account || !c.seasonVault) return;
    const account = w.account,
      vault = c.seasonVault,
      p = w.provider!;
    await send(
      s.amount === 0n
        ? `Claim season ${s.index + 1}`
        : `Release season ${s.index + 1}`,
      async () => {
        if (s.amount === 0n) {
          const file = await leafFile(s.index);
          const leaf = file?.claims[account.toLowerCase()];
          if (!leaf)
            throw Error("No entitlement for this address in that season.");
          const { request } = await client.simulateContract({
            account,
            address: vault,
            abi: SEASON_VAULT,
            functionName: "claim",
            args: [BigInt(s.index), account, BigInt(leaf.amount), leaf.proof],
          });
          return wallet(p).writeContract(request);
        }
        const { request } = await client.simulateContract({
          account,
          address: vault,
          abi: SEASON_VAULT,
          functionName: "release",
          args: [BigInt(s.index), account],
        });
        return wallet(p).writeContract(request);
      },
    );
  }

  /** Move the full-moon clock: with fuel in the redeemer, its advanceClock catches up as many moons as the fuel
   * covers in one transaction (anyone); without, burn 1 wei of the connected wallet's own MXXN (one moon). */
  async function advanceClock(key: string) {
    const r = LAUNCH.redemptions.find((x) => x.key === key)!;
    const moon = moons[r.key];
    if (!w.account || !r.token || !moon) return;
    const account = w.account,
      token = r.token,
      p = w.provider!;
    const how = advanceWith(moon.behind, c.legacyRedeemer ? moon.fuel : 0n);
    await send(`Advance the ${r.symbol} clock`, async () => {
      if (how.via === "redeemer") {
        const { request } = await client.simulateContract({
          account,
          address: c.legacyRedeemer!,
          abi: LEGACY_REDEEMER,
          functionName: "advanceClock",
          args: [token, how.steps],
        });
        return wallet(p).writeContract(request);
      }
      const { request } = await client.simulateContract({
        account,
        address: token,
        abi: MOON,
        functionName: "burn",
        args: [1n],
      });
      return wallet(p).writeContract(request);
    });
  }

  /** During a full moon, send the redeemer a little MXXN so anyone can move its clock later without holding any. */
  async function addFuel(key: string) {
    const r = LAUNCH.redemptions.find((x) => x.key === key)!;
    if (!w.account || !r.token || !c.legacyRedeemer) return;
    const account = w.account,
      token = r.token,
      redeemer = c.legacyRedeemer,
      p = w.provider!;
    await send(`Fuel the ${r.symbol} clock`, async () => {
      const { request } = await client.simulateContract({
        account,
        address: token,
        abi: MOON,
        functionName: "transfer",
        args: [redeemer, FUEL_GIFT],
      });
      return wallet(p).writeContract(request);
    });
  }

  async function redeem(key: string) {
    const r = LAUNCH.redemptions.find((x) => x.key === key)!;
    if (!w.account || !c.legacyRedeemer || !r.token) return;
    const account = w.account,
      redeemer = c.legacyRedeemer,
      token = r.token,
      p = w.provider!;
    const amount = parseAmount(amounts[key] ?? "", r.decimals);
    if (amount === 0n) return;
    const st = legacy[key];
    if (st && st.allowance < amount) {
      await send(`Approve ${r.symbol}`, async () => {
        const { request } = await client.simulateContract({
          account,
          address: token,
          abi: ERC20,
          functionName: "approve",
          args: [redeemer, amount],
        });
        return wallet(p).writeContract(request);
      });
      return;
    }
    await send(`Redeem ${r.symbol}`, async () => {
      const { request } = await client.simulateContract({
        account,
        address: redeemer,
        abi: LEGACY_REDEEMER,
        functionName: "redeem",
        args: [token, amount],
      });
      return wallet(p).writeContract(request);
    });
    setAmounts((a) => ({ ...a, [key]: "" }));
  }

  const toAddress: Address | null = w.account;
  return (
    <Shell page="claim" depth={1} wallet={w} className="infer-page">
      <main className="infer-claim">
        <h1>Claim</h1>
        <p className="infer-lede">
          What INFER is yours, and the one button that gives it. Season points
          vest over 13 weeks from when the season's list is published;
          redemptions pay at once.
        </p>

        <section
          className="infer-ticket infer-claim-block"
          aria-labelledby="seasons-h"
        >
          <h2 id="seasons-h">Season points</h2>
          {!LIVE || !c.seasonVault ? (
            <p className="infer-fine">Seasons are announced here.</p>
          ) : !toAddress ? (
            <p className="infer-fine">Connect a wallet to see your seasons.</p>
          ) : seasons === null ? (
            <p className="infer-fine">Reading…</p>
          ) : seasons.length === 0 ? (
            <p className="infer-fine">No season has been announced yet.</p>
          ) : (
            <dl className="infer-lines">
              {seasons.map((s) => (
                <Line
                  key={s.index}
                  k={
                    <>
                      Season {s.index + 1}
                      <small>
                        {" "}
                        ·{" "}
                        {seasonState(s, now)}
                      </small>
                    </>
                  }
                  v={
                    <button
                      className="infer-small"
                      disabled={
                        !s.hasRoot ||
                        tx.status === "pending" ||
                        (s.amount === 0n && (s.expired || now >= s.deadline)) ||
                        (s.amount !== 0n && s.releasable === 0n)
                      }
                      onClick={() => claimSeason(s)}
                    >
                      {s.amount === 0n
                        ? "Claim"
                        : `Release ${tokens(s.releasable)}`}
                    </button>
                  }
                />
              ))}
            </dl>
          )}
        </section>

        {LAUNCH.redemptions.map((r, i) => {
          const st = legacy[r.key];
          const moon = moons[r.key];
          // A clocked token (MXXN) can only reach the redeemer inside its full moon.
          const shut = moon !== undefined && !moon.redeemable;
          const amount = parseAmount(amounts[r.key] ?? "", r.decimals);
          const out = r.rate
            ? (amount * parseUnits(r.rate, 18)) / 10n ** 18n
            : 0n;
          return (
            <section
              className="infer-ticket infer-claim-block"
              aria-labelledby={`${r.key}-h`}
              key={r.key}
            >
              <h2 id={`${r.key}-h`}>Redeem {r.symbol}</h2>
              <p className="infer-fine">
                {r.rate
                  ? `${whole(r.rate, 6)} INFER per ${r.symbol}`
                  : "Rate published at launch"}
                , {r.window}.
              </p>
              {moon && (
                <div className="infer-moon" aria-live="polite">
                  <dl className="infer-lines">
                    <Line
                      k="Full moon"
                      v={
                        moon.open
                          ? `now · closes in ${blocksToTime(moon.end - moon.head)}`
                          : `in ${blocksToTime(moon.start - moon.head)}`
                      }
                    />
                    <Line
                      k={`${r.symbol}'s clock`}
                      v={moon.behind === 0n ? "on time" : `${moon.behind} moon${moon.behind === 1n ? "" : "s"} behind`}
                    />
                  </dl>
                  {moon.needed > 0n ? (
                    <p className="infer-fine">
                      {r.symbol} keeps its own moon clock, and it only moves when {r.symbol} does. It needs{" "}
                      {moon.needed.toString()} more one-wei burn{moon.needed === 1n ? "" : "s"} before redemptions can go
                      through at {moon.open ? "this" : "the next"} full moon (each burn moves it one moon; the redemption
                      itself moves the last). Anyone holding {r.symbol} can do it.
                    </p>
                  ) : (
                    <p className="infer-fine">
                      {moon.open
                        ? `${r.symbol} can move now: redemptions go through until the full moon closes.`
                        : `The clock is ready. Redemptions open at the full moon, block ${moon.start.toString()}.`}
                    </p>
                  )}
                  <dl className="infer-lines">
                    <Line
                      k="Clock fuel"
                      v={moon.fuel === 0n ? "none" : `${moon.fuel.toString()} wei ${r.symbol}`}
                    />
                  </dl>
                  {(() => {
                    if (moon.behind === 0n || moon.redeemable) return null;
                    const how = advanceWith(moon.behind, moon.fuel);
                    const needsOwn = how.via === "wallet";
                    return (
                      <button
                        type="button"
                        className="infer-small"
                        disabled={!toAddress || (needsOwn && !legacyBalances[i]) || tx.status === "pending"}
                        title={!toAddress ? "Connect a wallet" : needsOwn && !legacyBalances[i] ? `Needs any ${r.symbol} in your wallet` : undefined}
                        onClick={() => advanceClock(r.key)}
                      >
                        {how.via === "redeemer"
                          ? how.steps >= moon.behind
                            ? "Catch the clock up · one transaction"
                            : `Advance ${how.steps.toString()} moon${how.steps === 1n ? "" : "s"} · one transaction`
                          : `Advance the clock · burn 1 wei ${r.symbol}`}
                      </button>
                    );
                  })()}
                  <p className="infer-fine">
                    {moon.fuel > 0n
                      ? `The redeemer burns its own ${r.symbol} to move the clock, so anyone can catch it up, holding ${r.symbol} or not. Each moon behind costs 1 wei.`
                      : `Fuel lets anyone catch the clock up in one transaction without holding ${r.symbol}: during a full moon, send the redeemer a few wei of ${r.symbol}. Each moon behind costs 1 wei.`}
                  </p>
                  {moon.redeemable && (
                    <button
                      type="button"
                      className="infer-small"
                      disabled={!toAddress || !legacyBalances[i] || legacyBalances[i]! < FUEL_GIFT || tx.status === "pending"}
                      title={!toAddress ? "Connect a wallet" : !legacyBalances[i] ? `Needs ${r.symbol} in your wallet` : undefined}
                      onClick={() => addFuel(r.key)}
                    >
                      Add fuel · send {FUEL_GIFT.toString()} wei {r.symbol} to the redeemer
                    </button>
                  )}
                </div>
              )}
              {!LIVE || !c.legacyRedeemer || !r.token ? (
                <p className="infer-fine">Opens at launch.</p>
              ) : (
                <form
                  className="infer-redeem"
                  onSubmit={(e) => {
                    e.preventDefault();
                    redeem(r.key);
                  }}
                >
                  <div className="infer-field">
                    <span className="infer-field-k">
                      {r.symbol} to burn
                      <Balance
                        wallet={w}
                        account={toAddress}
                        value={legacyBalances[i]}
                        symbol={r.symbol}
                        decimals={r.decimals}
                        onUse={(v) => setAmounts((a) => ({ ...a, [r.key]: v }))}
                      />
                    </span>
                    <span className="infer-field-row">
                      <input
                        inputMode="decimal"
                        value={amounts[r.key] ?? ""}
                        onChange={(e) =>
                          setAmounts((a) => ({ ...a, [r.key]: e.target.value }))
                        }
                        placeholder="0"
                        aria-label={`${r.symbol} to burn`}
                      />
                      <b>{r.symbol}</b>
                    </span>
                  </div>
                  <dl className="infer-lines">
                    <Line k="You receive" v={`${tokens(out, 4)} INFER`} />
                    <Line
                      k="Left to redeem"
                      v={`${tokens(st?.left, 0)} INFER`}
                    />
                  </dl>
                  {!toAddress ? (
                    // It was disabled like the others, so the one button a visitor could find did nothing.
                    <button
                      type="button"
                      className="infer-go"
                      disabled={w.busy}
                      onClick={() => void w.connect()}
                    >
                      {w.busy ? "Connecting…" : "Connect a wallet"}
                    </button>
                  ) : (
                    <button
                      className="infer-go"
                      disabled={amount === 0n || shut || tx.status === "pending"}
                    >
                      {shut
                        ? "Opens at the full moon"
                        : amount === 0n
                        ? "Enter an amount"
                        : st && st.allowance < amount
                          ? `Approve ${r.symbol}`
                          : "Redeem"}
                    </button>
                  )}
                </form>
              )}
            </section>
          );
        })}
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
      </main>
    </Shell>
  );
}
