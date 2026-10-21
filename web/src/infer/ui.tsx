import favicon from "../../public/favicon.svg?raw";

// Shared pieces of the three INFER pages: the shell, the wallet, the transaction runner and figures.
import { DisconnectBox } from "../disconnect";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { encode } from "uqr";
import wcConfig from "./walletconnect.json";
export { parseAmount } from "./amount";
import { ThemeToggle } from "../theme";
import { Vibe } from "../vibe";
import { INFER_VIBES } from "./vibes";
import { lazySound } from "../lazy-sound";
import { INFER_SOUND_KEY } from "../sound-key";
import { NetworkChip } from "../network-chip";
import { useInferMarket, usdCompact, usdPrice } from "./price";
import { INFER_DEXSCREENER } from "../infer-dexscreener";
import { LAUNCH, LIVE } from "./config";
import { ERC20, client, message } from "./chain";
import { NATIVE } from "./swap";

/** Set in walletconnect.json; read here so the page carries the flag but not WalletConnect's code. */
const WC_PROJECT_ID: string | null = wcConfig.projectId;
/** Wallet apps that open a WalletConnect pairing link directly (a phone's replacement for the QR code). */
const WALLET_APPS: { name: string; link: (uri: string) => string }[] = [
  {
    name: "MetaMask",
    link: (u) => `https://metamask.app.link/wc?uri=${encodeURIComponent(u)}`,
  },
  {
    name: "Rainbow",
    link: (u) => `https://rnbwapp.com/wc?uri=${encodeURIComponent(u)}`,
  },
  {
    name: "Trust",
    link: (u) => `https://link.trustwallet.com/wc?uri=${encodeURIComponent(u)}`,
  },
  {
    name: "Uniswap",
    link: (u) => `https://uniswap.org/app/wc?uri=${encodeURIComponent(u)}`,
  },
];

/** The sound button, its score loaded when the page is idle (lazy-sound.tsx). */
export const InferSound = lazySound(INFER_SOUND_KEY, () => import("../sound-infer"));

export const SITE = "https://imdusd.com";
export const WHITEPAPER = "https://whitepaper.imdusd.com";

/** Links between the three pages, from the page's own directory depth. */
/** A negative depth means absolute links from the site root (the not-found page is served at any path). */
export const at = (depth: number) => (page: "" | "claim/" | "tokenomics/") =>
  depth < 0 ? `/${page}` : `${"../".repeat(depth)}${page}`;

/** A figure, or a dash while it is pending: the dash is drawn, the word is read out. */
export function Fig({
  v,
  unit,
}: {
  v: string | null | undefined;
  unit?: string;
}) {
  if (v === null || v === undefined)
    return (
      <>
        <b className="figure-dash" aria-hidden="true">
          —
        </b>
        <span className="sr-only">Pending</span>
      </>
    );
  return (
    <>
      {v}
      {unit ? ` ${unit}` : ""}
    </>
  );
}

/**
 * A figure deliberately not published: random braille in its place, the same style as the redacted docs. The
 * pattern is seeded by `seed` so it is stable from render to render, and its length is fixed, never the real
 * figure's, which is never given to the page at all.
 */
export function Undisclosed({ seed, length = 5 }: { seed: string; length?: number }) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let out = "";
  for (let i = 0; i < length; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ i;
    out += String.fromCodePoint(0x2801 + ((h >>> 0) % 255));
  }
  return (
    <span className="redacted" role="img" aria-label="Undisclosed">
      <span aria-hidden="true">{out}</span>
    </span>
  );
}

/** Whole tokens from wei, grouped, at most `places` decimals; "…" while loading. */
export const tokens = (
  v: bigint | undefined | null,
  places = 2,
  decimals = 18,
) => {
  if (v === undefined || v === null) return "…";
  const [int, frac = ""] = formatUnits(v, decimals).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const f = frac.slice(0, places).replace(/0+$/, "");
  return f ? `${grouped}.${f}` : grouped;
};

