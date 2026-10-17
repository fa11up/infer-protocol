import { softSite } from "./soft";
import { IMDUSD_ROUTES } from "./routes-imdusd";
import { Docs } from "./Docs";
softSite({ routed: true, mode: "swap", routes: IMDUSD_ROUTES, initial: Docs });
