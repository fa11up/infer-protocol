import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Analytics } from "./Analytics";
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Analytics });
