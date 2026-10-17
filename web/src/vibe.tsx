// The background's header button. The engine (shaders, canvas, clock, choice) is vibe-core.ts.
import { useEffect, useSyncExternalStore } from "react";
import { startVibe, vibeStore, type Suite } from "./vibe-core";
export { startVibe, vibeStore, type Scene, type Store, type Suite } from "./vibe-core";

/** The header button: shows the current scene's glyph and switches to the next scene. */
export function Vibe({ suite }: { suite: Suite }) {
  useEffect(() => startVibe(suite), [suite]);
  const s = vibeStore(suite);
  const vibe = useSyncExternalStore(s.subscribe, s.get);
  const i = Math.max(
    0,
    suite.scenes.findIndex((v) => v.id === vibe),
  );
  const next = suite.scenes[(i + 1) % suite.scenes.length];
  const label = `Background: ${suite.scenes[i].label}. Switch background to ${next.label}.`;
  return (
    <>
      <button
        type="button"
        className="theme-toggle vibe-toggle"
        aria-label={label}
        title={label}
        data-vibe={vibe}
        onClick={() => s.set(next.id)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
        >
          {suite.scenes[i].icon}
        </svg>
      </button>
    </>
  );
}

