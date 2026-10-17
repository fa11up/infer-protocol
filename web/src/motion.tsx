import { createContext, useContext, useEffect, useRef, useState } from "react";
// The existing CSS curve: cubic-bezier(.2, 0, 0, 1).
function ease(t: number) {
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 12; i++) {
    const u = (lo + hi) / 2;
    const x = 0.6 * (1 - u) * (1 - u) * u + u * u * u;
    if (x < t) lo = u;
    else hi = u;
  }
  const u = (lo + hi) / 2;
  return 3 * (1 - u) * u * u + u * u * u;
}
/**
 * Figures inside a window (the leverage and liquidity windows) are read while they are being acted on: they
 * change on every 15-second refresh and on every keystroke, and the count-up animation made them roll through
 * values that were never true. Inside this provider a Ticker shows its text as is.
 */
export const StillFigures = createContext(false);

export function Ticker({ text }: { text: string }) {
  const still = useContext(StillFigures);
  const [shown, setShown] = useState(text);
  const previous = useRef(text);
  useEffect(() => {
    const from = previous.current;
    previous.current = text;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const pattern = /\d[\d,]*(?:\.\d+)?/g;
    const a = from.match(pattern),
      b = text.match(pattern);
    if (
      motion.matches ||
      still ||
      !a ||
      !b ||
      a.length !== b.length ||
      from.replace(pattern, "#") !== text.replace(pattern, "#")
    ) {
      setShown(text);
      return;
    }
    const start = performance.now();
    const duration = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--fast"),
    );
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      setShown(text);
    };
    const tick = (now: number) => {
      const elapsed = Math.min(1, (now - start) / duration);
      let i = 0;
      setShown(
        elapsed === 1
          ? text
          : text.replace(pattern, (target) => {
              const old = Number(a[i++].replaceAll(",", ""));
              const next = Number(target.replaceAll(",", ""));
              const places = target.split(".")[1]?.length ?? 0;
              return (old + (next - old) * ease(elapsed)).toLocaleString(
                "en-US",
                {
                  minimumFractionDigits: places,
                  maximumFractionDigits: places,
                  useGrouping: target.includes(","),
                },
              );
            }),
      );
      if (elapsed < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    motion.addEventListener("change", stop);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", stop);
    };
  }, [text, still]);
  if (!/\d/.test(text)) return <>{text}</>;
  return (
    <span className="ticker">
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