export const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A message with a serial, so the same words twice still count as a new error. */
export type Notice = { id: number; text: string };
let noticeSeq = 0;
export const notice = (text: string): Notice => ({ id: ++noticeSeq, text });

// ------------------------------------------------------------------ wallet

type Listening = EIP1193Provider & {
  on?: (event: string, listener: (arg: unknown) => void) => void;
  removeListener?: (event: string, listener: (arg: unknown) => void) => void;
};

/** One way to connect: a browser wallet (announced through EIP-6963, or plain window.ethereum), or
 * WalletConnect, which pairs a phone wallet by QR code or by a link into the wallet app. */
export type WalletOption =
  | {
      kind: "injected";
      id: string;
      name: string;
      icon?: string;
      provider: Listening;
    }
  | { kind: "walletconnect"; id: "walletconnect"; name: string };

export type Wallet = {
  account: Address | null;
  chainId: number | null;
  error: Notice | null;
  busy: boolean;
  /** The connected wallet, for signing; null until one is connected. */
  provider: EIP1193Provider | null;
  /** Opens the chooser, or connects at once when there is only one way to. */
  connect: () => Promise<void>;
  clearError: () => void;
  options: WalletOption[];
  choosing: boolean;
  choose: (o: WalletOption) => Promise<void>;
  cancel: () => void;
  /** While WalletConnect waits for a wallet: the pairing link, for the QR code and the app links. */
  pairing: string | null;
  /** On WalletConnect, the wallet app's link back to itself, to approve a signature on a phone. */
  walletLink: string | null;
  disconnect: () => Promise<void>;
};

const REMEMBER = "infer-wallet";
const remembered = () => {
  try {
    return localStorage.getItem(REMEMBER);
  } catch {
    return null;
  }
};
const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(REMEMBER, id);
    else localStorage.removeItem(REMEMBER);
  } catch {
    /* private window: the choice is just not kept */
  }
};

/** Browser wallets announced through EIP-6963 (each with its own name and icon), else window.ethereum. */
function useInjected(): WalletOption[] {
  const [found, setFound] = useState<WalletOption[]>([]);
  useEffect(() => {
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent).detail as {
        info?: { uuid: string; name: string; icon?: string; rdns?: string };
        provider?: Listening;
      };
      if (!d?.info || !d.provider) return;
      const o: WalletOption = {
        kind: "injected",
        id: d.info.rdns || d.info.uuid,
        name: d.info.name,
        // An icon is a data: URI by the standard; anything else is not shown (and the CSP would refuse it).
        icon: d.info.icon?.startsWith("data:image/") ? d.info.icon : undefined,
        provider: d.provider,
      };
      setFound((list) =>
        list.some((x) => x.id === o.id) ? list : [...list, o],
      );
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () =>
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);
  return useMemo(
    () =>
      found.length === 0 && window.ethereum
        ? [
            {
              kind: "injected",
              id: "injected",
              name: "Browser wallet",
              provider: window.ethereum,
            },
          ]
        : found,
    [found],
  );
}

/** The site's one wallet, kept above the pages so it stays connected as the visitor moves between them
 *  (soft.tsx). Pages read it with useSiteWallet; the /buy/ card, a page of its own, keeps useWallet. */
const SiteWallet = createContext<Wallet | null>(null);
export function WalletFrame({ children }: { children: ReactNode }) {
  return <SiteWallet.Provider value={useWallet()}>{children}</SiteWallet.Provider>;
}
export function useSiteWallet(): Wallet {
  const w = useContext(SiteWallet);
  if (!w) throw new Error("useSiteWallet outside WalletFrame");
  return w;
}

