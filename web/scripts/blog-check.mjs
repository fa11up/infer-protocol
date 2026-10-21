// Checks the built blog (dist-blog/) before it may be deployed: every post and the index exist, the feed and
// sitemap name every post, the headers carry the site's Content-Security-Policy (one inline script by hash,
// no third-party connection but Cloudflare Web Analytics), and no page loads a script from anywhere else.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error plain ESM build script
import { readPosts, BLOG_SITE } from "./blog-pages.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "../dist-blog");
const fail = (m) => {
  console.error(`blog-check: ${m}`);
  process.exit(1);
};
const posts = readPosts(resolve(root, "content/blog"));
for (const f of ["index.html", "404.html", "feed.xml", "sitemap.xml", "robots.txt", "_headers", "favicon.svg"])
  if (!existsSync(resolve(dist, f))) fail(`missing ${f}`);
for (const p of posts) if (!existsSync(resolve(dist, p.slug, "index.html"))) fail(`missing post ${p.slug}`);
const feed = readFileSync(resolve(dist, "feed.xml"), "utf8");
const sitemap = readFileSync(resolve(dist, "sitemap.xml"), "utf8");
for (const p of posts) {
  if (!feed.includes(`<link>${BLOG_SITE}/${p.slug}/</link>`)) fail(`feed lacks ${p.slug}`);
  if (!sitemap.includes(`${BLOG_SITE}/${p.slug}/`)) fail(`sitemap lacks ${p.slug}`);
}
const headers = readFileSync(resolve(dist, "_headers"), "utf8");
const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? fail("no Content-Security-Policy");
if (!/connect-src 'self' https:\/\/cloudflareinsights\.com;/.test(csp)) fail(`connect-src is not 'self' + Cloudflare: ${csp}`);
if (!/script-src 'self' 'sha256-[^']+' https:\/\/static\.cloudflareinsights\.com;/.test(csp)) fail(`script-src is not one hash + Cloudflare: ${csp}`);
if (!/style-src 'self';/.test(csp)) fail("inline styles must stay blocked");
if (existsSync(resolve(dist, "abi")) || existsSync(resolve(dist, "links"))) fail("imdusd.com files shipped in the blog");
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(resolve(d, n)).isDirectory() ? walk(resolve(d, n)) : [resolve(d, n)]));
for (const f of walk(dist).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(f, "utf8");
  for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) if (/^(https?:)?\/\//.test(src)) fail(`${f}: external script ${src}`);
  if (/\sstyle="/.test(html)) fail(`${f}: an inline style attribute (blocked by the CSP)`);
  if (!html.includes('<meta name="build"')) fail(`${f}: no build meta (soft navigation needs it)`);
}
console.log(`blog-check: ${posts.length} post(s), feed, sitemap and headers OK`);
