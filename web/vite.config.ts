import { defineConfig, type Plugin, type UserConfig } from "vite";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
// @ts-expect-error plain ESM build script without types
import { renderDocs, socialTags } from "./scripts/docs-pages.mjs";
// @ts-expect-error plain ESM build script without types
import { inferLlms } from "./scripts/infer-llms.mjs";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
// Three static pages: the landing page, the terminal and the docs. Plain files at /, /terminal/
// and /docs/, so the export needs no rewrite rules on whatever host serves imdusd.com.
// `vite build --mode public` is the site on imdusd.com: the homepage and docs only. The terminal is
// not built, every link to it is replaced (site.tsx TERMINAL), the install manifest opens the homepage,
// and Cloudflare gets security headers, a not-found page and a redirect for any old /terminal link.
const SITE = "https://imdusd.com";
// THE LAUNCH BUILD: the same public site with the terminal in it. `VITE_TERMINAL=1 vite build --mode public`
// (npm run build:launch) ships the terminal page, its deployment file and ABIs, the docs unredacted, and no
// /terminal redirect; the Content-Security-Policy then admits exactly the hosts the terminal reads from
// (launchConnect below), and public-check --launch verifies all of it.
const LAUNCH = process.env.VITE_TERMINAL === "1";
/** Blockscout's API origin per chain, as the terminal's history fallback uses it (src/config.ts). */
const BLOCKSCOUT: Record<number, string> = {
  1: "https://eth.blockscout.com",
  11155111: "https://eth-sepolia.blockscout.com",
};
/** IdentityMD's public API, read by the analytics page for the swarm's size (src/analytics-data.ts). */
const IMD_API = "https://api.imd.fun";
/** Every origin the terminal connects to: the deployment's RPCs, the mainnet readers' RPCs (market price,
 * ENS), the archive gateways and the chain's Blockscout. Read from the same files the terminal reads, so they cannot disagree. */
function launchConnect(): string[] {
  const deployment = JSON.parse(readFileSync(resolve(import.meta.dirname, "deployment-source.json"), "utf8"));
  const ens: string[] = JSON.parse(readFileSync(resolve(import.meta.dirname, "src/ens-rpc.json"), "utf8"));
  // Keyless archive gateways the terminal reads old log windows and past state from (src/archive-rpc.json).
  const archive: string[] = JSON.parse(readFileSync(resolve(import.meta.dirname, "src/archive-rpc.json"), "utf8"))[deployment.chainId] ?? [];
  const origins = [...deployment.network.rpcUrls, ...ens, ...archive].map((u: string) => new URL(u).origin);
  if (BLOCKSCOUT[deployment.chainId]) origins.push(BLOCKSCOUT[deployment.chainId]);
  // The analytics page's swarm strip reads IdentityMD's public /swarm (CORS-open).
  origins.push(IMD_API);
  return [...new Set(origins)];
}
/**
 * The contracts imdusd.com/rpc (worker/rpc.js) serves for the terminal: the deployment's own and its OracleAsker,
 * the linked contracts in rpc-allow-terminal.json, every address in the terminal's source, and Multicall3, which
 * bundles its reads. Anything else is refused (and logged by the Worker).
 */
