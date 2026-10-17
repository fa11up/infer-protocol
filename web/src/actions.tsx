import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  Children,
  type ReactNode,
} from "react";
import { type Address, type Hex, formatUnits } from "viem";
import type { Target } from "./config";
import { Ticker } from "./motion";
import { amount, address, uint, message, fmt } from "./math";
import type { Failure } from "./explain";
import { Who } from "./ens";
export type Request = {
  target: Target;
  fn: string;
  args: readonly unknown[];
  summary: string;
  /** Shown above the confirm button in the review: a risk the viewer should see before signing. */
  warning?: string;
  /** Figures only this call site knows, e.g. an inspected borrower's ratio. */
  explain?: (f: Failure) => string | undefined;
  /** Calls that must land first, usually approvals. With them the review lists every step, and confirming sends
   * them and this call as one batch when the wallet can (one signature), or one after another when it cannot. */
  before?: Call[];
  /** This call's line in the step list when `before` is set. */
  label?: string;
};
/** One call of a multi-step action (the leverage window's rounds). */
export type Call = {
  target: Target;
  fn: string;
  args: readonly unknown[];
  /** What the step does, in the progress list and the status line. */
  label: string;
  /** Calldata built elsewhere (a 0x swap): sent to `target.address` as is, and `fn`/`args` only name it. */
  data?: Hex;
  /** Ether sent with the call (a swap that sells ETH). */
  value?: bigint;
};
export type Sequence = {
  calls: Call[];
  /** Send every call as one atomic EIP-5792 batch (one signature, all or nothing) instead of one by one. */
  batch: boolean;
  /** After each confirmed step (or the whole batch): how many are done. */
  onStep?: (done: number) => void;
};
export type Actions = {
  ready: boolean;
  busy: string;
  reason: string;
  run: (id: string, request: Request) => Promise<void>;
  /** Simulates and sends `calls` in order from the connected wallet, then refreshes. The caller shows the review. */
  sequence?: (id: string, seq: Sequence) => Promise<Hex | undefined>;
  account?: Address;
  /** The wallet can send an atomic EIP-5792 batch (one signature, all or nothing). Undefined while unknown. */
  atomic?: boolean;
};
/** How long an action's error stays before it slides away. */
export const ERROR_LIFETIME_MS = 10_000;
const ERROR_EXIT_MS = 320;
/**
 * An error from something the viewer did: shown at once, then after ERROR_LIFETIME_MS it swipes out to the
 * left (with reduced motion it simply goes) and `onDone` clears it. A new message starts the clock again.
 * Standing problems with the chain or the wallet do not use this: they stay until they are resolved.
 */
export function FadingError({
  text,
  onDone,
  role = "alert",
}: {
  text: string;
  onDone: () => void;
  /** "none" when the parent is already a live region, so the message is announced once. */
  role?: "alert" | "status" | "none";
}) {
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    setLeaving(false);
    if (!text) return;
    const out = setTimeout(() => setLeaving(true), ERROR_LIFETIME_MS);
    const gone = setTimeout(() => done.current(), ERROR_LIFETIME_MS + ERROR_EXIT_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
  }, [text]);
  if (!text) return null;
  return (
    <span className="fading-wrap">
      <span role={role === "none" ? undefined : role} className={`fading-error${leaving ? " is-leaving" : ""}`}>
        {text}
      </span>
    </span>
  );
}
export function Action({
  id,
  label,
  actions,
  request,
  disabled = false,
  reason = "",
}: {
  id: string;
  label: string;
  actions: Actions;
  request: () => Request;
  disabled?: boolean;
  reason?: string;
}) {
  const [error, setError] = useState("");
  return (
    <div className="action">
      <button
        type="button"
        disabled={!actions.ready || !!actions.busy || disabled}
        onClick={async () => {
          setError("");
          try {
            await actions.run(id, request());
          } catch (e) {
            setError(message(e));
          }
        }}
      >
        {actions.busy === id ? "Processing…" : label}
      </button>
      <p className="action-note">
        {error ? (
          <FadingError text={error} onDone={() => setError("")} />
        ) : disabled ? (
          reason
        ) : !actions.ready ? (
          actions.reason
        ) : (
          ""
        )}
      </p>
    </div>
  );
}
/** What a box can take from: the wallet's balance of its token, or another available amount. */
export type Balance = {
  /** A wallet is connected. */
  connected: boolean;
  amount?: bigint;
  symbol: string;
  decimals: number;
  /** "Wallet" unless the amount is something else, such as "Available". */
  label?: string;
};
/** How an amount box's "Disconnected" label connects a wallet: it is the terminal's only way in. */
export const ConnectWallet = createContext<{ connect: () => void; connecting: boolean } | null>(null);

