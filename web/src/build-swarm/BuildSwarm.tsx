// Build with the swarm, the headline of imdusd.com/build/: describe it, sign in with any wallet, get INFER BOX's
// verdict (odds, what blocks it, what to sharpen, the facts it still needs), then pay the quote in imdUSD and the
// swarm runs it. Talks only to box.imdusd.com and the public RPCs in ./wallet.
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import * as box from "./box";
import { findWallets, type Provider, type WalletOption } from "./wallet";

type Session = { provider: Provider; wallet: Address; token: string };
const BAND: Record<box.Band, string> = {
  likely: "Likely to pass",
  uncertain: "Could go either way",
  unlikely: "Unlikely to pass as written",
  refused: "The Box won't run this",
};
const message = (e: unknown) =>
  e instanceof box.BoxError ? e.message : e instanceof Error ? (/rejected|denied/i.test(e.message) ? "You declined in the wallet." : e.message.split("\n")[0]) : String(e);

export default function BuildSwarm() {
  const [idea, setIdea] = useState("");
  const [kind, setKind] = useState<box.Kind>("build");
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [verdict, setVerdict] = useState<box.Verdict | null>(null);
  const [facts, setFacts] = useState<Record<string, string>>({});
  const [q, setQ] = useState<box.Quote | null>(null);
  const [orders, setOrders] = useState<box.Order[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  // Orders refresh while one is on its way to the swarm.
  useEffect(() => {
    if (!session) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await box.orders(session.token);
        if (!stop) setOrders(r.orders);
        const moving = r.orders.some((o) => ["quoted", "paid", "sending", "held"].includes(o.status));
        if (!stop) timer = setTimeout(tick, moving ? 5_000 : 60_000);
      } catch {
        if (!stop) timer = setTimeout(tick, 60_000);
      }
    };
    let timer = setTimeout(tick, 0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [session]);

  async function run<T>(label: string, f: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await f();
    } catch (e) {
      if (e instanceof box.BoxError && e.status === 401 && session) {
        box.forget(session.wallet);
        setSession(null);
      }
      if (live.current) setError(message(e));
      return undefined;
    } finally {
      if (live.current) setBusy(null);
    }
  }

  async function start(choice?: WalletOption) {
    if (!choice) {
      const found = await findWallets();
      if (found.length !== 1) return setWallets(found);
      choice = found[0];
    }
    setWallets(null);
    const s = await run("Sign the message in your wallet (it costs nothing)…", () => box.signIn(choice!.provider));
    if (s) setSession({ provider: choice.provider, ...s });
    return s;
  }

  async function check() {
    if (idea.trim().length < 20) return setError("Describe it in a sentence or two.");
    const s = session ?? (await start().then((x) => (x ? { token: x.token } : null)));
    if (!s) return;
    const filled = Object.fromEntries(Object.entries(facts).filter(([, v]) => v.trim()));
    const v = await run("INFER BOX is reading it…", () => box.evaluate(s.token, idea.trim(), kind, filled));
    if (v) {
      setVerdict(v);
      setQ(null);
    }
  }

  async function price() {
    if (!session || !verdict) return;
    const r = await run("Pricing it…", () => box.quote(session.token, verdict.id));
    if (r) setQ(r);
  }

  async function payNow() {
    if (!session || !q) return;
    const hash = await run("Preparing the payment…", () => box.pay(session.provider, session.wallet, q, (s) => live.current && setBusy(s)));
    if (hash) {
      setQ(null);
      setVerdict(null);
      setFacts({});
      setIdea("");
      const r = await box.orders(session.token).catch(() => null);
      if (r) setOrders(r.orders);
    }
  }

  const blocked = verdict?.risks?.some((r) => r.severity === "block") || verdict?.band === "refused";
  return (
    <div className="bs">
      <label className="bs-label" htmlFor="bs-idea">What should the swarm build?</label>
      <textarea
        id="bs-idea"
        className="bs-idea"
        rows={4}
        maxLength={2000}
        value={idea}
        placeholder="e.g. Build a mint site for my NFT collection on Ethereum: 500 pieces at 0.01 ETH, artwork at ipfs://…, one page with a connect button and a mint button."
        onChange={(e) => {
          setIdea(e.target.value);
          setVerdict(null);
          setQ(null);
        }}
      />
      <fieldset className="bs-kinds">
        <legend className="sr-only">Kind of request</legend>
        {box.KINDS.map(([id, label, hint]) => (
          <label key={id} className={kind === id ? "on" : ""} title={hint}>
            <input type="radio" name="bs-kind" value={id} checked={kind === id} onChange={() => setKind(id)} />
            {label}
          </label>
        ))}
      </fieldset>

      {verdict?.fields?.length ? (
        <div className="bs-facts">
          <p className="bs-small">INFER BOX needs these to be sure. Fill in what you know and check again.</p>
          {verdict.fields.map((f) => (
            <label key={f.id}>
              <span>{f.label}</span>
              <input
                value={facts[f.label] ?? ""}
                placeholder={f.example}
                inputMode={f.type === "number" ? "decimal" : undefined}
                onChange={(e) => setFacts({ ...facts, [f.label]: e.target.value })}
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className="bs-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={check}>
          {verdict ? "Check again" : session ? "Check it with INFER BOX" : "Connect a wallet and check it"}
        </button>
        {session && (
          <span className="bs-small">
            Signed in as {session.wallet.slice(0, 6)}…{session.wallet.slice(-4)}.{" "}
            <button type="button" className="bs-link" onClick={() => (box.forget(session.wallet), setSession(null), setOrders([]))}>
              Sign out
            </button>
          </span>
        )}
      </div>

      {wallets && (
        <div className="bs-wallets" role="dialog" aria-label="Choose a wallet">
          {wallets.length === 0 ? (
            <p>No browser wallet found. Install one (MetaMask, Rabby, Coinbase Wallet), or open this page in your wallet app's browser.</p>
          ) : (
            wallets.map((w) => (
              <button type="button" key={w.id} onClick={() => start(w)}>
                {w.icon && <img src={w.icon} alt="" width={20} height={20} />} {w.name}
              </button>
            ))
          )}
          <button type="button" className="bs-link" onClick={() => setWallets(null)}>Cancel</button>
        </div>
      )}

      <p className="bs-status" role="status" aria-live="polite">{busy ?? ""}</p>
      {error && <p className="bs-error" role="alert">{error}</p>}

      {verdict && (
        <section className={`bs-verdict band-${verdict.band}`} aria-label="INFER BOX verdict">
          <h3>{BAND[verdict.band]}</h3>
          {verdict.policy && <p>{verdict.policy.line}</p>}
          {verdict.risks?.length ? (
            <ul>
              {verdict.risks.map((r, i) => (
                <li key={i}>
                  <b>{r.severity === "block" ? "Blocks it" : r.severity === "high" ? "Serious" : "Worth fixing"}:</b> {r.reason}
                  {r.redirect && <> Instead: {r.redirect}</>}
                </li>
              ))}
            </ul>
          ) : null}
          {verdict.sharpen?.length ? (
            <>
              <p className="bs-small">Be more specific about:</p>
              <ul>{verdict.sharpen.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </>
          ) : null}
          {typeof verdict.usedToday === "number" && typeof verdict.evalsPerDay === "number" && (
            <p className="bs-small">{verdict.evalsPerDay - verdict.usedToday} checks left today.</p>
          )}
          {!blocked && !q && (
            <button type="button" className="primary" disabled={!!busy} onClick={price}>Get a price</button>
          )}
          {blocked && <p className="bs-small">Fix what blocks it, then check again. Nothing has been paid.</p>}
        </section>
      )}

      {q && (
        <section className="bs-quote" aria-label="Price">
          <h3>{box.toImdUsd(q.total)} imdUSD</h3>
          <p className="bs-small">
            The swarm charges {q.shown.swarmPriceImd} IMD (about {q.shown.cost.toFixed(2)} imdUSD at ${q.shown.imdUsd.toFixed(2)} per IMD),
            plus {q.shown.buffer.toFixed(2)} for the Box. Paid on Ethereum from your wallet; the quote holds until{" "}
            {new Date(q.expiresAt).toLocaleTimeString()}.
          </p>
          <button type="button" className="primary" disabled={!!busy} onClick={payNow}>Pay and run it</button>
        </section>
      )}

      {orders.length > 0 && (
        <section className="bs-orders" aria-label="Your requests">
          <h3>Your requests</h3>
          <ul>
            {orders.slice(0, 8).map((o) => (
              <li key={o.id}>
                <span>{o.action}</span> <span className="bs-small">{new Date(o.created_at).toLocaleDateString()}</span>{" "}
                <span>{o.result?.say ?? o.status}</span>
                {o.job_id && (
                  <>
                    {" "}
                    <a href={`https://explorer.imd.fun/jobs/${o.job_id}`} target="_blank" rel="noreferrer">
                      Follow it<span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