function terminalRpcAllow(): string[] {
  const deployment = JSON.parse(readFileSync(resolve(import.meta.dirname, "deployment-source.json"), "utf8"));
  const extra = JSON.parse(readFileSync(resolve(import.meta.dirname, "rpc-allow-terminal.json"), "utf8"));
  const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
  const src = resolve(import.meta.dirname, "src");
  const source = readdirSync(src)
    .filter((f) => /\.(ts|tsx|json)$/.test(f))
    .flatMap((f) => readFileSync(resolve(src, f), "utf8").match(ADDRESS) ?? []);
  return [
    ...new Set(
      [
        ...deployment.contracts.map((c: { address: string }) => c.address),
        ...(deployment.oracleAsker?.address ? [deployment.oracleAsker.address] : []),
        ...Object.values(extra.contracts as Record<string, string>),
        ...source,
        "0xcA11bde05977b3631167028862bE2a173976CA11",
      ]
        .map((a) => a.toLowerCase())
        .filter((a) => !/^0x0{40}$/.test(a)),
    ),
  ].sort();
}
const PUBLIC_REDIRECTS = `/terminal / 302
/terminal/* / 302
`;
const LAUNCH_REDIRECTS = `/analytics /stats/ 301
/analytics/ /stats/ 301
/analytics/* /stats/ 301
`;
const ROBOTS = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;
/**
 * The headers Cloudflare serves with every public response. The Content-Security-Policy is built
 * after the export is written: the one inline script (the theme bootstrap in each page's <head>) is
 * allowed by its hash, so any other inline script, every inline style, and every connection to a
 * chain or a third party is refused by the browser. The public site reads no chain (scripts/public-check.mjs):
 * its one allowance is Cloudflare Web Analytics, which the zone injects into every page: the beacon's script
 * from static.cloudflareinsights.com and its report, which goes to the page's own origin (/cdn-cgi/rum, since the
 * zone is proxied) or to cloudflareinsights.com. 'self' admits nothing else: the public site has no API.
 * /assets/* (hashed, public, immutable) also answers any origin: the build marks its scripts and styles
 * `crossorigin`, and a page framed in a sandbox without allow-same-origin, as X frames a player card
 * (infer.imdusd.com/buy/, /97/), has the origin "null", so without this every asset was refused and the card
 * stayed blank.
 */
/**
 * One id per build, written into every page as <meta name="build">. Soft navigation (src/soft.tsx) moves
 * between pages only within one build: a page from a newer deploy is loaded properly, so a tab left open
 * across a deploy never asks for script files that deploy removed.
 */
const BUILD = `${Date.now().toString(36)}-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}`;
const buildMeta = `<meta name="build" content="${BUILD}" />`;

