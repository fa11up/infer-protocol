import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Build } from "./Build";
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Build });
