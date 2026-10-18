import { softSite } from "./soft";
import { INFER_ROUTES, inferFrame } from "./infer/routes";
import { App } from "./infer/App";
softSite({ routed: true, mode: "keep", routes: INFER_ROUTES, initial: App, frame: inferFrame });
