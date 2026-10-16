import { useCallback, useEffect, useRef, useState } from "react";
import { DisconnectBox } from "./disconnect";
import {
  encodeFunctionData,
  formatUnits,
  type Address,
  type Hash,
  type EIP1193Provider,
} from "viem";
import { loadConfig, switchChain, wallet, type Runtime } from "./config";
import { snapshot, type Snapshot, feedsReady, shownReserve } from "./state";
import {
  Pane,
  Tabs,
  Select,
  type Actions,
  type Request,
  type Call,
  AddressLink,
  ConnectWallet,
} from "./actions";
import { Redemption } from "./Redemption";
import { unit } from "./unit";
import { Position, Work, Oracle, Keeper, Backing, Governance, ceilingState } from "./Panes";
import { message, fmt } from "./math";
import { explained } from "./explain";
import { onChain, onChainArgs } from "./names";
import { ThemeToggle } from "./theme";
import { SiteHeader, href } from "./site";
import { LoanBook, useCharts } from "./Charts";
import { Points, usePoints } from "./Points";
import { Ticker } from "./motion";
import { MarketCap, compact } from "./MarketCap";
/** The terminal remembers a disconnect, so a reload does not silently reconnect the wallet. */
const DISCONNECTED_KEY = "comp-terminal-disconnected";
function disconnectedHere(): boolean {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false;
  }
}
function rememberDisconnected(on: boolean) {
  try {
    if (on) localStorage.setItem(DISCONNECTED_KEY, "1");
    else localStorage.removeItem(DISCONNECTED_KEY);
  } catch {}
}

