import { useSyncExternalStore } from "react";
import { chooseTheme, onTheme, themeNow } from "./theme-core";
export { initializeTheme } from "./theme-core";

export function ThemeToggle() {
  const theme = useSyncExternalStore(onTheme, themeNow);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Use ${next} theme`}
      title={`Use ${next} theme`}
      onClick={() => chooseTheme(next)}
    >
      {/* The icon names the theme a click switches to, as on imd.fun. */}
      <svg
        viewBox="0 0 20 20"
        width="20"
        height="20"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {next === "dark" ? (
          <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" />
        ) : (
          <>
            <circle cx="10" cy="10" r="3.25" />
            <path d="M10 2.5v1.75M10 15.75v1.75M2.5 10h1.75M15.75 10h1.75M4.7 4.7l1.24 1.24M14.06 14.06l1.24 1.24M4.7 15.3l1.24-1.24M14.06 5.94l1.24-1.24" />
          </>
        )}
      </svg>
    </button>
  );
}
