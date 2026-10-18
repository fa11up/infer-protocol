import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Links } from "./Links";
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Links });
