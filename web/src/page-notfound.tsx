import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { NotFound } from "./NotFound";
softSite({ routed: false, mode: "swap", routes: IMDUSD_ROUTES, initial: NotFound });
