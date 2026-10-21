import { softSite } from "./soft";
import { BLOG_ROUTES } from "./routes-blog";
import { Blog } from "./Blog";
// The not-found page is the same shell served at any address: it is not one of the routes.
const routed = !document.querySelector('meta[name="robots"][content="noindex"]');
softSite({ routed, mode: "swap", routes: BLOG_ROUTES, initial: Blog });
