import { activeInterface } from "./names";
import { unit } from "./unit";
import {
  collateral,
  gemUnit,
  fmtGem,
  asImd,
  perImd,
  shareAbi,
  vaultShareAbi,
} from "./collateral";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isAddress } from "viem";
import { WorkChart, SupplyChart, Sparkline, type ChartData } from "./Charts";
import { Ticker } from "./motion";
import { type Runtime } from "./config";
import { type Snapshot, type Question, read, feedsReady } from "./state";
import {
  Action,
  ActionForm,
  Row,
  AddressLink,
  Choice,
  Col,
  Info,
  Select,
  BalanceHint,
  FadingError,
  type Actions,
} from "./actions";
import type { Failure } from "./explain";
import {
  amount,
  address,
  age,
  fmt,
  percent,
  ratio,
  message,
  exact,
  WAD,
  liquidationPrice,
  cushion,
  maxDebt,
  requiredCollateral,
  nextStep,
  ratioPercent,
  BORROW_BUFFER,
  BORROW_WARN,
} from "./math";
import { useEns, ensName, displayName } from "./ens";
import { PriceStatus } from "./PriceStatus";
import { describePending, utc, countdown, CHANGE_KINDS } from "./governance";
import { LoopWindow, loopAvailable } from "./Loop";
const amt = (name: string) => ({ name, kind: "amount" as const });
const addr = (name: string) => ({ name, kind: "address" as const });
const num = (name: string) => ({ name, kind: "uint" as const });
// A debt ceiling set to the uint256 range is "none", not a 78-digit number.
const ceilingText = (v?: bigint) =>
  v === undefined
    ? "—"
    : v >= 10n ** 36n
      ? "No ceiling"
      : `${fmt(v)} ${unit()}`;

// The debt ceiling as a state the borrower can act on: reached, nearly reached (under 1% left), or open.
// A ceiling set to the uint256 range is "none" and never reached.
export function ceilingState(v: Record<string, any>) {
  const line = v.line as bigint | undefined;
  const total = v.totalDebt as bigint | undefined;
  if (line === undefined || total === undefined || line >= 10n ** 36n) return undefined;
  const left = line > total ? line - total : 0n;
  return { line, total, left, reached: left === 0n, near: left > 0n && left * 100n < line };
}

// Why the ceiling stops borrowing, and what still works, in words a borrower can act on.
export function CeilingNotice({ v }: { v: Record<string, any> }) {
  const c = ceilingState(v);
  if (!c || (!c.reached && !c.near)) return null;
  const wait = v.TIMELOCK !== undefined ? countdown(v.TIMELOCK as bigint) : "48h";
  return c.reached ? (
    <p className="notice notice-warn" role="status">
      <strong>The borrowing cap is reached.</strong> {fmt(c.total)} of the {fmt(c.line)} {unit()} the vault may
      lend is already borrowed, so no new {unit()} can be borrowed until governance raises the cap. Raising it
      takes a public proposal and a {wait} waiting period before it applies. Everything else still works:
      depositing, withdrawing spare collateral, repaying and redeeming. Room opens again whenever borrowers repay.
    </p>
  ) : (
    <p className="notice" role="status">
      <strong>The borrowing cap is nearly reached.</strong> {fmt(c.left)} {unit()} of the {fmt(c.line)} cap is
      left to borrow. Once it is gone, no new {unit()} can be borrowed until borrowers repay or governance raises
      the cap.
    </p>
  );
}

// A marked position, explained to its borrower: what the mark means, when it can be liquidated, what a
// liquidation takes and what stops it. The figures are the vault's own (CHOP 20%), not estimates.
function MarkNotice({ s, actions, now }: { s?: Snapshot; actions: Actions; now: bigint }) {
  const v = s?.v || {};
  const mark = v.liquidationMarks as readonly [bigint, bigint, boolean, string] | undefined;
  if (!mark || !mark[2] || !v.debtOf) return null;
  const ends = mark[0] + mark[1];
  const open = now >= ends;
  const closes = ends + ((v.tail as bigint | undefined) ?? 0n);
  const when = new Date(Number(ends) * 1000).toLocaleString();
  return (
    <div className="notice notice-warn" role="alert">
      <p>
        <strong>
          {open
            ? "Your position can be liquidated now."
            : `Your position has been marked for liquidation. It can be liquidated in ${countdown(ends - now)} (${when}).`}
        </strong>
      </p>
      <p>
        At the price the oracle reports, your collateral is worth less than minCR {ratio(v.mat)} of your debt.
        Someone noticed and marked it, which starts a grace period. When the grace period ends, anyone can
        repay some or all of your debt and take your collateral in return: for every {unit()} they repay they take
        $1.20 of collateral, valued at that same oracle price.
      </p>
      <p>
        <strong>If the oracle price is lower than the real market price, you lose more.</strong> The oracle reads
        one IMD pool, and someone with enough money can push that pool down and try to hold it there, against
        traders who buy it cheap and sell on IMD's other markets. If the pool is
        held 20% below the real price, each {unit()} repaid takes about $1.50 of your collateral at the real
        price; held 36% down, about $1.88. The protocol cannot tell a held-down pool from a real fall.
      </p>
      <p>
        <strong>To stop it:</strong> deposit collateral or repay debt until your ratio is back above{" "}
        {ratio(v.mat)}. Doing that clears the mark when the price feeds are fresh. If you are already back above
        it because the price recovered, clear the mark yourself below.
        {open && mark[1] !== undefined && closes > now
          ? ` If nobody liquidates it by ${new Date(Number(closes) * 1000).toLocaleString()}, the mark expires and someone must mark it again, which starts a new grace period.`
          : ""}
      </p>
      {s && v.collateralRatio !== undefined && v.mat !== undefined && v.collateralRatio >= v.mat && (
        <Action
          id="clear-own-mark"
          label="Review clear my mark"
          actions={actions}
          disabled={!feedsReady(s)}
          reason="Fresh, agreeing price feeds are required."
          request={() => ({
            target: s.targets.ParameterizedVault,
            fn: "heel",
            args: [actions.account!],
            summary: "Clear the liquidation mark on your position: you are back above minCR.",
          })}
        />
      )}
    </div>
  );
}

