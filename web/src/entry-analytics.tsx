import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Analytics } from "./Analytics";
import "./style.css";
import { initializeTheme } from "./theme";
import { startVibe } from "./vibe";
import { IMDUSD_VIBES } from "./vibe-imdusd";
initializeTheme();
// The background starts before React renders, so this page's first paint carries it (vibe.tsx).
startVibe(IMDUSD_VIBES);
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Analytics });
