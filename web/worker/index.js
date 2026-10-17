// imdusd.com's Worker. Cloudflare serves every file straight from its cache without invoking it, except /rpc
// and /swap/* (run_worker_first in wrangler.jsonc): the terminal's own Ethereum RPC (worker/rpc.js), cached per block,
// keyed upstreams, an allowlist of the deployment's contracts, plus the event logs its loan book reads.
//
// The redirects below are now the zone's "Always Use HTTPS" setting and a www -> imdusd.com Redirect Rule, so
// they never run for pages. Kept as the fallback if those are ever switched off: set run_worker_first back to
// true in wrangler.jsonc and this restores them.
import { handleRpc } from "./rpc.js";
import { handleSwap } from "./swap.js";

const HOST = "imdusd.com";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // One host for crawlers and caches: www. and plain http both land on https://imdusd.com.
    if (url.protocol === "http:" || url.hostname === `www.${HOST}`) {
      url.protocol = "https:";
      if (url.hostname === `www.${HOST}`) url.hostname = HOST;
      return Response.redirect(url.toString(), 301);
    }
    // The Trade tab's 0x quotes (worker/swap.js): the key stays here, the fee is set here.
    if (url.pathname.startsWith("/swap/")) return handleSwap(request, env);
    // Only a build that ships rpc-allow.json (the launch build, with the terminal) serves it; otherwise 404.
    if (url.pathname === "/rpc") return handleRpc(request, env, {}, { logs: true, pages: "the imdUSD terminal" });
    return env.ASSETS.fetch(request);
  },
};
