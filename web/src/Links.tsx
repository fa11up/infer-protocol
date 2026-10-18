// imdusd.com/links/: every imdUSD link on one page, for sharing in person. The founder opens it on a phone and
// shows the QR code ("Show QR"); whoever scans it lands here. It reads no chain, so it is the same in every build
// (the terminal and stats rows appear only where those pages are served, like the header's links).
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SiteFooter,
  SiteHeader,
  href,
  TERMINAL,
  WHITEPAPER,
  INFER_SITE,
  X_ACCOUNT,
  INFER_DEXSCREENER,
  SOURCE_REPO,
  IDENTITYMD,
} from "./site";
import { EMAIL, TELEGRAM } from "./links-config";

/** The address the QR code holds (scripts/links-qr.mjs writes public/links/qr.svg from the same URL). */
const LINKS_URL = "https://imdusd.com/links/";

type Row = { title: string; sub: string; url: string; external?: boolean };
type Group = { name: string; rows: (Row | false)[] };

const GROUPS: Group[] = [
  {
    name: "imdUSD",
    rows: [
      { title: "Website", sub: "imdusd.com: how imdUSD holds a dollar, and its contracts", url: href() },
      TERMINAL && { title: "Terminal", sub: "Borrow, repay, redeem and liquidate on Ethereum", url: href("terminal/") },
      TERMINAL && { title: "Stats", sub: "The peg, the loan book, price updates and the Treasury, live", url: href("stats/") },
      { title: "Docs", sub: "Borrowing, redemption, liquidation and the swarm oracle", url: href("docs/") },
      { title: "Whitepaper", sub: "The design and its reasoning", url: WHITEPAPER, external: true },
    ],
  },
  {
    name: "INFER",
    rows: [
      { title: "INFER", sub: "The protocol's token: claim, swap, stake and the tokenomics", url: INFER_SITE, external: true },
      { title: "Buy INFER", sub: "Swap for INFER from your wallet", url: `${INFER_SITE}/buy/`, external: true },
      { title: "INFER on DexScreener", sub: "The INFER/IMD launch pool's chart", url: INFER_DEXSCREENER, external: true },
    ],
  },
  {
    name: "Follow and ask",
    rows: [
      { title: "X", sub: "@imdusd", url: X_ACCOUNT, external: true },
      !!TELEGRAM && { title: "Telegram", sub: "The token-gated group", url: TELEGRAM, external: true },
    ],
  },
  {
    name: "Build",
    rows: [
      { title: "Source code", sub: "github.com/fa11up/infer-protocol: contracts, sites and docs", url: SOURCE_REPO, external: true },
      { title: "IdentityMD", sub: "imd.fun: the agent network whose panels price imdUSD", url: IDENTITYMD, external: true },
    ],
  },
];

function LinkRow({ title, sub, url, external }: Row) {
  return (
    <li>
      <a className="links-row" href={url} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        <span className="links-text">
          <span className="links-title">{title}</span>
          <span className="links-sub">{sub}</span>
        </span>
        <span className="links-arrow" aria-hidden="true">
          {external ? "↗" : "→"}
        </span>
        {external && <span className="sr-only"> (opens in a new tab)</span>}
      </a>
    </li>
  );
}

/** The email row: the address is the primary thing (a mailto link does nothing in some apps), so it is plain
 * selectable text with Copy beside it; Copy falls back to selecting the address where the clipboard is refused. */
function EmailRow() {
  const address = useRef<HTMLSpanElement>(null);
  const [status, setStatus] = useState("");
  const select = () => {
    const el = address.current;
    const sel = window.getSelection();
    if (!el || !sel) return;
    sel.selectAllChildren(el);
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(EMAIL);
      setStatus("Copied");
    } catch {
      select();
      setStatus("Selected: copy it from here");
    }
  };
  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(""), 4000);
    return () => clearTimeout(id);
  }, [status]);
  return (
    <li className="links-email">
      <div className="links-text">
        <span className="links-title">Email</span>
        <span className="links-address" ref={address} id="links-email-text">
          {EMAIL}
        </span>
      </div>
      <div className="links-email-actions">
        <button type="button" onClick={copy} aria-describedby="links-email-text">
          Copy
        </button>
        <a className="button" href={`mailto:${EMAIL}`}>
          Write<span className="sr-only"> an email to {EMAIL}</span>
        </a>
      </div>
      <p className="links-status" role="status" aria-live="polite">
        {status}
      </p>
    </li>
  );
}

/** The QR code, full screen, dark on white in either theme. A native modal dialog: focus moves into it and Escape
 * closes it. */
function QrDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="links-qr"
      aria-labelledby="links-qr-title"
      onClose={onClose}
      onClick={(e) => {
        // A tap on the white around the code closes it too.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <h2 id="links-qr-title" className="sr-only">
        QR code for imdusd.com/links
      </h2>
      <img
        className="links-qr-code"
        src={href("links/qr.svg")}
        width={410}
        height={410}
        alt={`QR code: ${LINKS_URL}`}
      />
      <p className="links-qr-caption">
        imd<b>USD</b>
        <span>imdusd.com/links</span>
      </p>
      <button type="button" className="links-qr-close" onClick={onClose} autoFocus>
        Close
      </button>
    </dialog>
  );
}

export function Links() {
  const [qr, setQr] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setQr(false);
    opener.current?.focus();
  };
  const rows = (g: Group): ReactNode[] =>
    g.rows.filter((r): r is Row => !!r).map((r) => <LinkRow key={r.title} {...r} />);
  return (
    <div className="site">
      <SiteHeader page="links" />
      <main className="links" id="main">
        <header className="links-head">
          <p className="doc-meta">Links</p>
          <h1>
            imd<b>USD</b>
          </h1>
          <p className="lede">
            imdUSD is a dollar-denominated stablecoin borrowed against staked IMD. Its price comes from panels of
            IdentityMD agents, signed and checked on chain against the exact question each feed pins.
          </p>
          <button type="button" className="links-show-qr" ref={opener} onClick={() => setQr(true)} aria-haspopup="dialog">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
              <path
                fill="currentColor"
                d="M1 1h6v6H1zm1 1v4h4V2zm1 1h2v2H3zM9 1h6v6H9zm1 1v4h4V2zm1 1h2v2h-2zM1 9h6v6H1zm1 1v4h4v-4zm1 1h2v2H3zM9 9h2v2H9zm2 2h2v2h-2zm2-2h2v2h-2zm-4 4h2v2H9zm4 0h2v2h-2z"
              />
            </svg>
            Show QR
          </button>
        </header>
        {GROUPS.map((g) => (
          <section className="links-group" key={g.name} aria-labelledby={`links-${g.name.replace(/\W+/g, "-").toLowerCase()}`}>
            <h2 id={`links-${g.name.replace(/\W+/g, "-").toLowerCase()}`}>{g.name}</h2>
            <ul>
              {rows(g)}
              {g.name === "Follow and ask" && <EmailRow />}
            </ul>
          </section>
        ))}
      </main>
      <SiteFooter />
      <QrDialog open={qr} onClose={close} />
    </div>
  );
}