export function Position({
  r,
  s,
  actions,
}: {
  r: Runtime;
  s?: Snapshot;
  actions: Actions;
}) {
  const [input, setInput] = useState("");
  const [act, setAct] = useState("deposit");
  const [looping, setLooping] = useState(false);
  const g = collateral();
  // With share collateral, a deposit can be IMD (the vault stakes it) or sIMD itself.
  const [token, setToken] = useState<"imd" | "gem">("imd");
  const viaImd = g.share && token === "imd";
  const v = s?.v || {};
  const depositUnit = viaImd ? g.underlyingSymbol : gemUnit();
  const depositDecimals = viaImd ? g.underlyingDecimals : g.decimals;
  let n = 0n;
  try {
    n = amount(input, depositDecimals);
  } catch {
    /* Validation on action. */
  }
  const allowance = viaImd ? v.underlyingAllowance : v.allowance;
  const balance = viaImd ? v.underlyingBalance : v.gemBalance;
  const needsApproval = n > 0n && (allowance === undefined || allowance < n);
  const t = s?.targets;
  const fresh = feedsReady(s);
  // The vault's own collateral price: USD per 1e18 raw collateral units.
  const price = s?.feeds.Collateral?.value;
  const imdUsd = s?.feeds.USD?.value;
  const held = v.positions?.[0] as bigint | undefined;
  const debt = v.debtOf as bigint | undefined;
  const sized = held !== undefined && debt !== undefined && !!v.mat && !!price;
  const liq = sized ? perImd(liquidationPrice(held, debt, v.mat)) : undefined;
  // What the terminal offers stops BORROW_BUFFER points above mat (math.ts); the vault itself allows mat.
  const most = sized ? maxDebt(held, v.mat + BORROW_BUFFER, price) : undefined;
  const keep = sized ? requiredCollateral(debt, v.mat + BORROW_BUFFER, price) : undefined;
  const worth = g.share ? asImd(held) : undefined;
  const connected = !!actions.account;
  const stable = { connected, symbol: unit(), decimals: Number(v.compDecimals ?? 18) };
  const cap = ceilingState(v);
  const byRatio = most !== undefined && debt !== undefined ? (most > debt ? most - debt : 0n) : undefined;
  // What a draw may add: the ratio's room, and no more than the vault's ceiling has left.
  const room = byRatio !== undefined && cap ? (byRatio < cap.left ? byRatio : cap.left) : byRatio;
  const free = keep !== undefined && held !== undefined ? (held > keep ? held - keep : 0n) : undefined;
  return (
    <>
      <Col label="Your position">
        <div className="hero-stat">
          <span>Collateral ratio</span>
          <strong>
            <Ticker text={ratio(v.collateralRatio)} />
          </strong>
          <small>
            minCR <Ticker text={ratio(v.mat)} />
          </small>
        </div>
        <MarkNotice s={s} actions={actions} now={s?.timestamp ?? BigInt(Math.floor(Date.now() / 1000))} />
        <Row label="Collateral">
          {fmtGem(held)} {gemUnit()}
          {worth !== undefined && ` ≈ ${fmt(worth)} ${g.underlyingSymbol}`}
        </Row>
        <Row label="Accrued debt">
          {fmt(debt)} {unit()}
        </Row>
        <Row label="Unpaid stability fee">
          {fmt(v.stabilityFeeOf)} {unit()}
        </Row>
        <Row label="Liquidation price">
          {!sized
            ? "—"
            : debt === 0n || held === 0n
              ? "No debt"
              : liq === undefined
                ? "—"
                : `$${fmt(liq)} / ${g.underlyingSymbol}`}
        </Row>
        {liq !== undefined && (
          <p className="micro">
            {g.underlyingSymbol} is ${fmt(imdUsd)} now, {cushion(imdUsd, liq)}.
          </p>
        )}
        <Row label="Can still borrow">
          {most === undefined || debt === undefined
            ? "—"
            : `${fmt(most > debt ? most - debt : 0n)} ${unit()}`}
        </Row>
        <Row label="Can withdraw">
          {keep === undefined || held === undefined
            ? "—"
            : `${fmtGem(held > keep ? held - keep : 0n)} ${gemUnit()}`}
        </Row>
        {most !== undefined && (
          <p className="micro">
            Both stop at {String(v.mat + BORROW_BUFFER)}%. The vault allows down to {String(v.mat)}%, but a
            loan there is liquidatable within a block or two: the stability fee alone tips it under.
          </p>
        )}
        <Row label="Wallet">
          {g.share && `${fmt(v.underlyingBalance)} ${g.underlyingSymbol} / `}
          {fmtGem(v.gemBalance)} {gemUnit()} / {fmt(v.compBalance)} {unit()}
        </Row>
        <p className="micro">
          {unit()} debt is USD-denominated. {g.underlyingSymbol} / USD:{" "}
          {s?.feeds.USD && !s.feeds.USD.stale
            ? `$${fmt(s.feeds.USD.value)}`
            : "unavailable"}
          {g.share &&
            g.rate > 0n &&
            `; 1 ${gemUnit()} = ${fmt(asImd(10n ** BigInt(g.decimals)))} ${g.underlyingSymbol}`}
          .
        </p>
      </Col>
      <Col label="Act">
        <PriceStatus r={r} s={s} now={s?.timestamp ?? 0n} actions={actions} where="position" slim />
        <Choice
          label="Position action"
          value={act}
          onChange={setAct}
          options={[
            ["deposit", "Deposit"],
            ["borrow", "Borrow"],
            ["repay", "Repay"],
            ["withdraw", "Withdraw"],
            g.share ? ["unstake", "Unstake"] : ["faucet", "Test IMD"],
          ]}
        />
        {loopAvailable(r, s) && (
          <button type="button" className="loop-open" onClick={() => setLooping(true)}>
            Leverage loop ↗
          </button>
        )}
        {looping && <LoopWindow r={r} s={s} actions={actions} onClose={() => setLooping(false)} />}
        {act === "deposit" && (
          <>
            {g.share && (
              <Choice
                label="Deposit token"
                value={token}
                onChange={(x) => setToken(x as "imd" | "gem")}
                options={[
                  ["imd", g.underlyingSymbol],
                  ["gem", gemUnit()],
                ]}
              />
            )}
            <div className="field">
              <label>
                Deposit {depositUnit}
                <input
                  name="deposit-amount"
                  inputMode="decimal"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
              </label>
              <BalanceHint
                b={{ connected, amount: balance, symbol: depositUnit, decimals: depositDecimals }}
                onUse={setInput}
              />
            </div>
            <Action
              id={needsApproval ? "approve" : "deposit"}
              label={
                needsApproval ? `Approve ${depositUnit}` : "Review deposit"
              }
              actions={actions}
              request={() => {
                const n = amount(input, depositDecimals);
                if (balance !== undefined && n > balance)
                  throw Error(`Deposit exceeds the ${depositUnit} balance.`);
                if (!t) throw Error("Wait for contract verification.");
                if (needsApproval)
                  return {
                    target: viaImd ? t.underlying : t.gem,
                    fn: "approve",
                    args: [t.ParameterizedVault.address, n],
                    summary: `Approve exactly ${exact(n, depositDecimals)} ${depositUnit} for the vault. Deposit is a separate transaction.`,
                  };
                return viaImd
                  ? {
                      target: {
                        address: t.ParameterizedVault.address,
                        abi: vaultShareAbi,
                      },
                      fn: "lockIMD",
                      args: [n],
                      summary: `Deposit ${exact(n, depositDecimals)} ${depositUnit}. The vault stakes it and credits the ${gemUnit()} it receives as collateral.`,
                    }
                  : {
                      target: t.ParameterizedVault,
                      fn: "lock",
                      args: [n],
                      summary: `Deposit ${exact(n, depositDecimals)} ${depositUnit} as collateral.`,
                    };
              }}
            />
            <p className="micro">
              Approval and deposit are two transactions. The approval is for
              exactly this amount.
              {viaImd &&
                ` Your collateral is held as ${gemUnit()}; withdrawals pay ${gemUnit()}.`}
            </p>
          </>
        )}
        {act === "borrow" && <CeilingNotice v={v} />}
        {act === "borrow" && (
          <ActionForm
            id="borrow"
            label="Review borrow"
            actions={actions}
            target={t?.ParameterizedVault}
            fn="draw"
            fields={[{ ...amt(`Borrow ${unit()}`), balance: { ...stable, amount: room, label: "Available" } }]}
            summary={`Add ${unit()} debt to your position.`}
            warn={([a]) => {
              if (!sized || typeof a !== "bigint") return;
              const after = ratioPercent(held, debt + a, price);
              return after !== undefined && after < v.mat + BORROW_WARN
                ? `This leaves your position at ${after}%, ${after < v.mat ? "under" : after === v.mat ? "exactly at" : "just above"} the ${v.mat}% minimum. ` +
                    `The stability fee adds debt every block, so ${after < v.mat ? "the vault will refuse it" : "it can be marked for liquidation within minutes"}; ` +
                    `a liquidation pays the liquidator a bonus out of your collateral. Borrow less or deposit more to stay above ${String(v.mat + BORROW_BUFFER)}%.`
                : undefined;
            }}
            disabled={!fresh || !!cap?.reached}
            reason={
              cap?.reached
                ? "The borrowing cap is reached: no new debt until borrowers repay or governance raises it."
                : "Fresh, agreeing price feeds are required."
            }
          />
        )}
        {act === "repay" && (
          <ActionForm
            id="repay"
            label="Review repayment"
            actions={actions}
            target={t?.ParameterizedVault}
            fn="wipe"
            fields={[{ ...amt(`Repay ${unit()}`), balance: { ...stable, amount: v.compBalance } }]}
            summary={`Burn ${unit()} to repay fees first, then principal. No approval required.`}
          />
        )}
        {act === "withdraw" && (
          <ActionForm
            id="withdraw"
            label="Review withdrawal"
            actions={actions}
            target={t?.ParameterizedVault}
            fn="free"
            fields={[
              {
                ...amt(`Withdraw ${gemUnit()}`),
                decimals: g.decimals,
                balance: { connected, amount: free, symbol: gemUnit(), decimals: g.decimals, label: "Available" },
              },
            ]}
            summary={`Remove ${gemUnit()} collateral if the remaining position meets minCR.`}
            warn={([a]) => {
              if (!sized || !debt || typeof a !== "bigint") return;
              const after = ratioPercent(held > a ? held - a : 0n, debt, price);
              return after !== undefined && after < v.mat + BORROW_WARN
                ? `This leaves your position at ${after}%, ${after < v.mat ? "under" : after === v.mat ? "exactly at" : "just above"} the ${v.mat}% minimum. ` +
                    `The stability fee adds debt every block, so ${after < v.mat ? "the vault will refuse it" : "it can be marked for liquidation within minutes"}; ` +
                    `a liquidation pays the liquidator a bonus out of your collateral. Withdraw less or repay first to stay above ${String(v.mat + BORROW_BUFFER)}%.`
                : undefined;
            }}
            disabled={!fresh && v.debtOf !== 0n}
            reason="An indebted position needs fresh feeds to withdraw."
          />
        )}
        {act === "unstake" && g.share && (
          <>
            <ActionForm
              id="unstake"
              label="Review unstake"
              actions={actions}
              target={t && { address: t.gem.address, abi: shareAbi }}
              fn="redeem"
              fields={[
                {
                  ...amt(`Unstake ${gemUnit()}`),
                  decimals: g.decimals,
                  balance: { connected, amount: v.gemBalance, symbol: gemUnit(), decimals: g.decimals },
                },
              ]}
              mapArgs={(a) => [a[0], actions.account, actions.account]}
              summary={`Unstake ${gemUnit()} in the staking vault and receive ${g.underlyingSymbol} in this wallet.`}
            />
            <p className="micro">
              Withdrawals, liquidations and redemptions pay {gemUnit()}.
              Unstaking is a call to the staking vault, not this protocol.{" "}
              {gemUnit()} received in a block cannot be unstaked in that same
              block.
            </p>
          </>
        )}
        {act === "faucet" && !g.share && (
          <ActionForm
            id="faucet"
            label="Review mint IMD"
            actions={actions}
            target={t?.gem}
            fn="mint"
            fields={[amt("Test IMD")]}
            mapArgs={(a) => [actions.account, ...a]}
            summary="Mint test IMD to this wallet. This deployment uses MockIMD."
            disabled={
              actions.account?.toLowerCase() !== v.imdDeployer?.toLowerCase()
            }
            reason="Only the collateral faucet operator can mint test IMD."
          />
        )}
        <AddressLink
          value={t?.stablecoin.address}
          explorer={r.config.network.explorer}
          label={unit()}
        />
      </Col>
    </>
  );
}
export function Work({
  r,
  s,
  actions,
  now,
  charts,
}: {
  r: Runtime;
  s?: Snapshot;
  actions: Actions;
  now: bigint;
  charts: ChartData;
}) {
  const [act, setAct] = useState("mint");
  const w = s?.work;
  const v = s?.v || {};
  const attested = w?.mode === "attested";
  const faucet = w?.mode === "faucet";
  // The swarm-wide oracle credits any agent's controller from the swarm's daily tally.
  const swarm = w?.mode === "swarm";
  const remaining = attested
    ? w.earnedRights > w.consumedRights
      ? BigInt(w.earnedRights) - BigInt(w.consumedRights)
      : 0n
    : undefined;
  return (
    <>
      <Col label="Swarm tally">
        <div className="hero-stat">
          <span>
            {swarm ? "Work rights you can use" : "Attested cumulative tasks"}
          </span>
          <strong>
            <Ticker
              text={
                swarm
                  ? `${fmt(v.rights)} ${unit()}`
                  : attested
                    ? w.attestedTasks.toLocaleString("en-US")
                    : "—"
              }
            />
          </strong>
          <small>
            {attested || swarm
              ? `Tally ${w.isStale ? "stale" : "fresh"} · ${age(w.latestValue?.[1], now)}`
              : faucet
                ? "Faucet mode"
                : "Awaiting linked oracle"}
          </small>
        </div>
        {attested && (
          <Sparkline
            feed={charts.feeds.oracle}
            live={
              w
                ? {
                    value: w.latestValue[0],
                    updated: w.latestValue[1],
                    stale: w.isStale,
                    maxAge: w.maxAge,
                  }
                : undefined
            }
            now={now}
            label="Work tally"
          />
        )}
        {swarm && (
          <>
            <Row label="Credited to this wallet">
              {fmt(w.creditedRights)} {unit()}
            </Row>
            <Row label="Already used">
              {fmt(w.consumedRights)} {unit()}
            </Row>
            <Row label="Tally freshness limit">{w.maxAge.toString()}s</Row>
            <p className="micro">
              Rights are credited when an agent's controller claims its tasks
              from the swarm's daily tally. Claiming is not in the terminal yet.
            </p>
          </>
        )}
        {faucet && (
          <p className="notice">
            This vault uses MockWorkOracle. Credits are granted by its
            operator; no task count is attested.
          </p>
        )}
        {attested && (
          <>
            <Row label="Credited high-water mark">
              {w.creditedTasks.toLocaleString("en-US")} tasks
            </Row>
            <Row label="Freshness limit">{w.maxAge.toString()}s</Row>
            <Row label="Agent">{w.AGENT_ID.toString()}</Row>
            <AddressLink
              value={w.CLAIMANT}
              explorer={r.config.network.explorer}
              label="Claimant"
            />
          </>
        )}
        <p className="micro">
          The count is the swarm’s published tally, attested by a panel. It is
          not an on-chain proof that the work happened.
        </p>
      </Col>
      <Col label="Rights">
        <WorkChart s={s} />
        <Row label={`${unit()} per task`}>
          {fmt(attested ? w.wage : v.wage)}
        </Row>
        <Row label="Rights earned / consumed">
          {fmt(attested ? w.earnedRights : undefined)} /{" "}
          {fmt(attested ? w.consumedRights : undefined)}
        </Row>
        <Row label="Rights remaining">
          {fmt(remaining)} {unit()}
        </Row>
        <Row label="This wallet can claim">
          {fmt(v.rights)} {unit()}
        </Row>
        {faucet && (
          <Choice
            label="Work action"
            value={act}
            onChange={setAct}
            options={[
              ["mint", "Mint"],
              ["grant", "Grant rights"],
            ]}
          />
        )}
        {(!faucet || act === "mint") && (
          <ActionForm
            id="mint-work"
            label="Review work mint"
            actions={actions}
            target={s?.targets.ParameterizedVault}
            fn="earn"
            fields={[
              {
                ...amt(`Mint earned ${unit()}`),
                balance: {
                  connected: !!actions.account,
                  amount: v.rights,
                  symbol: unit(),
                  decimals: 18,
                  label: "Available",
                },
              },
            ]}
            summary="Consume work rights permanently. Redemption does not restore them."
            disabled={!feedsReady(s) || !v.rights || w?.mode === "unknown"}
            reason="Fresh feeds, available rights and backing headroom are required."
          />
        )}
        {faucet && act === "grant" && (
          <ActionForm
            id="grant-rights"
            label="Review grant rights"
            actions={actions}
            target={s?.targets.oracle}
            fn="grantRights"
            fields={[addr("Recipient"), amt(`Rights in ${unit()}`)]}
            summary="Grant test credits; this does not attest work."
            disabled={
              actions.account?.toLowerCase() !== w.deployer?.toLowerCase()
            }
            reason="Only the faucet operator can grant rights."
          />
        )}
      </Col>
    </>
  );
}
const feedNames: Record<string, [string, string]> = {
  PriceFeed: [
    "IMD / ETH primary",
    "Median IMD price in ETH over the attested window. Liquidation, borrowing and redemption read it, through the USD feed.",
  ],
  NhiFeed: [
    "Network health",
    "Swarm health index, 0 to 1. It sets minCR (200% at or below 0.60, 170% at or above 0.85) and the liquidation grace period.",
  ],
  SpotFeed: [
    "IMD / ETH spot",
    "Price at the last block of its window. It only guards the primary: price actions pause when the two disagree beyond the allowed divergence.",
  ],
  USD: [
    "IMD / USD",
    "Primary feed × Chainlink ETH / USD, computed on chain. It emits no attestations of its own and is stale when either leg is.",
  ],
};
/** A feed's lifetime: "1h", "24h", "45m". */
function lifetime(seconds: bigint) {
  return seconds % 3600n === 0n ? `${seconds / 3600n}h` : `${seconds / 60n}m`;
}
export function Oracle({
  r,
  s,
  now,
  charts,
  actions,
}: {
  r: Runtime;
  s?: Snapshot;
  now: bigint;
  charts: ChartData;
  actions: Actions;
}) {
  const [open, setOpen] = useState<string>();
  const f = s?.feeds || {};
  const primary = f.PriceFeed?.value,
    spot = f.SpotFeed?.value;
  const divergence =
    primary && spot !== undefined
      ? ((primary > spot ? primary - spot : spot - primary) * 10000n) / primary
      : undefined;
  const allowed = s?.v.skew as bigint | undefined;
  const stale = !!(f.PriceFeed?.stale || f.SpotFeed?.stale);
  const contract = (n: string) =>
    r.config.contracts.find((c) => c.name === n)?.address ??
    (n === "USD" ? s?.targets.usdPriceFeed.address : undefined);
  return (
    <>
      <PriceStatus r={r} s={s} now={now} actions={actions} where="oracle" />
      <div className="section-label">Feeds</div>
      <ul className="feed-list">
        {["NhiFeed", "PriceFeed", "SpotFeed", "USD"].map((n) => {
          const expanded = open === n;
          return (
            <li key={n} className={expanded ? "is-open" : undefined}>
              <button
                type="button"
                className="feed-toggle"
                aria-expanded={expanded}
                aria-controls={`feed-${n}`}
                onClick={() => setOpen(expanded ? undefined : n)}
              >
                <span className="feed-name">
                  <span
                    className={`feed-state ${!f[n] ? "" : f[n].stale ? "is-stale" : "is-fresh"}`}
                    aria-hidden="true"
                  />
                  {feedNames[n][0]}
                </span>
                <b>{fmt(f[n]?.value, 18, 8)}</b>
                <span className="feed-caret" aria-hidden="true">
                  {expanded ? "−" : "+"}
                </span>
              </button>
              {expanded && (
                <div className="feed-detail" id={`feed-${n}`}>
                  <div>
                    <Row label="About" info={feedNames[n][1]}>
                      {n === "USD" ? "Derived" : "Attested"}
                    </Row>
                    <Row label="Updated / lives">
                      {!f[n] ? (
                        "—"
                      ) : (
                        <span
                          className={f[n].stale ? "danger-text" : undefined}
                        >
                          {f[n].stale ? "Stale · " : ""}
                          {age(f[n].updated, now)} / {lifetime(f[n].maxAge)}
                        </span>
                      )}
                    </Row>
                    {n !== "USD" && <QuestionState q={s?.questions[n]} />}
                    <AddressLink
                      value={contract(n)}
                      explorer={r.config.network.explorer}
                      label={n === "USD" ? "UsdPriceFeed" : n}
                    />
                  </div>
                  {n !== "USD" && (
                    <Sparkline
                      feed={charts.feeds[n]}
                      live={f[n]}
                      now={now}
                      label={n}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
export function Keeper({
  r,
  s,
  actions,
  now,
  target,
}: {
  r: Runtime;
  s?: Snapshot;
  actions: Actions;
  now: bigint;
  /** A borrower opened from the loan book; seq changes on every open, even of the same owner. */
  target?: { owner: string; seq: number };
}) {
  const [owner, setOwner] = useState("");
  const [position, setPosition] = useState<any>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("inspect");
  useEns([position?.owner]);
  const requested = useRef("");
  const inspect = async (who: string) => {
    requested.current = who.trim().toLowerCase();
    setLoading(true);
    setError("");
    setPosition(undefined);
    try {
      if (!s) throw Error("Wait for state to load.");
      const a = address(who);
      const [cr, debt, mark, badDebt, held] = await Promise.all(
        [
          "collateralRatio",
          "debtOf",
          "liquidationMarks",
          "badDebtOf",
          "positions",
        ].map((fn) => read(r, s.targets.ParameterizedVault, fn, [a])),
      );
      if (requested.current !== a.toLowerCase()) return;
      setPosition({ cr, debt, mark, badDebt, owner: a, collateral: held[0] });
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  };
  // A pasted or typed address is inspected as soon as it is complete, as a loan-book click is.
  useEffect(() => {
    const a = owner.trim();
    if (!isAddress(a) || requested.current === a.toLowerCase()) return;
    const t = setTimeout(() => void inspect(a), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  const inspected =
    !!position && position.owner.toLowerCase() === owner.trim().toLowerCase();
  useEffect(() => {
    if (!target) return;
    setOwner(target.owner);
    setMode("inspect");
    void inspect(target.owner);
    // Only a new open re-inspects; a snapshot refresh must not reset what the keeper typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.seq]);
  const borrower = (f: Failure) => {
    if (!position || !s) return undefined;
    const graceEnds = position.mark[0] + position.mark[1];
    if (f.name === "HealthyPosition")
      return `${position.owner} sits at ${ratio(position.cr)}, at or above minCR ${ratio(s.v.mat)}. It cannot be marked or liquidated until it falls below.`;
    if (f.name === "GracePeriodNotElapsed")
      return `The grace period ends in ${graceEnds > now ? graceEnds - now : 0n}s, at ${new Date(Number(graceEnds) * 1000).toISOString()}.`;
    if (f.name === "MarkExpired")
      return `The mark's execution window closed at ${new Date(Number(graceEnds + (s.v.tail ?? 0n)) * 1000).toISOString()}. Mark the position again.`;
    if (f.name === "ExcessRepayment")
      return `${position.owner} owes ${fmt(position.debt)} ${unit()} including fees; repay no more than that.`;
    return undefined;
  };
  const liq =
    position && s?.v.mat
      ? perImd(liquidationPrice(position.collateral, position.debt, s.v.mat))
      : undefined;
  const summary = position && (
    <>
      <p className="keeper-owner">
        <b className={ensName(position.owner) ? "ens-name" : undefined}>
          {displayName(position.owner)}
        </b>{" "}
        · {position.owner}
      </p>
      <div className="row-grid">
        <Row label="Collateral ratio">{ratio(position.cr)}</Row>
        <Row label="Collateral">
          {fmtGem(position.collateral)} {gemUnit()}
        </Row>
        <Row label="Accrued debt">
          {fmt(position.debt)} {unit()}
        </Row>
        <Row label="Bad debt estimate">
          {fmt(position.badDebt)} {unit()}
        </Row>
        <Row label="Liquidation price">
          {liq ? `$${fmt(liq)} / ${collateral().underlyingSymbol}` : "—"}
        </Row>
        <Row label="Cushion">
          {liq ? cushion(s?.feeds.USD?.value, liq) : "—"}
        </Row>
        <Row
          label="Mark"
          info="A mark clears itself when the borrower next deposits, repays, borrows or withdraws. A recovery caused only by the price leaves it in place until anyone clears it; it cannot be used to liquidate a healthy position."
        >
          {position.mark[2] && position.cr >= (s?.v.mat ?? 0n)
            ? "Recovered · clearable"
            : position.mark[2]
              ? now < position.mark[0] + position.mark[1]
                ? `Grace ${(position.mark[0] + position.mark[1] - now).toString()}s`
                : "Active · liquidatable"
              : "None"}
        </Row>
      </div>
    </>
  );
  // Inspect and Act each take the whole desk; the mode switch is the only thing they share.
  return (
    <div className="desk-span keeper">
      <Choice
        label="Keeper mode"
        value={mode}
        onChange={setMode}
        options={[
          ["inspect", "Inspect"],
          ["act", "Act"],
        ]}
      />
      {mode === "inspect" ? (
        <>
          <form
            className="keeper-search"
            onSubmit={(e) => {
              e.preventDefault();
              // Once the position is on screen, the same button carries it to Act.
              if (inspected) setMode("act");
              else void inspect(owner);
            }}
          >
            <label htmlFor="keeper-borrower">Borrower address</label>
            <div className="inline-field">
              <input
                id="keeper-borrower"
                required
                value={owner}
                onChange={(e) => {
                  setOwner(e.target.value);
                  setPosition(undefined);
                  requested.current = "";
                }}
                spellCheck={false}
                placeholder="0x… or pick one in the loan book"
              />
              <button
                type="submit"
                className={inspected ? "primary" : undefined}
                disabled={!s || loading}
              >
                {loading
                  ? "Inspecting…"
                  : inspected
                    ? nextStep(
                        position,
                        s?.v.mat ?? 0n,
                        now,
                        s?.v.tail ?? 0n,
                        displayName(position.owner),
                      )
                    : "Inspect position"}
              </button>
            </div>
          </form>
          <p role="status" className="micro">
            {error ? (
              <FadingError text={error} onDone={() => setError("")} role="none" />
            ) : (
              // QA-05: success is announced, not shown twice; the summary below already shows it.
              <span className="sr-only">
                {inspected && position && !loading
                  ? `Inspected ${displayName(position.owner)}: ${ratio(position.cr)} collateral ratio. ${nextStep(position, s?.v.mat ?? 0n, now, s?.v.tail ?? 0n, displayName(position.owner)).replace(" →", "")} is next.`
                  : ""}
              </span>
            )}
          </p>
          {summary}
        </>
      ) : (
        <>
          {summary || <p className="micro">Inspect a borrower first.</p>}
          <div className="keeper-actions">
            <div>
              <ActionForm
                id="bite"
                label="Review liquidation"
                actions={actions}
                target={s?.targets.ParameterizedVault}
                fn="bite"
                fields={[
                  {
                    ...amt(`Repay borrower ${unit()}`),
                    // At most what this borrower owes: the hint offers the smaller of that and the wallet.
                    balance: {
                      connected: !!actions.account,
                      amount:
                        position?.debt !== undefined && s?.v.compBalance !== undefined
                          ? (position.debt < s.v.compBalance ? position.debt : s.v.compBalance)
                          : s?.v.compBalance,
                      symbol: unit(),
                      decimals: Number(s?.v.compDecimals ?? 18),
                    },
                    max:
                      position?.debt !== undefined
                        ? {
                            value: position.debt,
                            message: `This borrower owes ${exact(position.debt)} ${unit()}. You can repay at most that.`,
                          }
                        : undefined,
                  },
                ]}
                mapArgs={(a) => [address(owner), ...a]}
                summary={`Burn your ${unit()} to cancel borrower debt and receive ${gemUnit()}, including the liquidation bonus after protocol and marker shares.`}
                explain={borrower}
                disabled={
                  !feedsReady(s) ||
                  !position?.mark[2] ||
                  now < position.mark[0] + position.mark[1] ||
                  now > position.mark[0] + position.mark[1] + (s?.v.tail ?? 0n)
                }
                reason="An active mark, elapsed grace, open execution window and fresh feeds are required."
              />
            </div>
            <div>
              <div className="button-row">
                <Action
                  id="mark"
                  label="Review mark"
                  actions={actions}
                  disabled={
                    !feedsReady(s) || !position || position.cr >= s?.v.mat
                  }
                  reason="Inspect an unhealthy borrower with fresh feeds."
                  request={() => ({
                    target: s!.targets.ParameterizedVault,
                    fn: "bark",
                    args: [address(owner)],
                    summary: `Mark ${address(owner)} as underwater. The on-chain grace snapshot governs liquidation.`,
                    explain: borrower,
                  })}
                />
                <Action
                  id="clear-mark"
                  label="Review clear mark"
                  actions={actions}
                  disabled={!position?.mark[2]}
                  reason="Inspect a marked position."
                  request={() => ({
                    target: s!.targets.ParameterizedVault,
                    fn: "heel",
                    args: [address(owner)],
                    summary: `Clear the mark only if ${address(owner)} has recovered.`,
                    explain: (f) =>
                      f.name === "UnderwaterPosition" && position
                        ? `${position.owner} is still at ${ratio(position.cr)}, below minCR ${ratio(s?.v.mat)}. A mark clears only once the position recovers.`
                        : undefined,
                  })}
                />
              </div>
              <ActionForm
                id="mark-for"
                label="Review beneficiary mark"
                actions={actions}
                target={s?.targets.ParameterizedVault}
                fn="barkFor"
                fields={[addr("Marker beneficiary")]}
                mapArgs={(a) => [address(owner), ...a]}
                summary="Mark for another beneficiary of the marker reward."
                explain={borrower}
                disabled={!feedsReady(s) || !position}
                reason="Inspect a borrower and wait for fresh feeds."
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function Backing({ r, s }: { r: Runtime; s?: Snapshot }) {
  const v = s?.v || {};
  return (
    <>
      <div className="desk-col">
        <div className="hero-stat">
          <span>
            Backing per {unit()}
            <Info
              label={`Backing per ${unit()}`}
              text={`Reserve plus secured collateral, over ${unit()} supply, never above $1. A redemption pays the lesser of $1 and this figure, less the fee.`}
            />
          </span>
          <strong>
            <Ticker
              text={
                v.backingPerUnit === undefined
                  ? "Not reported"
                  : `$${fmt(v.backingPerUnit)}`
              }
            />
          </strong>
          <small>
            {v.backingPerUnit === undefined
              ? "—"
              : v.backingPerUnit < WAD
                ? "Cap binds"
                : "At par"}
          </small>
        </div>
        <SupplyChart s={s} />
        <AddressLink
          value={s?.targets.treasury.address}
          explorer={r.config.network.explorer}
          label="Treasury"
        />
      </div>
      <div className="desk-col">
        <Row
          label="Reserve value"
          info="Treasury reserve assets valued in USD through their listed price feeds."
        >
          ${fmt(v.reserveValue)}
        </Row>
        <Row
          label="Collateral-backed debt"
          info="Principal debt still standing behind collateral, net of recorded bad debt."
        >
          {fmt(v.backedDebt)} {unit()}
        </Row>
        <Row
          label="Secured collateral"
          info="Collateral that stood behind debt, counted up to that debt at minCR. Surplus and debt-free deposits are excluded."
        >
          {fmtGem(v.securedCollateral)} {gemUnit()}
        </Row>
        <Row label="Total principal debt">
          {fmt(v.totalDebt)} {unit()}
        </Row>
        <Row
          label="Recorded bad debt"
          info="Debt left after a liquidation exhausted a position's collateral."
        >
          {fmt(v.totalBadDebt)} {unit()}
        </Row>
        <Row label="Work minted">
          {fmt(v.totalEarned)} {unit()}
        </Row>
        <Row
          label="Non-principal burns"
          info={`Redemptions that retired ${unit()} without cancelling borrower principal.`}
        >
          {fmt(v.totalNonPrincipalRedeemed)} {unit()}
        </Row>
        <Row label="Work ratio">{percent(v.earnMat)}</Row>
        <Row
          label="Work ceiling"
          info="Reserve value + backed debt × work ratio. A repayment or redemption can lower it and pause new work issuance."
        >
          {fmt(v.earnLine)} {unit()}
        </Row>
        <Row label="Reserve assets">{v.reserveAssets?.length ?? "—"}</Row>
        {v.reserveAssets?.map((a: any) => (
          <AddressLink
            key={a}
            value={a}
            explorer={r.config.network.explorer}
            label="Reserve asset"
          />
        ))}
      </div>
    </>
  );
}
const operations = [
  ["spread", "Propose redemption spread"],
  ["work-ratio", "Propose work ratio"],
  ["per-task", "Propose pay per task"],
  ["economics", "Propose economics"],
  ["reserve-proposal", "Propose reserve asset"],
  ["cancel", "Cancel the pending proposal"],
  ["checkpoint", "Checkpoint the fee index"],
  ["sync", "Sync a reserve token"],
  ["treasury-withdraw", "Withdraw from Treasury"],
  ["report", "Reporter fallback"],
] as const;
export function Governance({
  r,
  s,
  actions,
  now,
}: {
  r: Runtime;
  s?: Snapshot;
  actions: Actions;
  now: bigint;
}) {
  const [op, setOp] = useState<string>("spread");
  const v = s?.v || {};
  const t = s?.targets.parameters;
  const isGov =
    !!actions.account &&
    actions.account.toLowerCase() === v.governor?.toLowerCase();
  const pending = v.pendingChange;
  const eta = pending?.[1] as bigint | undefined;
  const common = {
    actions,
    target: t,
    disabled: !isGov,
    reason: "Only the governor can propose or cancel changes.",
  };
  // The contract's Change enum has no "None" (nothing pending is eta 0), so the kind indexes the decoder's table.
  const kind = pending ? (CHANGE_KINDS[Number(pending[0])] ?? String(pending[0])) : "—";
  // Nothing pending: the block as it always was. Something pending: what it changes, current → proposed,
  // and exactly when anyone may apply it.
  const proposal = eta
    ? describePending(
        v.pending,
        {
          set: v.current,
          earnMat: v.earnMat,
          wage: v.wage,
          gap: v.gap,
          oracleBudget: v.gov_oracleBudget,
          redemptionDivisor: v.gov_redemptionDivisor,
          streamPayee: v.gov_streamPayee,
          streamPerDay: v.gov_streamPerDay,
          workOracle: v.gov_workOracle,
        },
        unit(),
      )
    : undefined;
  const applyForm = (
    <ActionForm
      id="apply"
      label="Review apply pending"
      actions={actions}
      target={t}
      fn="applyPending"
      summary="Apply the visible pending change after the timelock. Anyone may execute."
      disabled={!eta || now < eta}
      reason="A pending proposal must finish its timelock."
    />
  );
  // Something pending: the parameter rows show it inline (current → proposed), and one status row says
  // what it is and when it applies. The apply button appears once it can be used.
  const ready = !!eta && now >= eta;
  const changes = new Map(
    (proposal?.lines ?? []).filter((l) => l.changed || !l.from).map((l) => [l.label, l]),
  );
  const listed = ["Stability fee / year", "Debt ceiling", "Max divergence", "Redemption spread"];
  const shown = (label: string, current: ReactNode) => {
    const c = changes.get(label);
    if (!c) return current;
    return (
      <span className="gov-change">
        {c.from && (
          <>
            <span className="gov-from">{c.from}</span>
            <span aria-hidden="true"> → </span>
            <span className="sr-only"> proposed </span>
          </>
        )}
        <b>{c.to}</b>
      </span>
    );
  };
  const extraRows = [...changes.values()]
    .filter((l) => !listed.includes(l.label))
    .map((l) => (
      <Row key={l.label} label={l.label}>
        {shown(l.label, null)}
      </Row>
    ));
  const pendingBlock = eta ? (
    <>
      <Row
        label="Pending change"
        info={`Proposed by the governor and public for the governance delay. Anyone can apply it from ${utc(eta)}; until then the governor can cancel it.`}
      >
        <span className="gov-status">
          {proposal?.title ?? kind} · {ready ? "ready to apply" : `applies in ${countdown(eta - now)}`}
        </span>
      </Row>
      {ready && applyForm}
    </>
  ) : (
    <>
      <Row label="Pending change">{kind}</Row>
      <Row label="Execution">
        {eta
          ? now >= eta
            ? "Ready to apply"
            : `${eta - now}s remaining`
          : "No pending change"}
      </Row>
      {applyForm}
    </>
  );
  return (
    <>
      <Col label="Parameters">
        {isGov && !!eta && pendingBlock}
        <Row label="Stability fee / year">{shown("Stability fee / year", percent(v.duty))}</Row>
        <Row label="Debt ceiling">{shown("Debt ceiling", ceilingText(v.line))}</Row>
        <Row label="Governance delay">
          {v.TIMELOCK === undefined ? "—" : `${v.TIMELOCK / 3600n} hours`}
        </Row>
        <Row label="Max divergence">{shown("Max divergence", percent(v.skew))}</Row>
        <Row label="Redemption spread">
          {shown("Redemption spread", v.gap === undefined ? "—" : `${v.gap} ratio points`)}
        </Row>
        {extraRows}
        {isGov && !eta && pendingBlock}
        <AddressLink
          value={v.governor}
          explorer={r.config.network.explorer}
          label="Governor"
        />
        <AddressLink
          value={t?.address}
          explorer={r.config.network.explorer}
          label="Parameters"
        />
      </Col>
      {/* Operator controls render only for the connected governor; everyone else sees what is
          pending and may apply it once the timelock ends. */}
      {!isGov && <Col label="Pending">{pendingBlock}</Col>}
      {isGov && (
        <Col label="Operator">
          <Select
            id="gov-operation"
            label="Operation"
            value={op}
            onChange={setOp}
            // The reporter fallback was deleted before mainnet; only a legacy deployment has it.
            options={operations.filter(
              ([id]) => id !== "report" || activeInterface() === "legacy",
            )}
          />
          {op === "spread" && (
            <ActionForm
              {...common}
              id="spread"
              label="Review spread proposal"
              fn="proposeGap"
              fields={[num("Spread (25–100 ratio points)")]}
              summary="Set the spread above minCR after the governance delay."
            />
          )}
          {op === "work-ratio" && (
            <ActionForm
              {...common}
              id="work-ratio"
              label="Review work ratio proposal"
              fn="proposeEarnMat"
              fields={[num("Work ratio (0–2500 bps)")]}
              summary="Change the backing fraction available to work issuance."
            />
          )}
          {op === "per-task" && (
            <ActionForm
              {...common}
              id="per-task"
              label="Review pay per task"
              fn="proposeWage"
              fields={[{ name: `${unit()} per task`, kind: "amount0" }]}
              summary={`Change the ${unit()} earned per task after the delay.`}
            />
          )}
          {op === "economics" && (
            <ActionForm
              {...common}
              id="economics"
              label="Review economics proposal"
              fn="propose"
              fields={[
                { name: `Debt ceiling ${unit()}`, kind: "amount0" },
                num("Protocol bonus share bps"),
                num("Annual stability fee bps"),
                num("Max divergence bps"),
                num("Marker share bps"),
              ]}
              mapArgs={(a) => [
                {
                  line: a[0],
                  cut: a[1],
                  duty: a[2],
                  skew: a[3],
                  chip: a[4],
                },
              ]}
              summary="Replace all five economic parameters. Simulation enforces their bounds."
            />
          )}
          {op === "reserve-proposal" && (
            <ActionForm
              {...common}
              id="reserve-proposal"
              label="Review reserve proposal"
              fn="proposeReserveAsset"
              fields={[
                addr("Reserve token"),
                addr("USD price feed (zero to delist)"),
                num("Retained value (0–10000 bps)"),
              ]}
              summary={`List, reprice or delist a reserve asset after the delay. ${unit()} cannot be a reserve.`}
            />
          )}
          {op === "cancel" && (
            <ActionForm
              {...common}
              id="cancel"
              label="Review cancel proposal"
              fn="cancel"
              summary="Cancel the currently pending proposal."
            />
          )}
          {op === "checkpoint" && (
            <ActionForm
              id="checkpoint"
              label="Review checkpoint"
              actions={actions}
              target={s?.targets.ParameterizedVault}
              fn="drip"
              summary="Checkpoint the accrued stability fee index. Anyone may call it."
            />
          )}
          {op === "sync" && (
            <ActionForm
              id="sync"
              label="Review reserve sync"
              actions={actions}
              target={s?.targets.treasury}
              fn="sync"
              fields={[addr("Token to sync")]}
              summary="Record a token arrival in Treasury accounting. Anyone may call it."
            />
          )}
          {op === "treasury-withdraw" && (
            <ActionForm
              id="treasury-withdraw"
              label="Review reserve withdrawal"
              actions={actions}
              target={s?.targets.treasury}
              fn="withdraw"
              fields={[
                addr("Token"),
                addr("Destination"),
                num("Amount in token base units"),
              ]}
              summary="Withdraw reserve tokens to the specified destination. This reduces backing."
              disabled={
                actions.account?.toLowerCase() !== v.withdrawer?.toLowerCase()
              }
              reason="Only the Treasury withdrawer can withdraw."
            />
          )}
          {op === "report" && <Reporter r={r} s={s} actions={actions} />}
        </Col>
      )}
    </>
  );
}
function Reporter({
  r,
  s,
  actions,
}: {
  r: Runtime;
  s?: Snapshot;
  actions: Actions;
}) {
  const [selected, setSelected] = useState("PriceFeed");
  const [reporter, setReporter] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Select
        id="reporter-feed"
        label="Feed"
        value={selected}
        onChange={(v) => {
          setSelected(v);
          setReporter(false);
        }}
        options={[
          ["PriceFeed", "PriceFeed"],
          ["NhiFeed", "NhiFeed"],
          ["SpotFeed", "SpotFeed"],
        ]}
      />
      <button
        type="button"
        disabled={!actions.account || !s}
        onClick={async () => {
          setError("");
          try {
            setReporter(
              await read(r, s!.targets[selected], "isReporter", [
                actions.account,
              ]),
            );
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        Check reporter permission
      </button>
      <p className="micro" role="status">
        {error ? (
          <FadingError text={error} onDone={() => setError("")} role="none" />
        ) : reporter ? (
          "Reporter permission confirmed."
        ) : (
          "Reporter permission has not been confirmed."
        )}
      </p>
      <ActionForm
        id="report"
        label="Review feed report"
        actions={actions}
        target={s?.targets[selected]}
        fn="report"
        fields={[amt("Value (18-decimal units)")]}
        summary="Publish through the feed\u2019s reporter fallback."
        disabled={!reporter}
        reason="Only a configured reporter can report. Simulation rechecks permission."
      />
    </>
  );
}

function QuestionState({ q }: { q?: Question }) {
  const info =
    "The feed recomputes the question hash from the attested window and refuses an answer to any other question. Fingerprint = expectedQuestionHash(0, 0).";
  if (!q || q.kind === "unavailable")
    return (
      <Row
        label="Question"
        info="This feed predates question binding and cannot report which question it accepts."
      >
        {q ? "Not reported" : "—"}
      </Row>
    );
  if (q.kind === "unpinned")
    return (
      <Row
        label="Question"
        info="Any attestation from the attester is accepted, whatever question it answers."
      >
        <span className="danger-text">None pinned</span>
      </Row>
    );
  return (
    <>
      <Row label="Question" info={info}>
        <span className="healthy-text" title={q.fingerprint}>
          Pinned · {q.fingerprint.slice(0, 10)}…
        </span>
      </Row>
      <Row
        label="Last window"
        info="Closing block of the last accepted attestation window, on the chain the question reads (Ethereum mainnet). It only moves forward."
      >
        {q.lastToBlock ? q.lastToBlock.toLocaleString("en-US") : "—"}
      </Row>
    </>
  );
}
