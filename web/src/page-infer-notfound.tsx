import { softSite } from "./soft";
import { INFER_ROUTES, inferFrame } from "./infer/routes";
import { NotFound } from "./infer/NotFound";
softSite({ routed: false, mode: "keep", routes: INFER_ROUTES, initial: NotFound, frame: inferFrame });