/** Cloudflare Web Analytics, injected by the zone: where its beacon loads from and where it reports. */
const CF_ANALYTICS = { script: "https://static.cloudflareinsights.com", report: "https://cloudflareinsights.com" };
const publicHeaders = (
  scriptHashes: string[],
  connect: string[] = [],
  frames: string[] = [],
  media = false,
  scriptOrigins: string[] = [],
) => `/*
  Content-Security-Policy: default-src 'none'; script-src 'self' ${scriptHashes.map((h) => `'sha256-${h}'`).join(" ")}${scriptOrigins.map((o) => ` ${o}`).join("")}; style-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; connect-src ${connect.length ? connect.join(" ") : "'none'"};${media ? " media-src 'self';" : ""}${frames.length ? ` frame-src ${frames.join(" ")};` : ""} frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'; upgrade-insecure-requests
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
/assets/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *
`;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = resolve(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

function publicSite(): Plugin {
  return {
    name: "imdusd-public-site",
    apply: "build",
    generateBundle() {
      // The launch build serves the terminal, so old /terminal links are no longer sent home.
      // The launch build: the analytics page moved to /stats/, so old /analytics links follow it.
      this.emitFile({
        type: "asset",
        fileName: "_redirects",
        source: LAUNCH ? LAUNCH_REDIRECTS : PUBLIC_REDIRECTS,
      });
      this.emitFile({ type: "asset", fileName: "robots.txt", source: ROBOTS });
      // The terminal's own RPC serves only these contracts; the public build has no terminal, so no /rpc.
      if (LAUNCH)
        this.emitFile({
          type: "asset",
          fileName: "rpc-allow.json",
          source: JSON.stringify(terminalRpcAllow(), null, 1) + "\n",
        });
    },
    writeBundle(options) {
      const dir = options.dir!;
      // The public homepage reads no chain, so the deployment's ABIs are not shipped (the terminal needs them).
      if (!LAUNCH) rmSync(resolve(dir, "abi"), { recursive: true, force: true });
      // public/manifest.webmanifest describes the terminal; this site has none, so it is the site.
      const file = resolve(dir, "manifest.webmanifest");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.name = "imdUSD";
      manifest.start_url = "./";
      manifest.description =
        "imdUSD: a dollar-denominated stablecoin priced by IdentityMD swarm attestations.";
      writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
      // The homepage's canonical URL and social card.
      const home = resolve(dir, "index.html");
      const html = readFileSync(home, "utf8");
      const description =
        html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? "";
      writeFileSync(
        home,
        html.replace(
          "</head>",
          `${socialTags(SITE, `${SITE}/`, "imdUSD", description, { type: "website" })}</head>`,
        ),
      );
      // The analytics page's canonical URL and social card (launch build only: the public build has no such page).
      if (LAUNCH) {
        const analytics = resolve(dir, "stats/index.html");
        const page = readFileSync(analytics, "utf8");
        const about = page.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? "";
        writeFileSync(
          analytics,
          page.replace("</head>", `${socialTags(SITE, `${SITE}/stats/`, "imdUSD Analytics", about, { type: "website" })}</head>`),
        );
      }
      // The links page's canonical URL and social card (every public build has it).
      const links = resolve(dir, "links/index.html");
      const linksPage = readFileSync(links, "utf8");
      const linksAbout = linksPage.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? "";
      writeFileSync(
        links,
        linksPage.replace("</head>", `${socialTags(SITE, `${SITE}/links/`, "imdUSD links", linksAbout, { type: "website" })}</head>`),
      );
      // The not-found page is served at whatever path was asked for, so its URLs must be absolute.
      const notFound = resolve(dir, "404.html");
      writeFileSync(
        notFound,
        readFileSync(notFound, "utf8").replace(/(["'(])\.\//g, "$1/"),
      );
    },
    // After every plugin has written (the docs pages included), hash each page's inline script and
    // write the headers. One theme bootstrap means one hash; a page that smuggled in another inline
    // script would add a second, which is the point of computing rather than pinning it.
    closeBundle() {
      const dir = resolve(import.meta.dirname, "../dist-public");
      const hashes = new Set<string>();
      for (const file of walk(dir).filter((f) => f.endsWith(".html"))) {
        // Every page names its build, for soft navigation (src/soft.tsx); the docs pages are written by
        // now, so they get it too.
        const page = readFileSync(file, "utf8");
        if (!page.includes('<meta name="build"'))
          writeFileSync(file, page.replace("</head>", `${buildMeta}</head>`));
        for (const [, script] of readFileSync(file, "utf8").matchAll(
          /<script>([\s\S]*?)<\/script>/g,
        ))
          hashes.add(createHash("sha256").update(script).digest("base64"));
      }
      if (hashes.size !== 1)
        throw new Error(
          `expected one inline script across the public pages, found ${hashes.size}`,
        );
      writeFileSync(
        resolve(dir, "_headers"),
        publicHeaders(
          [...hashes],
          ["'self'", CF_ANALYTICS.report, ...(LAUNCH ? launchConnect() : [])],
          [],
          false,
          [CF_ANALYTICS.script],
        ),
      );
    },
  };
}

/**
 * infer.imdusd.com (`vite build --mode infer`, root web/infer): the INFER token page, its own export
 * in dist-infer/. Unlike the public site it talks to a chain, so its Content-Security-Policy admits
 * exactly the RPC and claim-file origins the page's launch file names, and nothing else.
 */
const INFER_SITE = "https://infer.imdusd.com";
/**
 * WalletConnect's relay and its verify service, the only origins the protocol contacts (measured under
 * the enforced policy: the relay socket, and verify, which it loads as a hidden frame; the .com hosts are
 * their fallbacks). Admitted only when src/infer/walletconnect.json names a project, so without one the
 * policy is exactly as before.
 */
const WALLETCONNECT_FRAMES = [
  "https://verify.walletconnect.org",
  "https://verify.walletconnect.com",
];
const WALLETCONNECT_ORIGINS = [
  "wss://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://verify.walletconnect.com",
];
/**
 * /buy/ is an X player card: a post that links it shows the page itself, live, in a 480 × 560 frame,
 * with `buy-card.png` (src/infer, rendered from the page by scripts/render-infer-card.mjs) as the still
 * before play. The Worker admits x.com as a frame ancestor on this route only (worker/infer.js).
 */
const PLAYER = { width: 480, height: 560, image: "buy/card.png" };
/** /97/, INFER 97: the square film as a player card, the same way (worker/infer.js frames it for X too). */
const PLAYER_97 = { width: 480, height: 480, image: "97/card.png" };
function playerTags(url: string, title: string, description: string, player = PLAYER) {
  const PLAYER = player;
  const image = `${INFER_SITE}/${PLAYER.image}`;
  return (
    `<link rel="canonical" href="${url}" />` +
    `<meta property="og:type" content="website" />` +
    `<meta property="og:site_name" content="imdUSD" />` +
    `<meta property="og:url" content="${url}" />` +
    `<meta property="og:title" content="${title}" />` +
    `<meta property="og:description" content="${description}" />` +
    `<meta property="og:image" content="${image}" />` +
    `<meta property="og:image:width" content="${PLAYER.width * 2}" />` +
    `<meta property="og:image:height" content="${PLAYER.height * 2}" />` +
    `<meta name="twitter:card" content="player" />` +
    `<meta name="twitter:title" content="${title}" />` +
    `<meta name="twitter:description" content="${description}" />` +
    `<meta name="twitter:image" content="${image}" />` +
    `<meta name="twitter:player" content="${url}" />` +
    `<meta name="twitter:player:width" content="${PLAYER.width}" />` +
    `<meta name="twitter:player:height" content="${PLAYER.height}" />`
  );
}
function inferSite(): Plugin {
  // The export directory, taken from the build rather than assumed, so `--outDir` works (a QA
  // build against a fork lives beside the real one without touching it).
  let dir = resolve(import.meta.dirname, "../dist-infer");
  const launchDir = resolve(import.meta.dirname, "src/infer");
  const launch = JSON.parse(
    readFileSync(
      resolve(
        launchDir,
        existsSync(resolve(launchDir, "launch.json"))
          ? "launch.json"
          : "launch.example.json",
      ),
      "utf8",
    ),
  ) as { rpc: string[]; claims: { origins: string[] } };
  const LLMS = inferLlms(launch);
  // The contracts /rpc will call (worker/rpc.js): every address in the launch config and in the INFER source,
  // plus Multicall3, which bundles the pages' reads. A new contract read by the page is allowed by being in
  // one of those two places; anything else is refused.
  const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
  const sources = [
    readFileSync(resolve(launchDir, existsSync(resolve(launchDir, "launch.json")) ? "launch.json" : "launch.example.json"), "utf8"),
    ...readdirSync(launchDir)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .map((f) => readFileSync(resolve(launchDir, f), "utf8")),
  ];
  const RPC_ALLOW = [
    ...new Set(
      [...sources.flatMap((s) => s.match(ADDRESS) ?? []), "0xcA11bde05977b3631167028862bE2a173976CA11"]
        .map((a) => a.toLowerCase())
        .filter((a) => !/^0x0{40}$/.test(a)),
    ),
  ].sort();
  return {
    name: "imdusd-infer-site",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: `User-agent: *\nAllow: /\n\nSitemap: ${INFER_SITE}/sitemap.xml\n`,
      });
      this.emitFile({ type: "asset", fileName: "llms.txt", source: LLMS });
      this.emitFile({ type: "asset", fileName: "rpc-allow.json", source: JSON.stringify(RPC_ALLOW, null, 1) + "\n" });
      this.emitFile({
        type: "asset",
        fileName: PLAYER.image,
        source: readFileSync(resolve(launchDir, "buy-card.png")),
      });
      this.emitFile({
        type: "asset",
        fileName: PLAYER_97.image,
        source: readFileSync(resolve(launchDir, "infer97-card.png")),
      });
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source:
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          ["", "claim/", "tokenomics/", "97/"]
            .map((p) => `  <url><loc>${INFER_SITE}/${p}</loc></url>`)
            .join("\n") +
          `\n</urlset>\n`,
      });
    },
    writeBundle(options) {
      dir = options.dir ?? dir;
      // The not-found page is served at whatever path was asked for, so its URLs must be absolute.
      const notFound = resolve(dir, "404.html");
      writeFileSync(
        notFound,
        readFileSync(notFound, "utf8")
          .replace(/(["'(])\.\.?\//g, "$1/")
          .replace("</head>", `${buildMeta}</head>`),
      );
      rmSync(resolve(dir, "abi"), { recursive: true, force: true });
      // imdusd.com/links/'s QR code (public/links) belongs to imdusd.com, not here.
      rmSync(resolve(dir, "links"), { recursive: true, force: true });
      const file = resolve(dir, "manifest.webmanifest");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.name = "INFER";
      manifest.short_name = "INFER";
      manifest.start_url = "./";
      manifest.description =
        "INFER, the imdUSD protocol's token: claim, swap, stake and the tokenomics.";
      writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
      for (const page of ["", "claim/", "tokenomics/", "buy/", "97/"]) {
        const file = resolve(dir, page, "index.html");
        const html = readFileSync(file, "utf8");
        const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "INFER";
        const description =
          html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ??
          "";
        writeFileSync(
          file,
          html.replace(
            "</head>",
            `${buildMeta}${page === "buy/" ? playerTags(`${INFER_SITE}/${page}`, title, description) : page === "97/" ? playerTags(`${INFER_SITE}/${page}`, title, description, PLAYER_97) : socialTags(INFER_SITE, `${INFER_SITE}/${page}`, title, description, { type: "website" })}</head>`,
          ),
        );
      }
    },
    closeBundle() {
      const hashes = new Set<string>();
      for (const file of walk(dir).filter((f) => f.endsWith(".html"))) {
        for (const [, script] of readFileSync(file, "utf8").matchAll(
          /<script>([\s\S]*?)<\/script>/g,
        ))
          hashes.add(createHash("sha256").update(script).digest("base64"));
      }
      if (hashes.size !== 1)
        throw new Error(
          `expected one inline script on the INFER page, found ${hashes.size}`,
        );
      const origins = [
        ...new Set(
          [...launch.rpc, ...launch.claims.origins].map(
            (u) => new URL(u).origin,
          ),
        ),
      ];
      const wc = JSON.parse(
        readFileSync(resolve(launchDir, "walletconnect.json"), "utf8"),
      ) as { projectId: string | null };
      if (wc.projectId) origins.push(...WALLETCONNECT_ORIGINS);
      writeFileSync(
        resolve(dir, "_headers"),
        publicHeaders(
          [...hashes],
          // Cloudflare Web Analytics, injected by the zone here too: its beacon and its report.
          ["'self'", ...origins, CF_ANALYTICS.report],
          wc.projectId ? WALLETCONNECT_FRAMES : [],
          true, // /97/ plays its film from the site itself
          [CF_ANALYTICS.script],
        ),
      );
    },
  };
}

/** Static docs pages from web/content/docs, written beside the built docs shell. */
/**
 * Holds each page's first paint until its script has run, so the background (vibe.tsx, started as the
 * script loads) is in that paint: with the browser holding the old page until then, a link to another
 * page changes the page and not the background. Vite rewrites the entry tag, so it is added here.
 */
/**
 * On imdusd.com the entry is only a boot script (src/boot-imdusd.ts: theme and background) that then
 * imports the page's code (src/page-*.tsx). That page chunk and everything it imports statically are
 * preloaded here, beside the entry, at low priority: they download while the boot runs without holding the first
 * paint or taking the bandwidth the boot and the stylesheet need.
 */
function renderBlocking(): Plugin {
  return {
    name: "imdusd-render-blocking",
    transformIndexHtml: {
      order: "post",
      handler: (html, ctx) => {
        html = html.replace(
          /<script type="module" crossorigin/g,
          '<script type="module" crossorigin blocking="render"',
        );
        const { chunk: entry, bundle } = ctx;
        if (!entry || !bundle) return html;
        const pages = entry.dynamicImports.filter((f) => {
          const c = bundle[f];
          // A docs page is static HTML: its script only adds the header, so it is not worth the bandwidth early.
          return c?.type === "chunk" && /\/src\/page-(?!docs)[a-z]+\.tsx$/.test(c.facadeModuleId ?? "");
        });
        if (!pages.length) return html;
        const have = new Set([entry.fileName, ...entry.imports]);
        const want: string[] = [];
        const visit = (f: string) => {
          if (have.has(f)) return;
          have.add(f);
          want.push(f);
          const c = bundle[f];
          if (c?.type === "chunk") c.imports.forEach(visit);
        };
        pages.forEach(visit);
        const tag = /<script type="module" crossorigin blocking="render" src="([^"]*?)assets\/[^"]*"><\/script>/;
        const prefix = html.match(tag)?.[1];
        if (prefix === undefined) return html;
        const links = want
          .filter((f) => !html.includes(`${prefix}${f}"`)) // Vite's own preloads for the entry's imports
          .map((f) => `<link rel="modulepreload" crossorigin fetchpriority="low" href="${prefix}${f}">`);
        return html.replace(tag, (t) => [t, ...links].join("\n    "));
      },
    },
  };
}

function docsPages(terminal: boolean, site?: string): Plugin {
  return {
    name: "imdusd-docs-pages",
    apply: "build",
    writeBundle(options) {
      const count = renderDocs({
        outDir: options.dir!,
        contentDir: resolve(import.meta.dirname, "content/docs"),
        terminal,
        site,
      });
      this.info(`rendered ${count} docs pages`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const site = mode === "public";
  if (mode === "infer") {
    const infer: UserConfig = {
      root: resolve(import.meta.dirname, "infer"),
      publicDir: resolve(import.meta.dirname, "public"),
      plugins: [react(), renderBlocking(), inferSite()],
      base: "./",
      build: {
        outDir: resolve(import.meta.dirname, "../dist-infer"),
        emptyOutDir: true,
        sourcemap: false,
        rollupOptions: {
          input: {
            index: resolve(import.meta.dirname, "infer/index.html"),
            claim: resolve(import.meta.dirname, "infer/claim/index.html"),
            buy: resolve(import.meta.dirname, "infer/buy/index.html"),
            infer97: resolve(import.meta.dirname, "infer/97/index.html"),
            tokenomics: resolve(
              import.meta.dirname,
              "infer/tokenomics/index.html",
            ),
            notfound: resolve(import.meta.dirname, "infer/404.html"),
          },
        },
      },
    };
    return infer;
  }
  return {
    plugins: site
      ? [react(), renderBlocking(), publicSite(), docsPages(LAUNCH, SITE)]
      : [react(), renderBlocking(), docsPages(true)],
    // The public site reads no chain: swap the live homepage for a stub so viem and the RPC layer
    // are not bundled at all. The launch build keeps the real one: Landing renders LiveLanding there
    // (TERMINAL is true), so the stub would leave the homepage empty.
    resolve: site && !LAUNCH
      ? {
          alias: [
            {
              find: /^\.\/landing-live$/,
              replacement: resolve(
                import.meta.dirname,
                "src/landing-live.public.tsx",
              ),
            },
            {
              find: /^\.\/analytics-route$/,
              replacement: resolve(import.meta.dirname, "src/analytics-route.public.ts"),
            },
          ],
        }
      : {},
    base: "./",
    // The points engine lives at ../points/engine.ts so the CLI and the terminal share one file.
    server: { fs: { allow: [".."] } },
    build: {
      outDir: site ? "../dist-public" : "../dist",
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        // Named, so the export says what each shared file is: the boot every page runs before its first paint
        // (theme and background, src/boot-imdusd.ts) and React. The rest split by where they are used.
        output: {
          codeSplitting: {
            groups: [
              {
                name: "boot",
                test: /\/src\/(boot-imdusd|theme-core|vibe-core|vibe-imdusd)\.tsx?$|vite\/(preload-helper|modulepreload-polyfill)|react\/jsx-runtime|react\/cjs\/react-jsx-runtime/,
              },
              { name: "react", test: /node_modules\/(react|react-dom|scheduler)\// },
            ],
          },
        },
        input: {
          home: resolve(import.meta.dirname, "index.html"),
          ...(site ? { notfound: resolve(import.meta.dirname, "404.html") } : {}),
          ...(!site || LAUNCH
            ? { terminal: resolve(import.meta.dirname, "terminal/index.html") }
            : {}),
          ...(!site || LAUNCH
            ? { stats: resolve(import.meta.dirname, "stats/index.html") }
            : {}),
          docs: resolve(import.meta.dirname, "docs/index.html"),
          // /links/, shared by QR code; it reads no chain, so every build has it.
          links: resolve(import.meta.dirname, "links/index.html"),
        },
      },
    },
  };
});
