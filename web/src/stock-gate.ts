// The ONE way a stock or SGOV pane renders (planned tokenized-stock collateral). It asks the Worker's /geo,
// fails closed until the answer arrives (and when it does not), and hands the pane its allowed actions:
//
//   createElement(StockGate, { wallet, hasPosition }, (gate) => <StockPane actions={gate.actions} />)
//
// A restricted or unknown country sees nothing, except an existing position, read-only, with repay / withdraw /
// claim (GEOFENCE exception, geofence.json `unwindException`; legal to confirm). scripts/geofence-check.mjs
// refuses any stock surface that does not import this file. Written without JSX so node's tests can render it.
import { createElement, useEffect, useState, type ReactNode } from "react";
import { GEO, declarationKey, stockAccess, type GeoAnswer, type StockAccess } from "./geofence.ts";

let pending: Promise<GeoAnswer | null> | null = null;

/** /geo, asked once per page load. null when it fails: the gate then stays shut. */
export function fetchGeo(fetcher: typeof fetch = fetch): Promise<GeoAnswer | null> {
  pending ??= fetcher("/geo", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<GeoAnswer>) : null))
    .catch(() => null);
  return pending;
}

function readDeclared(wallet?: string): boolean {
  if (!wallet) return false;
  try {
    return localStorage.getItem(declarationKey(wallet)) === "1";
  } catch {
    return false;
  }
}

export type Gate = StockAccess & { declare: () => void };

/** The visitor's stock access, live. `geo` and `declared` override the fetch and the stored declaration (tests, server render). */
export function useStockGate(opts: { wallet?: string; hasPosition?: boolean; geo?: GeoAnswer | null; declared?: boolean }): Gate {
  const [geo, setGeo] = useState<GeoAnswer | null>(opts.geo ?? null);
  const [declared, setDeclared] = useState(() => readDeclared(opts.wallet));
  useEffect(() => {
    if (opts.geo !== undefined) return;
    let live = true;
    fetchGeo().then((g) => live && setGeo(g));
    return () => {
      live = false;
    };
  }, [opts.geo]);
  useEffect(() => setDeclared(readDeclared(opts.wallet)), [opts.wallet]);
  const access = stockAccess(opts.geo !== undefined ? opts.geo : geo, { hasPosition: opts.hasPosition, declared: opts.declared ?? declared });
  const declare = () => {
    if (!opts.wallet) return;
    try {
      localStorage.setItem(declarationKey(opts.wallet), "1");
    } catch {}
    setDeclared(true);
  };
  return { ...access, declare };
}

export type StockGateProps = {
  wallet?: string;
  hasPosition?: boolean;
  geo?: GeoAnswer | null;
  declared?: boolean;
  children: (gate: Gate) => ReactNode;
};

/** Renders nothing in "none"; the declaration (and, for a borrower, the unwind pane) in "declare"; the pane otherwise. */
export function StockGate(props: StockGateProps) {
  const gate = useStockGate(props);
  if (gate.mode === "none") return null;
  if (gate.mode === "declare") {
    const ask = createElement(
      "div",
      { className: "stock-declaration", role: "group", "aria-label": "Stock-token eligibility" },
      createElement("p", null, GEO.declaration),
      createElement("button", { type: "button", onClick: gate.declare, disabled: !props.wallet }, props.wallet ? "I confirm" : "Connect a wallet to continue"),
    );
    return createElement("div", null, ask, props.hasPosition ? props.children(gate) : null);
  }
  return props.children(gate);
}
