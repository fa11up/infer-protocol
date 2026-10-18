// A site's sound button whose score loads once the page is idle, or at once if the visitor left the sound on (so
// it carries on from the last page). The score and its voices are code no first paint needs. Until it arrives the
// button is drawn as it is when off, and a press on it is kept and turns the sound on when the code arrives.
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";

type Button = ComponentType<{ takeAsked: () => boolean }>;

/** The lazy button for one site: `key` is where its score keeps the visitor's on/off (score.tsx). */
export function lazySound(key: string, load: () => Promise<{ default: Button }>) {
  const SoundButton = lazy(load);
  let asked = false;
  const takeAsked = () => {
    const was = asked;
    asked = false;
    return was;
  };
  const wasOn = () => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  return function LazySound() {
    const [ready, setReady] = useState(wasOn);
    useEffect(() => {
      if (ready) return;
      if (typeof requestIdleCallback === "function") {
        const id = requestIdleCallback(() => setReady(true), { timeout: 4000 });
        return () => cancelIdleCallback(id);
      }
      const id = setTimeout(() => setReady(true), 1500);
      return () => clearTimeout(id);
    }, [ready]);
    const placeholder = (
      <button
        type="button"
        className="theme-toggle score-toggle"
        aria-label="Sound off. Turn sound on."
        aria-pressed={false}
        title="Sound off. Turn sound on."
        data-state="off"
        onClick={() => {
          asked = true;
          setReady(true);
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
            <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
            <path d="M15.5 10l4 4M19.5 10l-4 4" strokeLinecap="round" />
          </g>
        </svg>
      </button>
    );
    return ready ? (
      <Suspense fallback={placeholder}>
        <SoundButton takeAsked={takeAsked} />
      </Suspense>
    ) : (
      placeholder
    );
  };
}