export default function App() {
  const [r, setRuntime] = useState<Runtime>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    loadConfig()
      .then((v) => {
        if (active) setRuntime(v);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (!r)
    return (
      <div className="boot">
        <h1>imdUSD / Terminal</h1>
        <ThemeToggle />
        <p role="status">
          {error || "Loading deployment and verifying ABI integrity…"}
        </p>
        {error && (
          <button onClick={() => setAttempt((x) => x + 1)}>
            Retry configuration
          </button>
        )}
      </div>
    );
  return <Terminal r={r} />;
}
function Terminal({ r }: { r: Runtime }) {
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [s, setSnapshot] = useState<Snapshot>();
  const [readError, setReadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState("");
  const [review, setReview] = useState<{
    id: string;
    request: Request;
    account: Address;
  }>();
  const [tx, setTx] = useState<{ status: string; hash?: Hash; error?: string }>(
    { status: "No transaction submitted." },
  );
  const [now, setNow] = useState(BigInt(Math.floor(Date.now() / 1000)));
  const [mobilePane, setMobilePane] = useState("loans");
  const [desk, setDesk] = useState("position");
  const [view, setView] = useState("loans");
  const [keeperTarget, setKeeperTarget] = useState<{
    owner: string;
    seq: number;
  }>();
  const openInKeeper = (owner: string) => {
    setKeeperTarget((t) => ({ owner, seq: (t?.seq ?? 0) + 1 }));
    setDesk("keeper");
    setMobilePane("keeper");
  };
  const charts = useCharts(r, s);
  const points = usePoints(r, s);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restore = useRef(false);
  const locked = useRef(false);
  const serial = useRef(0);
  const accountRef = useRef(account);
  accountRef.current = account;
  const refresh = useCallback(async () => {
    const id = ++serial.current;
    setRefreshing(true);
    try {
      const next = await snapshot(r, account);
      if (id === serial.current) {
        // A read that failed this round (it is named in `errors`) keeps the value the last snapshot had, so
        // one slow RPC answer no longer blanks a figure for a refresh. Actions stay locked while `errors` is
        // non-empty, so nothing is ever sent against a carried-over value.
        setSnapshot((old) => {
          if (!old || !next.errors.length) return next;
          const v = { ...next.v };
          for (const [k, x] of Object.entries(old.v))
            if ((v as Record<string, unknown>)[k] === undefined && x !== undefined)
              (v as Record<string, unknown>)[k] = x;
          return { ...next, v };
        });
        setReadError("");
      }
    } catch (e) {
      // A failed refresh keeps what is on screen (actions lock and the notice says why) instead of emptying
      // the whole terminal until the next read succeeds.
      if (id === serial.current) setReadError(message(e));
    } finally {
      if (id === serial.current) setRefreshing(false);
    }
  }, [r, account]);
  useEffect(() => {
    setSnapshot(undefined);
    void refresh();
    const i = setInterval(() => {
      if (document.visibilityState === "visible" && !locked.current)
        void refresh();
    }, 15000);
    return () => {
      clearInterval(i);
      serial.current++;
    };
  }, [refresh]);
  useEffect(() => {
    const i = setInterval(
      () => setNow(BigInt(Math.floor(Date.now() / 1000))),
      1000,
    );
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    const p = window.ethereum;
    if (!p) return;
    const changed = (a: unknown) => {
      // Disconnected here: the wallet's own account and its silent reconnect on load are ignored until
      // the user connects again through a "Disconnected" label.
      if (disconnectedHere()) return;
      setAccount((a as Address[])[0]);
      setReview(undefined);
      setSnapshot(undefined);
      setTx({ status: "Account changed. Review actions again." });
    };
    const network = (id: unknown) => {
      setChainId(Number(id));
      setReview(undefined);
    };
    p.on?.("accountsChanged", changed);
    p.on?.("chainChanged", network);
    void p
      .request({ method: "eth_accounts" })
      .then(changed)
      .catch(() => {});
    void p
      .request({ method: "eth_chainId" })
      .then(network)
      .catch(() => {});
    return () => {
      p.removeListener?.("accountsChanged", changed);
      p.removeListener?.("chainChanged", network);
    };
  }, []);
  // QA-04: when a review closes by any path, return focus to the control that opened it, once that
  // control is enabled again (it is disabled while the action is busy).
  useEffect(() => {
    if (review) restore.current = true;
    else if (restore.current && !busy) {
      restore.current = false;
      const el = opener.current as HTMLButtonElement | null;
      requestAnimationFrame(() => {
        if (el?.isConnected && !el.disabled) el.focus();
      });
    }
  }, [review, busy]);
  useEffect(() => {
    if (review && !dialog.current?.open) dialog.current?.showModal();
    if (!review && dialog.current?.open) dialog.current.close();
  }, [review]);
  const correctChain = chainId === r.config.chainId;
  const recent = s && Date.now() - s.loadedAt < 45000;
  const ready =
    !!account &&
    correctChain &&
    !!s?.verified &&
    !!recent &&
    !readError &&
    s.errors.length === 0;
  const reason = !account
    ? "Connect a wallet to use this control."
    : !correctChain
      ? `Switch to ${r.config.network.name} to continue.`
      : !s
        ? "Waiting for verified contract state."
        : !recent
          ? "State is outdated. Refresh before continuing."
          : s.errors.length
            ? "Some required reads failed. Refresh before continuing."
            : "";
  async function connect() {
    setConnecting(true);
    setWalletError("");
    rememberDisconnected(false);
    try {
      const p = window.ethereum;
      if (!p)
        throw Error(
          "No browser wallet found. Install an Ethereum wallet extension, then reload.",
        );
      const a = await p.request({ method: "eth_requestAccounts" });
      setAccount(a[0] as Address);
      setChainId(Number(await p.request({ method: "eth_chainId" })));
    } catch (e) {
      setWalletError(message(e));
    } finally {
      setConnecting(false);
    }
  }
  /** Forget the account here and in the wallet where it allows (wallet_revokePermissions), and stay
   * disconnected across reloads until the user connects again. */
  function disconnect() {
    rememberDisconnected(true);
    setAccount(undefined);
    setReview(undefined);
    setTx({ status: "No transaction submitted." });
    void window.ethereum
      ?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] })
      .catch(() => {});
  }
  async function changeChain() {
    setConnecting(true);
    setWalletError("");
    try {
      if (!window.ethereum) throw Error("No wallet found.");
      await switchChain(r, window.ethereum);
      setChainId(
        Number(await window.ethereum.request({ method: "eth_chainId" })),
      );
    } catch (e) {
      setWalletError(message(e));
    } finally {
      setConnecting(false);
    }
  }
  async function guard(p: EIP1193Provider) {
    if (!ready || !account)
      throw Error(reason || "Fresh verified state is required.");
    const [accounts, chain] = await Promise.all([
      p.request({ method: "eth_accounts" }),
      p.request({ method: "eth_chainId" }),
    ]);
    if (
      Number(chain) !== r.config.chainId ||
      accounts[0]?.toLowerCase() !== account.toLowerCase() ||
      accountRef.current !== account
    )
      throw Error("Wallet account or chain changed. Refresh and review again.");
    if ((await r.client.getChainId()) !== r.config.chainId)
      throw Error("RPC chain mismatch.");
  }
  const actions: Actions = {
    ready,
    busy,
    reason,
    account,
    run: async (id, request) => {
      // QA-04: remember the control that asked for review before simulation disables it.
      opener.current = document.activeElement as HTMLElement | null;
      if (locked.current) throw Error("Wait for the current action to finish.");
      locked.current = true;
      setBusy(id);
      try {
        const p = window.ethereum;
        if (!p) throw Error("Connect a browser wallet.");
        await guard(p);
        await r.client
          .simulateContract({
            ...request.target,
            functionName: onChain(request.fn),
            args: onChainArgs(request.args),
            account,
          })
          .catch((e) =>
            explained(
              e,
              { fn: request.fn, args: request.args, s, account },
              request.explain,
            ),
          );
        setTx({
          status: "Simulation passed. Review the transaction before signing.",
        });
        setReview({ id, request, account: account! });
      } finally {
        locked.current = false;
        setBusy("");
      }
    },
    sequence: async (id, { calls, batch, onStep }) => {
      if (locked.current) throw Error("Wait for the current action to finish.");
      if (!calls.length) throw Error("Nothing to send.");
      locked.current = true;
      setBusy(id);
      const simulate = (c: Call) =>
        r.client
          .simulateContract({ ...c.target, functionName: onChain(c.fn), args: onChainArgs(c.args), account })
          .catch((e) => explained(e, { fn: c.fn, args: c.args, s, account }));
      try {
        const p = window.ethereum;
        if (!p) throw Error("Connect a browser wallet.");
        await guard(p);
        const w = wallet(r, p);
        if (batch) {
          // Later calls depend on earlier ones (the swap spends what the borrow mints), so only the first can be
          // simulated alone; the swap's minimum out and the wallet's own simulation of the batch cover the rest.
          await simulate(calls[0]);
          setTx({ status: `Confirm ${calls.length} steps in your wallet: one signature, all or nothing.` });
          const { id: batchId } = await w.sendCalls({
            account: account!,
            chain: r.chain,
            forceAtomic: true,
            calls: calls.map((c) => ({
              to: c.target.address,
              data: encodeFunctionData({ abi: c.target.abi, functionName: onChain(c.fn), args: onChainArgs(c.args) }),
            })),
          });
          setTx({ status: "Submitted. Waiting for on-chain confirmation…" });
          const result = await w.waitForCallsStatus({ id: batchId, timeout: 180_000 });
          const hash = result.receipts?.[result.receipts.length - 1]?.transactionHash;
          if (result.status !== "success")
            throw Error("The batch did not go through. It is all or nothing, so none of its steps were applied.");
          onStep?.(calls.length);
          setTx({ status: "Confirmed. Refreshing balances and state…", hash });
        } else {
          for (const [i, c] of calls.entries()) {
            await guard(p);
            const simulation = await simulate(c);
            await guard(p);
            setTx({ status: `Step ${i + 1} of ${calls.length}: ${c.label}. Confirm in your wallet.` });
            const hash = await w.writeContract({ ...simulation.request, account: account!, chain: r.chain });
            setTx({ status: `Step ${i + 1} of ${calls.length} submitted. Waiting for confirmation…`, hash });
            const receipt = await r.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120000 });
            if (receipt.status !== "success")
              throw Error(`Step ${i + 1} (${c.label}) reverted on chain. The steps before it stand.`);
            onStep?.(i + 1);
          }
        }
        await refresh();
        setTx((old) => ({ ...old, status: "Confirmed on chain." }));
      } catch (e) {
        setTx((old) => ({ ...old, status: "Action stopped.", error: message(e) }));
        throw e;
      } finally {
        locked.current = false;
        setBusy("");
      }
    },
  };
  function cancelReview() {
    setReview(undefined);
    setTx({ status: "Review cancelled. Nothing was sent." });
  }
  async function submit() {
    if (!review || locked.current) return;
    const { id, request } = review;
    locked.current = true;
    setBusy(id);
    setTx({ status: "Checking the transaction again…" });
    try {
      const p = window.ethereum;
      if (!p) throw Error("Wallet disconnected.");
      if (review.account !== account)
        throw Error("Account changed. Cancel and review again.");
      await guard(p);
      const simulation = await r.client
        .simulateContract({
          ...request.target,
          functionName: onChain(request.fn),
          args: onChainArgs(request.args),
          account,
        })
        .catch((e) =>
          explained(
            e,
            { fn: request.fn, args: request.args, s, account },
            request.explain,
          ),
        );
      await guard(p);
      setTx({ status: "Confirm this action in your wallet." });
      const hash = await wallet(r, p).writeContract({
        ...simulation.request,
        account: account!,
        chain: r.chain,
      });
      setTx({ status: "Submitted. Waiting for on-chain confirmation…", hash });
      setReview(undefined);
      const receipt = await r.client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120000,
      });
      if (receipt.status !== "success")
        throw Error("Transaction reverted on chain. No changes were applied.");
      setTx({ status: "Confirmed. Refreshing balances and state…", hash });
      await refresh();
      setTx({ status: "Confirmed on chain.", hash });
    } catch (e) {
      setTx((old) => ({
        ...old,
        status: "Action stopped.",
        error: message(e),
      }));
    } finally {
      locked.current = false;
      setBusy("");
    }
  }
  const monitor = [
    ["loans", "Loan book"],
    ["oracle", "Oracle"],
    ["backing", "Backing"],
    ["points", "Points"],
  ] as const;
  const deskTabs = [
    ["position", "Position"],
    ["redemption", "Redeem"],
    ["work", "Work"],
    ["keeper", "Keeper"],
    ["governance", "Govern"],
  ] as const;
  return (
    <ConnectWallet.Provider value={account ? null : { connect, connecting }}>
    <div className="terminal">
      <a href="#terminal-main" className="skip">
        Skip to terminal panes
      </a>
      <SiteHeader
        page="terminal"
        network={r.config.network.name}
        mainnet={r.config.network.testnet === false}
      >
        {account ? (
          <>
            {!correctChain && (
              <button
                className="primary"
                disabled={connecting}
                onClick={changeChain}
              >
                {connecting
                  ? "Switching…"
                  : `Switch to ${r.config.network.name}`}
              </button>
            )}
          </>
        ) : null}
        <DisconnectBox
          connected={!!account}
          label={account ? `Disconnect ${account}` : "Disconnect"}
          onDisconnect={disconnect}
        />
      </SiteHeader>
      {walletError || readError || s?.errors.length ? (
        <div className="global-notice" role="alert">
          {walletError ||
            readError ||
            `Unavailable reads: ${s?.errors.join(", ")}. Refresh to retry.`}
        </div>
      ) : null}
      {s && ceilingState(s.v)?.reached ? (
        <div className="global-notice global-notice-cap" role="status">
          The borrowing cap is reached: no new {unit()} can be borrowed until
          borrowers repay or governance raises the cap (a public proposal, then a waiting period). Depositing,
          repaying and redeeming still work.
        </div>
      ) : null}
      <nav className="mobile-nav" aria-label="Terminal panes">
        <Select
          id="view-pane"
          label="View pane"
          value={mobilePane}
          options={[...monitor.slice(0, 1), ...deskTabs, ...monitor.slice(1)]}
          onChange={(id) => {
            setMobilePane(id);
            if (deskTabs.some(([d]) => d === id)) setDesk(id);
            else setView(id);
          }}
        />
      </nav>
      <main
        id="terminal-main"
        className="workspace"
        data-mobile-pane={mobilePane}
        data-desk={desk}
        data-monitor={view}
        tabIndex={-1}
      >
        {/* Inside the main landmark, so the page heading belongs to a region. */}
        <h1 className="sr-only">imdUSD terminal</h1>
        <div className="monitor">
          <Tabs
            label="Monitor"
            tabs={monitor}
            value={view}
            onChange={(id) => {
              setView(id);
              setMobilePane(id);
            }}
          />
          <Pane
            monitor
            id="loans"
            index="00"
            title="Loan book"
            tag="Live risk bands"
          >
            <LoanBook charts={charts} available={!!s} onOpen={openInKeeper} />
          </Pane>
          <Pane monitor id="oracle" index="01" title="Oracle" tag="Feeds">
            <Oracle r={r} s={s} now={now} charts={charts} actions={actions} />
          </Pane>
          <Pane
            monitor
            columns
            id="backing"
            index="02"
            title="Backing"
            tag="Treasury"
          >
            <Backing r={r} s={s} />
          </Pane>
          <Pane
            monitor
            columns
            id="points"
            index="08"
            title="Points"
            tag="Genesis season"
          >
            <Points r={r} account={account} points={points} />
          </Pane>
        </div>
        <div className="desk">
          <Tabs
            label="Desk"
            tabs={deskTabs}
            value={desk}
            onChange={(id) => {
              setDesk(id);
              setMobilePane(id);
            }}
          />
          <Pane
            desk
            id="position"
            index="03"
            title="Position"
            tag={account ? "Wallet" : "Disconnected"}
          >
            <Position r={r} s={s} actions={actions} />
          </Pane>
          <Pane
            desk
            id="redemption"
            index="04"
            title="Redemption"
            tag="Reserve first"
          >
            <Redemption r={r} s={s} actions={actions} />
          </Pane>
          <Pane
            desk
            id="work"
            index="05"
            title="Work"
            tag={
              s?.work.mode === "attested"
                ? "Attested"
                : s?.work.mode === "faucet"
                  ? "Test credits"
                  : "Oracle"
            }
          >
            <Work r={r} s={s} actions={actions} now={now} charts={charts} />
          </Pane>
          <Pane desk id="keeper" index="06" title="Keeper" tag="Permissionless">
            <Keeper
              r={r}
              s={s}
              actions={actions}
              now={now}
              target={keeperTarget}
            />
          </Pane>
          <Pane
            desk
            id="governance"
            index="07"
            title="Governance"
            tag="Timelock"
          >
            <Governance r={r} s={s} actions={actions} now={now} />
          </Pane>
        </div>
      </main>
      <footer>
        <div className="statusbar">
          <span>
            <span className="status-dot" />{" "}
            {readError
              ? "RPC unavailable"
              : s
                ? feedsReady(s)
                  ? "Feeds ready"
                  : "Feeds require attention"
                : "Verifying deployment"}
          </span>
          <MarketCap supply={s?.v.supply} />
          <span title="Treasury reserve assets, valued in USD">
            Reserves{" "}
            <b>
              <Ticker
                text={
                  shownReserve(s?.v).value === undefined
                    ? "—"
                    : `$\u00a0${compact.format(Number(formatUnits(shownReserve(s?.v).value!, 18)))}`
                }
              />
            </b>
          </span>
          <span>
            Block <b>{s?.block.toString() ?? "—"}</b>
          </span>
          <button
            className={`refresh${refreshing ? " is-refreshing" : ""}`}
            aria-label={refreshing ? "Refreshing state" : "Refresh state"}
            title="Refresh"
            disabled={refreshing || !!busy}
            onClick={() => void refresh()}
          >
            <svg
              viewBox="0 0 20 20"
              width="18"
              height="18"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M16 10a6 6 0 1 1-1.76-4.24" />
              <path d="M16 3.5v3.25h-3.25" />
            </svg>
          </button>
        </div>
        <div className="footer-line">
          <div className="transaction-status" role="status">
            <span>
              {busy ? "↳ " : ""}
              {tx.error || tx.status}
            </span>
            {tx.hash && (
              <a
                href={`${r.config.network.explorer}/tx/${tx.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction ↗
              </a>
            )}
          </div>
          <div className="footer-meta">
            <span>imdUSD / v.12</span>
            <span>
              {s
                ? `Read ${Math.max(0, Math.floor((Date.now() - s.loadedAt) / 1000))}s ago`
                : "Awaiting RPC"}
            </span>
            <a href={href("imd-deployment.json")} target="_blank" rel="noreferrer">
              Deployment ↗
            </a>
          </div>
        </div>
      </footer>
      <dialog
        ref={dialog}
        aria-labelledby="review-heading"
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else cancelReview();
        }}
        onClose={() => {
          if (!busy) setReview(undefined);
        }}
      >
        <h2 id="review-heading">Review transaction</h2>
        {review && (
          <>
            <p>{review.request.summary}</p>
            {review.request.warning && (
              <p className="danger-text review-warning" role="alert">
                {review.request.warning}
              </p>
            )}
            <AddressLink
              value={review.request.target.address}
              explorer={r.config.network.explorer}
              label="Target contract"
            />
            <p className="micro">
              {review.request.fn} · {r.config.network.name} · wallet {account}
            </p>
            <p className="micro">
              The transaction is simulated again before signing. Network gas is
              paid in ETH. Simulation cannot guarantee execution in a later
              block.
            </p>
            <div role="status">{tx.error || tx.status}</div>
            <div className="button-row">
              <button disabled={!!busy} onClick={cancelReview}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!!busy || !ready}
                onClick={() => void submit()}
              >
                {busy ? "Processing…" : "Confirm in wallet"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
    </ConnectWallet.Provider>
  );
}