export function useWallet(): Wallet {
  const [w, setW] = useState<{
    account: Address | null;
    chainId: number | null;
    error: Notice | null;
    provider: Listening | null;
    walletLink: string | null;
  }>({
    account: null,
    chainId: null,
    error: null,
    provider: null,
    walletLink: null,
  });
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [pairing, setPairing] = useState<string | null>(null);
  const injected = useInjected();
  const options: WalletOption[] = [
    ...injected,
    ...(WC_PROJECT_ID
      ? [
          {
            kind: "walletconnect",
            id: "walletconnect",
            name: "WalletConnect",
          } as const,
        ]
      : []),
  ];
  const wcDisconnect = useRef<(() => Promise<void>) | null>(null);

  // Follow the connected wallet's account and chain.
  useEffect(() => {
    const p = w.provider;
    if (!p?.on) return;
    const onAccounts = (a: unknown) => {
      const list = a as string[];
      setW((s) => ({
        ...s,
        account: list[0] ? getAddress(list[0].split(":").pop()!) : null,
      }));
    };
    const onChain = (c: unknown) => setW((s) => ({ ...s, chainId: Number(c) }));
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
  }, [w.provider]);

  // The wallet chosen last time comes back without a prompt: eth_accounts never asks, and a kept
  // WalletConnect session is restored from storage.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    const id = remembered();
    if (!id) return;
    if (id === "walletconnect") {
      if (!WC_PROJECT_ID) return;
      restored.current = true;
      import("./walletconnect")
        .then((m) => m.restore())
        .then((s) => {
          if (!s) return remember(null);
          wcDisconnect.current = s.disconnect;
          setW({
            account: s.account,
            chainId: LAUNCH.chainId,
            error: null,
            provider: s.provider,
            walletLink: s.walletLink,
          });
        })
        .catch(() => remember(null));
      return;
    }
    const o = injected.find((x) => x.id === id);
    if (!o || o.kind !== "injected") return;
    restored.current = true;
    o.provider
      .request({ method: "eth_accounts" })
      .then(async (a) => {
        const list = a as Address[];
        if (!list?.[0]) return;
        const c = Number(await o.provider.request({ method: "eth_chainId" }));
        setW({
          account: getAddress(list[0]),
          chainId: c,
          error: null,
          provider: o.provider,
          walletLink: null,
        });
      })
      .catch(() => undefined);
  }, [injected]);

  // Each attempt has a number; closing the chooser moves the number on, so an attempt still waiting
  // (a WalletConnect pairing nobody scanned, an extension popup left open) can no longer finish: its
  // late result is dropped, and a late WalletConnect session is disconnected rather than kept.
  const attempt = useRef(0);
  async function choose(o: WalletOption) {
    const mine = ++attempt.current;
    const live = () => attempt.current === mine;
    setBusy(true);
    try {
      if (o.kind === "walletconnect") {
        const m = await import("./walletconnect");
        const s = await m.connect((uri) => live() && setPairing(uri));
        if (!live()) return void s.disconnect();
        wcDisconnect.current = s.disconnect;
        setW({
          account: s.account,
          chainId: LAUNCH.chainId,
          error: null,
          provider: s.provider,
          walletLink: s.walletLink,
        });
      } else {
        const p = o.provider;
        const a = (await p.request({
          method: "eth_requestAccounts",
        })) as Address[];
        if (!a?.[0]) throw Error("The wallet authorised no account.");
        const c = Number(await p.request({ method: "eth_chainId" }));
        if (c !== LAUNCH.chainId) {
          await p.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${LAUNCH.chainId.toString(16)}` }],
          });
        }
        if (!live()) return;
        setW({
          account: getAddress(a[0]),
          chainId: LAUNCH.chainId,
          error: null,
          provider: p,
          walletLink: null,
        });
      }
      remember(o.id);
      setChoosing(false);
    } catch (e) {
      if (live()) setW((s) => ({ ...s, error: notice(message(e)) }));
    } finally {
      if (live()) setBusy(false);
      setPairing(null);
    }
  }

  async function connect() {
    if (options.length === 0) {
      setW((s) => ({
        ...s,
        error: notice(
          "No wallet found. Install an Ethereum wallet extension, then reload.",
        ),
      }));
      return;
    }
    if (options.length === 1 && options[0].kind === "injected")
      return choose(options[0]);
    setChoosing(true);
  }

  async function disconnect() {
    await wcDisconnect.current?.();
    wcDisconnect.current = null;
    remember(null);
    setW({
      account: null,
      chainId: null,
      error: null,
      provider: null,
      walletLink: null,
    });
  }

  const clearError = () => setW((s) => ({ ...s, error: null }));
  return {
    account: w.account,
    chainId: w.chainId,
    error: w.error,
    provider: w.provider,
    walletLink: w.walletLink,
    busy,
    connect,
    clearError,
    options,
    choosing,
    choose,
    cancel: () => {
      attempt.current++;
      setChoosing(false);
      setPairing(null);
      setBusy(false);
    },
    pairing,
    disconnect,
  };
}

const isPhone = () =>
  typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** The pairing link as a QR code: crisp squares, scaled by CSS. */
function PairingQr({ uri }: { uri: string }) {
  const { data } = encode(uri, { ecc: "M", border: 2 });
  const n = data.length;
  let d = "";
  data.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      className="wallet-qr"
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="WalletConnect QR code: scan it with your phone wallet"
    >
      {/* Always dark on light, in either theme: some wallet scanners cannot read an inverted code.
          These are the light theme's paper and ink. */}
      <rect width={n} height={n} fill="#f7f5ef" />
      <path d={d} fill="#16202e" />
    </svg>
  );
}

/**
 * The chooser: every browser wallet the page found, and WalletConnect. Picking WalletConnect shows the
 * pairing as a QR code to scan with a phone wallet and, on a phone, buttons that open the wallet app
 * straight onto the pairing. A modal dialog: Escape or Close cancels.
 */
export function WalletChooser({ wallet }: { wallet: Wallet }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (wallet.choosing && !d.open) {
      // Focus the dialog itself: showModal alone lights up its first button.
      d.showModal();
      d.focus();
    }
    if (!wallet.choosing && d.open) d.close();
  }, [wallet.choosing]);
  const phone = isPhone();
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className="wallet-chooser"
      aria-labelledby="wallet-chooser-h"
      onClose={() => wallet.choosing && wallet.cancel()}
      onClick={(e) => e.target === e.currentTarget && wallet.cancel()}
    >
      <header className="wallet-chooser-head">
        <h2 id="wallet-chooser-h">
          {wallet.pairing
            ? phone
              ? "Open your wallet"
              : "Scan with your wallet"
            : "Connect a wallet"}
        </h2>
        <button
          type="button"
          className="wallet-chooser-close"
          aria-label="Close"
          onClick={wallet.cancel}
        >
          ×
        </button>
      </header>
      {wallet.pairing ? (
        <div className="wallet-pairing">
          {phone ? (
            <ul className="wallet-apps">
              {WALLET_APPS.map((a) => (
                <li key={a.name}>
                  <a
                    href={a.link(wallet.pairing!)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open {a.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <PairingQr uri={wallet.pairing} />
          )}
          <button
            type="button"
            className="wallet-copy"
            onClick={() =>
              navigator.clipboard
                ?.writeText(wallet.pairing!)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? "Link copied" : "Copy link"}
          </button>
          <p className="wallet-hint">
            {phone
              ? "Approve in your wallet app, then come back here."
              : "Open your phone wallet's scanner and point it at the code."}
          </p>
        </div>
      ) : (
        <ul className="wallet-options">
          {wallet.options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                disabled={wallet.busy}
                onClick={() => wallet.choose(o)}
              >
                {o.kind === "injected" && o.icon ? (
                  <img src={o.icon} alt="" width="28" height="28" />
                ) : (
                  <span className="wallet-glyph" aria-hidden="true">
                    {o.kind === "walletconnect" ? "◎" : "◇"}
                  </span>
                )}
                {o.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {wallet.error && (
        <p className="wallet-chooser-error" role="alert">
          {wallet.error.text}
        </p>
      )}
    </dialog>
  );
}

// ------------------------------------------------------------------ transactions

export type Tx = {
  id: number;
  label: string;
  status: "idle" | "pending" | "mined" | "failed";
  detail?: string;
  hash?: Hex;
};

/**
 * Simulate, sign, wait for one receipt. Every action on these pages goes through here. A second
 * send while one is in flight is ignored, so two quick clicks cannot start two transactions. A
 * failure after the hash is known keeps the hash: the transaction may well have mined, and the
 * receipt link is how the user finds out before trying again.
 */
export function useTx(onMined: () => void) {
  const [tx, setTx] = useState<Tx>({ id: 0, label: "", status: "idle" });
  const inFlight = useRef(false);
  async function send(label: string, run: () => Promise<Hex>) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++noticeSeq;
    setTx({ id, label, status: "pending" });
    let hash: Hex | undefined;
    try {
      hash = await run();
      setTx({
        id,
        label,
        status: "pending",
        hash,
        detail: "Waiting for the receipt…",
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw Error("The transaction reverted.");
      setTx({ id, label, status: "mined", hash });
      onMined();
    } catch (e) {
      const detail =
        hash && !/reverted/.test(message(e))
          ? `could not confirm it: ${message(e)}`
          : message(e);
      setTx({ id, label, status: "failed", detail, hash });
    } finally {
      inFlight.current = false;
    }
  }
  const clear = () =>
    setTx((t) =>
      t.status === "failed" ? { id: 0, label: "", status: "idle" } : t,
    );
  return { tx, send, clear };
}

/** How long an error stays on screen before it swipes away. */
export const ERROR_LIFETIME_MS = 10_000;

/**
 * An error that leaves by itself: shown for ERROR_LIFETIME_MS, then swiped off to the left and
 * removed, and `onDone` tells the owner to forget it, so the same error can be shown again later.
 * Key it by the notice's serial, so a repeat while one is showing starts a fresh ten seconds. With
 * reduced motion, or with animations disabled altogether, it simply disappears at the end.
 */
export function Vanishing({
  className,
  onDone,
  children,
}: {
  className: string;
  onDone?: () => void;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<"shown" | "leaving" | "gone">("shown");
  useEffect(() => {
    const t = setTimeout(() => setPhase("leaving"), ERROR_LIFETIME_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (phase !== "leaving") return;
    // If no animation ever ends (animations switched off), finish after it would have.
    const t = setTimeout(() => setPhase("gone"), 700);
    return () => clearTimeout(t);
  }, [phase]);
  useEffect(() => {
    if (phase === "gone") onDone?.();
  }, [phase, onDone]);
  if (phase === "gone") return null;
  return (
    <div
      className={`infer-vanish ${className}`}
      data-phase={phase}
      role="alert"
      onAnimationEnd={() => phase === "leaving" && setPhase("gone")}
    >
      {children}
    </div>
  );
}

/** A two-way switch: Buy/Sell, Stake/Unstake. Tabs with arrow keys and one tab stop. */
export function Switch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="infer-switch"
      role="tablist"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const i = options.findIndex(([id]) => id === value);
        const next =
          options[
            (i + (e.key === "ArrowRight" ? 1 : options.length - 1)) %
              options.length
          ][0];
        onChange(next);
        (
          e.currentTarget.querySelector(
            `[data-id="${next}"]`,
          ) as HTMLButtonElement | null
        )?.focus();
      }}
    >
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="tab"
          data-id={id}
          aria-selected={value === id}
          tabIndex={value === id ? 0 : -1}
          onClick={() => onChange(id)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function TxStatus({ tx, onDone }: { tx: Tx; onDone?: () => void }) {
  if (tx.status === "idle") return null;
  if (tx.status === "failed")
    return (
      <Vanishing
        key={tx.id}
        className="infer-tx infer-tx-failed"
        onDone={onDone}
      >
        <b>{tx.label}</b>
        {" · "}
        {tx.detail}
        {tx.hash && (
          <>
            {" · "}
            <a
              href={`https://etherscan.io/tx/${tx.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              receipt ↗
            </a>
          </>
        )}
      </Vanishing>
    );
  return (
    <p className="infer-tx" role="status" data-state={tx.status}>
      <b>{tx.label}</b>
      {" · "}
      {tx.status === "pending"
        ? (tx.detail ?? "confirm in your wallet")
        : tx.status === "mined"
          ? "done"
          : tx.detail}
      {tx.hash && (
        <>
          {" · "}
          <a
            href={`https://etherscan.io/tx/${tx.hash}`}
            target="_blank"
            rel="noreferrer"
          >
            receipt ↗
          </a>
        </>
      )}
    </p>
  );
}

