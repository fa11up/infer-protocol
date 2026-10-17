// /buy/: the page an X player card shows inside a post (480 × 560), and a page of its own anywhere else.
// The masthead carries INFER's price in USD and its market cap, live from the launch pool; the body is
// the site's engraved background with one button, Buy $INFER, which drops the home
// page's trade pane (App.tsx `Trade`, compact, no staking) in under the masthead, so a trade never
// leaves the card. Connecting offers every browser wallet and WalletConnect, the way into a phone wallet
// from the X app, which has no extensions (ui.tsx WalletChooser).
// Before launch every figure is a dash and the pane says trading opens at launch. Inside a frame each
// link opens a new tab rather than navigating X's iframe; the Worker (worker/infer.js) lets x.com frame
// this one route and no other.
import { useEffect, useRef, useState } from "react";
import { everyVisible, REFRESH_MS } from "./visible";
import { Trade } from "./App";
import { LIVE } from "./config";
import { useInferMarket, usdCompact, usdPrice } from "./price";
import { Vibe } from "../vibe";
import { Fig, Mark, WalletChooser, useWallet } from "./ui";
import { INFER_VIBES } from "./vibes";
import { Sound } from "../score";
import { INFER_SCORE } from "./score";

export function Buy() {
  const m = useInferMarket();
  const w = useWallet();
  const sheet = useRef<HTMLDialogElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => {
    sheet.current?.close();
    go.current?.focus();
  };
  // Not modal, so the masthead (theme, background, sound) stays in use while the sheet is open; what a
  // modal gave for free is done here: Escape closes it, and so does a click on the scrim around it.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !w.choosing) close();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, w.choosing]);
  const [framed, setFramed] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    try {
      setFramed(window.self !== window.top);
    } catch {
      setFramed(true);
    }
  }, []);
  // The trade pane's balances and quote follow the chain at its block time, as on the home page.
  useEffect(() => {
    if (!LIVE) return;
    return everyVisible(refresh, REFRESH_MS);
  }, []);
  const out = framed
    ? { target: "_blank", rel: "noopener noreferrer" }
    : { rel: "noopener" };
  return (
    <div className="infer infer-buy">
      <header className="infer-buy-top">
        <a className="infer-mark" href="../" aria-label="INFER home" {...out}>
          <Mark />
          INFER
        </a>
        <div className="infer-buy-tools">
          <p className="infer-buy-price">
            <span className="sr-only">Price </span>
            <strong>
              <Fig v={m ? usdPrice(m.priceUsd) : null} />
            </strong>
            <span className="infer-buy-cap">
              <span className="infer-buy-sep" aria-hidden="true">
                {" · "}
              </span>
              {"MC "}
              <Fig v={m ? usdCompact(m.marketCapUsd) : null} />
            </span>
          </p>
          <Vibe suite={INFER_VIBES} />
          <Sound score={INFER_SCORE} />
        </div>
      </header>
      <main className="infer-buy-main">
        <p className="infer-kicker">
          Inference-Backed Endogenous Financial Reserve
        </p>
        <h1>INFER</h1>
        <p className="infer-buy-lede">
          The token of the imdUSD protocol, the dollar borrowed against staked
          IMD.
        </p>
        <div className="infer-buy-actions">
          <button
            type="button"
            className="infer-buy-go"
            aria-haspopup="dialog"
            aria-expanded={open}
            ref={go}
            onClick={() => {
              sheet.current?.show();
              setOpen(true);
            }}
          >
            Buy $INFER
          </button>
        </div>
      </main>
      <footer className="infer-buy-foot">infer.imdusd.com</footer>

      {/* A dialog over a scrim that dims the page but not the masthead. Escape or a click on the scrim
          closes it and focus returns to the button. */}
      {open && <div className="infer-buy-scrim" aria-hidden="true" onClick={close} />}
      <dialog
        ref={sheet}
        className="infer-buy-sheet"
        aria-label="Buy INFER"
        onClose={() => setOpen(false)}
      >
        {/* Connected, the sheet shows no address and no disconnect; the one thing it adds is, on a
            phone paired by WalletConnect, the way back into the wallet app to approve each trade. */}
        {w.account && w.walletLink && (
          <div className="infer-buy-sheet-bar">
            <a href={w.walletLink} target="_blank" rel="noopener noreferrer">
              Open wallet ↗
            </a>
          </div>
        )}
        {w.error && !w.choosing && (
          <p className="infer-buy-sheet-error" role="alert">
            {w.error.text}
          </p>
        )}
        <Trade w={w} tick={tick} refresh={refresh} compact />
      </dialog>
      <WalletChooser wallet={w} />
    </div>
  );
}
