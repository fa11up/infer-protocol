// The theme without React: what each page's first script runs before its first paint (boot), and the state
// the header's toggle (theme.tsx) reads.

type Theme = "light" | "dark";
const key = "comp-terminal-theme";
const system = window.matchMedia("(prefers-color-scheme: dark)");
let choice: Theme | null = null;
try {
  const saved = localStorage.getItem(key);
  if (saved === "light" || saved === "dark") choice = saved;
} catch {
  /* Storage may be disabled; the toggle still works for this visit. */
}
let current: Theme;
const listeners = new Set<() => void>();
function apply() {
  document.documentElement.classList.add("theme-changing");
  current = choice ?? (system.matches ? "dark" : "light");
  document.documentElement.dataset.theme = current;
  const style = getComputedStyle(document.documentElement);
  // Both media-scoped tags take the active theme's ground, so an explicit choice beats the OS.
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) =>
      m.setAttribute("content", style.getPropertyValue("--bg").trim()),
    );
  // The favicon follows an explicit choice too, not just the OS preference. Same mark as
  // public/favicon.svg; public-check fails the build if the two drift apart.
  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="${style.getPropertyValue("--bg").trim()}"/><g fill="${style.getPropertyValue("--text").trim()}"><rect x="5" y="4" width="7" height="1"/><rect x="8" y="4" width="1" height="8"/><rect x="5" y="11" width="7" height="1"/><rect x="4" y="4" width="1" height="1" fill-opacity=".5"/><rect x="12" y="4" width="1" height="1" fill-opacity=".5"/><rect x="4" y="11" width="1" height="1" fill-opacity=".5"/><rect x="12" y="11" width="1" height="1" fill-opacity=".5"/><rect x="5" y="7" width="3" height="2" fill-opacity=".5"/><rect x="9" y="7" width="3" height="2" fill-opacity=".5"/><rect x="4" y="7" width="1" height="2" fill-opacity=".25"/><rect x="12" y="7" width="1" height="2" fill-opacity=".25"/></g></svg>`;
  document
    .querySelector('link[rel="icon"]')
    ?.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(icon)}`);
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() =>
    document.documentElement.classList.remove("theme-changing"),
  );
  listeners.forEach((fn) => fn());
}
system.addEventListener("change", () => {
  if (!choice) apply();
});
window.addEventListener("storage", (event) => {
  if (event.key === key) {
    choice =
      event.newValue === "light" || event.newValue === "dark"
        ? event.newValue
        : null;
    apply();
  }
});
export function initializeTheme() {
  apply();
}
/** The active theme, and a way to hear it change (theme.tsx's toggle). */
export const themeNow = () => current;
export function onTheme(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
/** An explicit choice, remembered. */
export function chooseTheme(next: Theme) {
  choice = next;
  try {
    localStorage.setItem(key, choice);
  } catch {
    /* Optional persistence. */
  }
  apply();
}