/**
 * The balance on an amount box's label line. Connected with some: a button showing it to two decimals, which
 * fills the box with the exact amount (every decimal). Otherwise "Disconnected" or "No <symbol>".
 */
export function BalanceHint({ b, onUse }: { b: Balance; onUse: (text: string) => void }) {
  const wallet = useContext(ConnectWallet);
  if (!b.connected)
    return wallet ? (
      <button
        type="button"
        className="balance-hint balance-use balance-connect"
        title="Connect a wallet"
        aria-label="Disconnected: connect a wallet"
        disabled={wallet.connecting}
        onClick={wallet.connect}
      >
        {wallet.connecting ? "Connecting…" : "Disconnected"}
      </button>
    ) : (
      <span className="balance-hint">Disconnected</span>
    );
  if (!b.amount) return <span className="balance-hint">{b.label && b.label !== "Wallet" ? `No ${b.symbol} available` : `No ${b.symbol}`}</span>;
  const label = b.label ?? "Wallet";
  const exactText = formatUnits(b.amount, b.decimals);
  return (
    <button
      type="button"
      className="balance-hint balance-use"
      title={`${exactText} ${b.symbol}`}
      aria-label={`Use ${label.toLowerCase()} amount: ${exactText} ${b.symbol}`}
      onClick={() => onUse(exactText)}
    >
      {fmt(b.amount, b.decimals, 2)} {b.symbol}
    </button>
  );
}
export type Field = {
  name: string;
  kind: "amount" | "amount0" | "address" | "uint";
  default?: string;
  /** Token decimals for an amount; 18 unless the token says otherwise (sIMD has 24). */
  decimals?: number;
  /** The amount this box can take, shown under it and filled in on click. */
  balance?: Balance;
  /** The most this box accepts; more is refused before anything is sent, with this message. */
  max?: { value: bigint; message: string };
};
export function ActionForm({
  id,
  label,
  actions,
  target,
  fn,
  fields = [],
  summary,
  disabled = false,
  reason = "",
  mapArgs,
  explain,
  warn,
  after,
}: {
  id: string;
  label: string;
  actions: Actions;
  target?: Target;
  fn: string;
  fields?: Field[];
  summary: string;
  disabled?: boolean;
  reason?: string;
  mapArgs?: (v: any[]) => readonly unknown[];
  explain?: Request["explain"];
  /** From the parsed inputs: a warning for the review, or undefined. */
  warn?: (args: unknown[]) => string | undefined;
  /** From the inputs as typed (once they parse): shown below the button, before anything is sent. */
  after?: (args: unknown[]) => ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState("");
  // The after-action preview replaces the one-line summary while it shows: the review repeats the summary.
  const preview = after ? afterFor(fields, values, after) : null;
  return (
    <form
      className="action-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setInvalidField("");
        try {
          if (!target) throw Error("Contract has not loaded.");
          const args = fields.map((f) => {
            const t = values[f.name] ?? f.default ?? "";
            try {
              const v =
                f.kind === "address"
                  ? address(t)
                  : f.kind === "amount"
                    ? amount(t, f.decimals ?? 18)
                    : f.kind === "amount0"
                      ? amount(t, 18, true)
                      : uint(t);
              if (f.max && typeof v === "bigint" && v > f.max.value) throw Error(f.max.message);
              return v;
            } catch (error) {
              setInvalidField(f.name);
              (
                e.currentTarget.elements.namedItem(
                  `${id}-${f.name}`,
                ) as HTMLInputElement
              )?.focus();
              throw error;
            }
          });
          await actions.run(id, {
            target,
            fn,
            args: mapArgs ? mapArgs(args) : args,
            explain,
            warning: warn?.(args),
            summary: `${summary}${args.length ? " Inputs: " + fields.map((f, i) => `${f.name}: ${values[f.name] ?? f.default ?? ""}`).join("; ") : ""}`,
          });
        } catch (e) {
          setError(message(e));
        }
      }}
    >
      {fields.map((f) => (
        <div key={f.name} className="field">
          <label>
            {f.name}
            <input
              name={`${id}-${f.name}`}
              aria-invalid={invalidField === f.name || undefined}
              aria-describedby={`${id}-feedback`}
              inputMode={f.kind === "address" ? "text" : "decimal"}
              autoComplete="off"
              spellCheck={false}
              required
              value={values[f.name] ?? f.default ?? ""}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          </label>
          {f.balance && (
            <BalanceHint b={f.balance} onUse={(text) => setValues({ ...values, [f.name]: text })} />
          )}
        </div>
      ))}
      <button
        type="submit"
        disabled={!actions.ready || !!actions.busy || disabled || !target}
      >
        {actions.busy === id ? "Processing…" : label}
      </button>
      {preview}
      <p id={`${id}-feedback`} className="action-note">
        {error ? (
          <FadingError text={error} onDone={() => setError("")} />
        ) : disabled ? (
          reason
        ) : !actions.ready ? (
          actions.reason
        ) : preview ? (
          ""
        ) : (
          summary
        )}
      </p>
    </form>
  );
}
/** `after` for the fields as typed, or nothing while any of them does not parse. */
function afterFor(fields: Field[], values: Record<string, string>, after: (args: unknown[]) => ReactNode): ReactNode {
  const args: unknown[] = [];
  for (const f of fields) {
    const t = values[f.name] ?? f.default ?? "";
    if (!t.trim()) return null;
    try {
      args.push(
        f.kind === "address"
          ? address(t)
          : f.kind === "amount"
            ? amount(t, f.decimals ?? 18)
            : f.kind === "amount0"
              ? amount(t, 18, true)
              : uint(t),
      );
    } catch {
      return null;
    }
  }
  return after(args);
}
export function Pane({
  id,
  index,
  title,
  tag,
  desk = false,
  monitor = false,
  columns = desk,
  children,
}: {
  id: string;
  index: string;
  title: string;
  tag?: string;
  /** A desk pane is a tab panel of actions, laid out to fit without scrolling. */
  desk?: boolean;
  /** A monitor pane is a tab panel of reads, also laid out to fit. */
  monitor?: boolean;
  /** Lay the body out as two columns. */
  columns?: boolean;
  children: ReactNode;
}) {
  const tabbed = desk || monitor;
  return (
    <section
      className={`pane pane-${id}${desk ? " desk-pane" : ""}${monitor ? " monitor-pane" : ""}`}
      aria-labelledby={`${id}-heading`}
      id={tabbed ? `${id}-panel` : undefined}
      role={tabbed ? "tabpanel" : undefined}
    >
      <header className="pane-head">
        <h2 id={`${id}-heading`}>
          <span>{index}</span> {title}
        </h2>
        <span className="tag">{tag}</span>
      </header>
      <div
        className={`pane-body${columns ? " desk-body" : ""}${monitor ? " monitor-body" : ""}`}
      >
        {children}
      </div>
    </section>
  );
}
/** A row of tabs; arrow keys move between them. */
export function Tabs({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: readonly (readonly [string, string])[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="desk-tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, text], i) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`tab-${id}`}
          aria-selected={value === id}
          aria-controls={`${id}-panel`}
          tabIndex={value === id ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(e) => {
            const step =
              e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            const next = tabs[(i + step + tabs.length) % tabs.length][0];
            onChange(next);
            document.getElementById(`tab-${next}`)?.focus();
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
/** One of several alternative actions; only the chosen one is drawn, so the column never grows. */
export function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [string, string])[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="choice" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
/**
 * Props for a modal <dialog> that closes on a click outside its box (on the backdrop). Only a press that both starts
 * and ends outside counts, so selecting text inside and releasing past the edge does not close it. `close` decides
 * whether closing is allowed (a window mid-transaction stays open).
 */
export function useBackdropClose(close: () => void) {
  const downOutside = useRef(false);
  const outside = (e: { currentTarget: HTMLDialogElement; target: EventTarget; clientX: number; clientY: number }) => {
    if (e.target !== e.currentTarget) return false;
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLDialogElement>) => {
      downOutside.current = outside(e);
    },
    onClick: (e: React.MouseEvent<HTMLDialogElement>) => {
      if (downOutside.current && outside(e)) close();
      downOutside.current = false;
    },
  };
}
export function Col({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="desk-col">
      <div className="section-label">{label}</div>
      {children}
    </div>
  );
}
export function Row({
  label,
  info,
  children,
}: {
  label: string;
  /** Explanation shown on hover or focus, so the pane itself lists only figures. */
  info?: string;
  children: ReactNode;
}) {
  const parts = Children.toArray(children);
  const text = parts.every(
    (x) => typeof x === "string" || typeof x === "number",
  )
    ? parts.join("")
    : undefined;
  return (
    <div className="row">
      <span>
        {label}
        {info && <Info label={label} text={info} />}
      </span>
      <strong>{text === undefined ? children : <Ticker text={text} />}</strong>
    </div>
  );
}
/**
 * An "i" that opens a small window on hover, focus or tap. The window is fixed to the viewport
 * rather than the pane, so a scrolling pane can never clip it.
 */
export function Info({ label, text }: { label: string; text: string }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; above: boolean }>();
  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const above = r.top > innerHeight / 2;
    setAt({
      x: Math.min(Math.max(r.left + r.width / 2, 150), innerWidth - 150),
      y: above ? r.top - 6 : r.bottom + 6,
      above,
    });
  };
  const hide = () => setAt(undefined);
  // QA-02: leaving the icon starts a short delay instead of closing at once, so the pointer can
  // cross onto the window and read it (WCAG 1.4.13, hoverable). Entering the window cancels it.
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stay = () => clearTimeout(leaving.current);
  const leave = () => {
    clearTimeout(leaving.current);
    leaving.current = setTimeout(hide, 180);
  };
  useEffect(() => {
    if (!at) return;
    // A fixed window would drift from its icon once the pane scrolls, so close it instead.
    addEventListener("scroll", hide, true);
    addEventListener("resize", hide);
    return () => {
      removeEventListener("scroll", hide, true);
      removeEventListener("resize", hide);
    };
  }, [at]);
  return (
    <span className="info">
      <button
        ref={button}
        type="button"
        className="info-button"
        aria-label={`About ${label}`}
        aria-describedby={id}
        aria-expanded={!!at}
        onMouseEnter={() => {
          stay();
          show();
        }}
        onMouseLeave={leave}
        onFocus={show}
        onBlur={hide}
        onClick={() => (at ? hide() : show())}
        onKeyDown={(e) => {
          if (e.key === "Escape") hide();
        }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M8 1.25a6.75 6.75 0 1 0 0 13.5a6.75 6.75 0 1 0 0-13.5z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          />
          <path
            d="M8 7v4.25M8 4.75v.01"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span
        role="tooltip"
        id={id}
        className="tooltip"
        hidden={!at}
        onMouseEnter={stay}
        onMouseLeave={leave}
        style={
          at
            ? {
                left: at.x,
                top: at.y,
                transform: `translate(-50%, ${at.above ? "-100%" : "0"})`,
              }
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}
export function AddressLink({
  value,
  explorer,
  label,
}: {
  value?: Address;
  explorer: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  return value ? (
    <span className="address">
      <a
        href={`${explorer}/address/${value}`}
        target="_blank"
        rel="noreferrer"
        title={value}
      >
        {label} ↗ <Who address={value} />
      </a>
      <button
        type="button"
        aria-label={`Copy ${label} address`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  ) : (
    <span>—</span>
  );
}
/**
 * A dropdown drawn by the page. A native <select> can be styled closed, but its open list is drawn
 * by the operating system, so it never matched the terminal. This keeps the native keyboard model:
 * Enter, Space or the arrows open it; arrows move; Enter selects; Escape and Tab close it.
 * The list is fixed to the viewport, so a scrolling pane cannot clip it.
 */
export function Select({
  id,
  label,
  value,
  options,
  onChange,
  showLabel = true,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  showLabel?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  }>();
  const [active, setActive] = useState(0);
  const index = Math.max(
    0,
    options.findIndex(([v]) => v === value),
  );
  const open = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const below =
      innerHeight - r.bottom > Math.min(260, options.length * 32 + 8);
    setAt({
      left: r.left,
      width: r.width,
      ...(below ? { top: r.bottom - 1 } : { bottom: innerHeight - r.top - 1 }),
    });
    setActive(index);
  };
  const close = (refocus = true) => {
    setAt(undefined);
    if (refocus) button.current?.focus();
  };
  const pick = (i: number) => {
    onChange(options[i][0]);
    close();
  };
  useEffect(() => {
    if (!at) return;
    list.current?.focus({ preventScroll: true });
    const outside = (e: MouseEvent) => {
      if (
        !list.current?.contains(e.target as Node) &&
        !button.current?.contains(e.target as Node)
      )
        close(false);
    };
    const away = () => close(false);
    // The list's own scrolling must not close it; only the page or a pane moving under it does.
    const scrolled = (e: Event) => {
      if (e.target !== list.current) away();
    };
    addEventListener("mousedown", outside);
    addEventListener("resize", away);
    addEventListener("scroll", scrolled, true);
    return () => {
      removeEventListener("mousedown", outside);
      removeEventListener("resize", away);
      removeEventListener("scroll", scrolled, true);
    };
  }, [at]);
  useEffect(() => {
    // Keep the active option in view by scrolling the list alone, never its ancestors.
    const box = list.current;
    const item = box?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!box || !item) return;
    if (item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
    else if (
      item.offsetTop + item.offsetHeight >
      box.scrollTop + box.clientHeight
    )
      box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
  }, [active, at]);
  return (
    <div className="select">
      <span
        id={`${id}-label`}
        className={showLabel ? "select-label" : "sr-only"}
      >
        {label}
      </span>
      <button
        ref={button}
        id={id}
        type="button"
        className="select-button"
        aria-haspopup="listbox"
        aria-expanded={!!at}
        aria-controls={`${id}-list`}
        aria-labelledby={`${id}-label ${id}`}
        onClick={() => (at ? close() : open())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
            e.preventDefault();
            open();
          }
        }}
      >
        <span>{options[index]?.[1]}</span>
      </button>
      {at && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={`${id}-label`}
          aria-activedescendant={`${id}-option-${active}`}
          className="select-list"
          style={{
            left: Math.min(at.left, innerWidth - Math.max(at.width, 180) - 8),
            minWidth: at.width,
            top: at.top,
            bottom: at.bottom,
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(options.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Home") {
              e.preventDefault();
              setActive(0);
            } else if (e.key === "End") {
              e.preventDefault();
              setActive(options.length - 1);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pick(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Tab") close(false);
          }}
        >
          {options.map(([v, text], i) => (
            <li
              key={v}
              id={`${id}-option-${i}`}
              data-index={i}
              role="option"
              aria-selected={v === value}
              className={i === active ? "is-active" : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              {text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
