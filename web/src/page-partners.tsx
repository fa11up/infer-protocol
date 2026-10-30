import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Partners } from "./Partners";
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Partners });