// ------------------------------------------------------------------ shell

export function Shell({
  page,
  depth,
  wallet,
  children,
  className,
}: {
  page: "app" | "claim" | "tokenomics";
  depth: number;
  wallet: Wallet;
  children: ReactNode;
  className?: string;
}) {
  const to = at(depth);
  const link = (id: typeof page, href: string, text: string) => (
    <a href={href} aria-current={page === id ? "page" : undefined}>
      {text}
    </a>
  );
  return (
    <div className={`infer ${className ?? ""}`}>
      <header className="infer-top">
        <a className="infer-mark" href={to("")} aria-label="INFER">
          <Mark />
          INFER
        </a>
        <nav className="infer-nav" aria-label="Site">
          {link("app", to(""), "Trade")}
          {link("claim", to("claim/"), "Claim")}
          {link("tokenomics", to("tokenomics/"), "Tokenomics")}
          <a className="infer-case" href={`${SITE}/`}>
            imdUSD ↗
          </a>
        </nav>
        {LIVE && <InferTicker />}
        <div className="infer-tools">
          <NetworkChip network="Mainnet" state={LIVE ? "live" : "staging"} />
          <ThemeToggle />
          <Vibe suite={INFER_VIBES} />
          <InferSound />
          {/* Disconnected, a Connect button (the amount boxes' "disconnected" label connects too); connected, the
              disconnect box in its place. People looked for the button and missed the label (2026-10-11). */}
          {!wallet.account && (
            <button
              type="button"
              className="infer-head-connect"
              disabled={wallet.busy}
              onClick={() => void wallet.connect()}
            >
              {wallet.busy ? "Connecting…" : "Connect"}
            </button>
          )}
          <DisconnectBox
            connected={!!wallet.account}
            label={wallet.account ? `Disconnect ${wallet.account}` : "Disconnect"}
            onDisconnect={() => void wallet.disconnect()}
          />
        </div>
      </header>
      <WalletChooser wallet={wallet} />
      {wallet.error && !wallet.choosing && (
        <Vanishing
          key={wallet.error.id}
          className="global-notice"
          onDone={wallet.clearError}
        >
          {wallet.error.text}
        </Vanishing>
      )}
      {children}
    </div>
  );
}

