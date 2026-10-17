import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Landing } from "./Landing";
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Landing });
