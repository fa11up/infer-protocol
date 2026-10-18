import { softSite } from "./soft";
import { INFER_ROUTES, inferFrame } from "./infer/routes";
import { Claim } from "./infer/Claim";
softSite({ routed: true, mode: "keep", routes: INFER_ROUTES, initial: Claim, frame: inferFrame });