/** INFER's price and market cap in the masthead, as on the /buy/ card (launch pool × IMD's ETH pool × ETH/USD,
 * every 30 s while the page is on screen). Dashes until the first read. The market cap links to the launch pool's DexScreener chart. */
function InferTicker() {
  const m = useInferMarket();
  return (
    <p className="infer-ticker" title="INFER in USD: the launch pool, IMD's ETH pool and Chainlink ETH/USD">
      <span className="sr-only">INFER price </span>
      <b className={m ? undefined : "infer-fig-wait"}>{m ? usdPrice(m.priceUsd) : "—"}</b>
      <span className="infer-ticker-cap">
        <span aria-hidden="true">{" · "}</span>
        {/* Only the market cap links out: INFER's launch pool on DexScreener (user, 2026-10-21). */}
        <a className="infer-ticker-link" href={INFER_DEXSCREENER} target="_blank" rel="noreferrer" title="INFER on DexScreener">
          MC <b className={m ? undefined : "infer-fig-wait infer-cap-wait"}>{m ? usdCompact(m.marketCapUsd) : "—"}</b>
          <span className="sr-only"> (chart on DexScreener, opens in a new tab)</span>
        </a>
      </span>
    </p>
  );
}

/** A label and its value joined by a dotted leader, the ledger's own line. */
export function Line({
  k,
  v,
  strong,
}: {
  k: ReactNode;
  v: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className={`infer-line${strong ? " strong" : ""}`}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

// ------------------------------------------------------------------ balances

/**
 * The connected account's balance of each token: a bigint once read, `undefined` while reading or
 * with no account, `null` when the token does not exist yet (its address is unset before launch).
 * `NATIVE` reads the account's ETH.
 */
/**
 * Whether a reader's subject changed since its last read (another account, token or side), as opposed to a timed
 * refresh of the same thing. Readers clear what they show only on a change: a refresh keeps the last figures on
 * screen until the new ones land, so nothing blinks to "…" every interval (it did, every 12 s, on every page).
 */
export function useSubjectChanged(subject: string): () => boolean {
  const last = useRef<string | null>(null);
  return () => {
    const changed = last.current !== subject;
    last.current = subject;
    return changed;
  };
}

export function useBalances(
  account: Address | null,
  list: (Address | null)[],
  tick: number,
) {
  const [out, setOut] = useState<(bigint | null | undefined)[]>(() =>
    list.map(() => undefined),
  );
  const key = list.join(",");
  const changed = useSubjectChanged(`${account}|${key}`);
  useEffect(() => {
    let stale = false;
    if (changed()) setOut(list.map((t) => (t === null ? null : undefined)));
    if (!account) return;
    Promise.all(
      list.map((t) =>
        t === null
          ? Promise.resolve(null)
          : (t === NATIVE
              ? client.getBalance({ address: account })
              : client.readContract({
                  address: t,
                  abi: ERC20,
                  functionName: "balanceOf",
                  args: [account],
                })
            ).catch(() => "failed" as const),
      ),
    ).then((v) => {
      // A read that failed keeps the figure it had: the next refresh tries again.
      if (!stale) setOut((old) => v.map((x, i) => (x === "failed" ? old[i] : x)));
    });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, key, tick]);
  return out;
}

export const useBalance = (
  account: Address | null,
  token: Address | null,
  tick: number,
) => useBalances(account, [token], tick)[0];

/**
 * The balance shown on every input box. Disconnected, or none of the token: it says so. Otherwise
 * the amount, and a click puts the whole balance in the box, every last unit of it.
 */
export function Balance({
  account,
  value,
  symbol,
  decimals,
  onUse,
  wallet,
  hideWhenConnected = false,
}: {
  account: Address | null;
  value: bigint | null | undefined;
  symbol: string;
  decimals: number;
  onUse: (amount: string) => void;
  /** With no account, the label ("disconnected") is the way to connect; on the /buy/ card before launch,
   * the only one. */
  wallet?: Wallet;
  /** The /buy/ card's compact pane: the label is only the way in, so it goes once a wallet is connected. */
  hideWhenConnected?: boolean;
}) {
  if (!account)
    return wallet ? (
      <button
        type="button"
        className="infer-bal infer-bal-use"
        title="Connect a wallet"
        aria-label="Disconnected: connect a wallet"
        onClick={() => void wallet.connect()}
      >
        disconnected
      </button>
    ) : (
      <span className="infer-bal">disconnected</span>
    );
  if (hideWhenConnected) return null;
  if (value === undefined) return <span className="infer-bal">…</span>;
  if (value === null || value === 0n)
    return <span className="infer-bal">No {symbol}</span>;
  return (
    <button
      type="button"
      className="infer-bal infer-bal-use"
      title={`Use the whole balance: ${formatUnits(value, decimals)} ${symbol}`}
      onClick={() => onUse(formatUnits(value, decimals))}
    >
      Max {tokens(value, 4, decimals)} {symbol}
    </button>
  );
}

/** The site mark: the favicon's own pixels (public/favicon.svg), drawn in the text colour so it
 * follows the theme. Read from the file at build time, so the two can never drift apart. */
const MARK =
  favicon.match(/<g style="fill:var\(--text\)">(.*?)<\/g>/)?.[1] ?? "";
export function Mark() {
  return (
    <svg
      className="infer-mark-glyph"
      viewBox="0 0 16 16"
      width="26"
      height="26"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor" dangerouslySetInnerHTML={{ __html: MARK }} />
    </svg>
  );
}
