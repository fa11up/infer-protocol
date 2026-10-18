import { softSite } from "./soft";
import { INFER_ROUTES, inferFrame } from "./infer/routes";
import { Tokenomics } from "./infer/Tokenomics";
softSite({ routed: true, mode: "keep", routes: INFER_ROUTES, initial: Tokenomics, frame: inferFrame });
