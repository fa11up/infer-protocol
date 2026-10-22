// Renders web/content/blog/*.md into blog.imdusd.com's static pages, after Vite has built the blog shell
// (blog/index.html -> <out>/index.html). Like the docs (scripts/docs-pages.mjs): each post is real HTML at
// /<slug>/, readable without JavaScript and indexable; the React entry only mounts the shared header.
//
// Posts are ours, but they are still Markdown from a file: raw HTML in them is shown as text, never rendered.
// Every post also gets a "plate": a guilloché rosette drawn from its slug (deterministic), shown on the index
// and at the head of the post. Its social card is content/blog/<slug>.png when present (scripts/blog-cards.mjs).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { Marked } from "marked";

export const BLOG_SITE = "https://blog.imdusd.com";
const REQUIRED = ["title", "date", "summary"];

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** XML text: the five entities and nothing else, so the feed is well formed. */
export const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

const plainText = (md) =>
  md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** YAML-ish front matter: `key: value` lines, values optionally in double quotes. */
export function frontMatter(source, file) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
    meta[kv[1]] = v;
  }
  for (const k of REQUIRED) if (!meta[k]) throw Error(`${file}: front matter lacks ${k}`);
  for (const k of ["date", "updated"])
    if (meta[k] && !/^\d{4}-\d{2}-\d{2}$/.test(meta[k])) throw Error(`${file}: ${k} must be YYYY-MM-DD`);
  meta.author ||= "imdUSD";
  meta.living = meta.living === "true";
  return { meta, body: source.slice(m[0].length) };
}

/** Every post, newest first, with its slug (the file name) and its issue number (oldest = No. 1). */
export function readPosts(contentDir) {
  const files = readdirSync(contentDir).filter((f) => f.endsWith(".md"));
  const posts = files.map((file) => {
    const slug = file.replace(/\.md$/, "");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw Error(`${file}: the file name is the URL: lower case, digits and dashes`);
    const { meta, body } = frontMatter(readFileSync(resolve(contentDir, file), "utf8"), file);
    return { file, slug, meta, body };
  });
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.slug)) throw Error(`duplicate slug ${p.slug}`);
    seen.add(p.slug);
  }
  [...posts].sort((a, b) => a.meta.date.localeCompare(b.meta.date) || a.slug.localeCompare(b.slug)).forEach((p, i) => (p.issue = i + 1));
  return posts.sort((a, b) => b.meta.date.localeCompare(a.meta.date) || a.slug.localeCompare(b.slug));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
};
const rfc822 = (d) => new Date(`${d}T12:00:00Z`).toUTCString();
const issueNo = (n) => `No. ${String(n).padStart(3, "0")}`;

// ---------------------------------------------------------------- the plate (a guilloché rosette per post)

/** FNV-1a over the slug, then a small PRNG: the same slug always draws the same plate. */
function prng(seedText) {
  let s = 2166136261;
  for (const ch of seedText) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) >>> 0), (s ^= s >>> 13), s / 4294967296);
}
/**
 * An engraved rosette: a family of epitrochoids (the curves a banknote lathe cuts), each a little rotated and
 * scaled from the last, in currentColor so it follows the theme. Pure SVG paths, no style attribute (the CSP
 * allows no inline styles).
 */
export function plate(slug, { size = 120, strands = 14, className = "plate" } = {}) {
  const r = prng(slug);
  const lobes = 5 + Math.floor(r() * 7); // 5..11
  const ratio = 0.18 + r() * 0.22;
  const turn = (Math.PI * 2) / (strands * lobes);
  const c = size / 2;
  const paths = [];
  for (let k = 0; k < strands; k++) {
    const R = c * (0.86 - 0.012 * k);
    const d = R * ratio;
    const phase = k * turn;
    const pts = [];
    const N = 360;
    for (let i = 0; i <= N; i++) {
      const t = (i / N) * Math.PI * 2;
      const rr = R - d + d * Math.cos(lobes * t);
      pts.push(`${(c + rr * Math.cos(t + phase)).toFixed(2)},${(c + rr * Math.sin(t + phase)).toFixed(2)}`);
    }
    paths.push(`<polyline points="${pts.join(" ")}"/>`);
  }
  const inner = [];
  for (let k = 0; k < 3; k++) inner.push(`<circle cx="${c}" cy="${c}" r="${(c * (0.16 + 0.05 * k)).toFixed(2)}"/>`);
  return (
    `<svg class="${className}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<g fill="none" stroke="currentColor" stroke-width="0.45" stroke-linejoin="round">${paths.join("")}${inner.join("")}</g></svg>`
  );
}

// ---------------------------------------------------------------- Markdown

const NUMERIC = /^[\s$€£Ɨ~≈<>±+-]*[\d.,]+\s*(%|x|×|k|m|bn|M|B|IMD|ETH|USD|USDC|imdUSD)?\s*$/;

function renderBody(post) {
  const used = new Map();
  const headings = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === "link" && /^javascript:/i.test(token.href)) token.href = "#";
    },
    renderer: {
      html: (token) => escapeHtml(token.text),
      heading(token) {
        let id = slugify(token.text) || "section";
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id = `${id}-${n}`;
        const inner = this.parser.parseInline(token.tokens);
        if (token.depth === 2 || token.depth === 3) headings.push({ depth: token.depth, id, text: plainText(token.text) });
        if (token.depth === 1) return `<h2 id="${id}">${inner}</h2>\n`; // the post's own title is the only h1
        return `<h${token.depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section">#</a>${inner}</h${token.depth}>\n`;
      },
      link(token) {
        const text = this.parser.parseInline(token.tokens);
        const external = /^https?:/i.test(token.href) && !token.href.startsWith(BLOG_SITE);
        return `<a href="${escapeHtml(token.href)}"${external ? ' target="_blank" rel="noreferrer"' : ""}>${text}</a>`;
      },
      // Tables as the docs build them (every cell names its column for the phone layout), with numbers in their
      // own right-aligned mono column so they line up.
      table(token) {
        const labels = token.header.map((h) => plainText(h.text));
        const numeric = token.header.map((_, i) => token.rows.length > 0 && token.rows.every((r) => NUMERIC.test(plainText(r[i]?.text ?? ""))));
        const cls = (i) => (numeric[i] ? ' class="num"' : token.align[i] ? ` class="ta-${token.align[i]}"` : "");
        const head = token.header.map((h, i) => `<th scope="col"${cls(i)}>${this.parser.parseInline(h.tokens)}</th>`).join("");
        const rows = token.rows
          .map((row) => `<tr>${row.map((c, i) => `<td data-label="${escapeHtml(labels[i] ?? "")}"${cls(i)}>${this.parser.parseInline(c.tokens)}</td>`).join("")}</tr>`)
          .join("\n");
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(post.body);
  return { html, headings };
}

/** A post title "Series: Subtitle" sets the subtitle on its own line under the series. */
function postTitle(title) {
  const at = title.indexOf(": ");
  if (at < 0) return escapeHtml(title);
  return `${escapeHtml(title.slice(0, at + 1))} <span class="post-title-sub">${escapeHtml(title.slice(at + 2))}</span>`;
}

/** The table of contents: h2s, with their h3s beneath. Only for posts long enough to need one. */
function toc(headings) {
  const h2 = headings.filter((h) => h.depth === 2);
  if (h2.length < 4) return "";
  let out = "";
  let open = false;
  for (const h of headings) {
    if (h.depth === 2) {
      if (open) out += "</ul></li>";
      out += `<li><a href="#${h.id}">${escapeHtml(h.text)}</a>`;
      open = false;
      const next = headings[headings.indexOf(h) + 1];
      if (next && next.depth === 3) {
        out += "<ul>";
        open = true;
      } else out += "</li>";
    } else out += `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`;
  }
  if (open) out += "</ul></li>";
  // The sticky element stays transparent and the sheet is its child: a sticky box with its own ground over the
  // fixed background canvas left a painted block below it in Chromium.
  return `<nav class="post-toc" aria-label="Contents"><div class="post-toc-box"><p class="post-toc-title">Contents</p><ul>${out}</ul></div></nav>`;
}

// ---------------------------------------------------------------- pages

function socialTags(url, title, description, image, { type = "article", large = false } = {}) {
  const e = escapeHtml;
  return (
    `<link rel="canonical" href="${e(url)}" />` +
    `<link rel="alternate" type="application/rss+xml" title="imdUSD blog" href="${BLOG_SITE}/feed.xml" />` +
    `<meta property="og:type" content="${type}" />` +
    `<meta property="og:site_name" content="imdUSD" />` +
    `<meta property="og:url" content="${e(url)}" />` +
    `<meta property="og:title" content="${e(title)}" />` +
    `<meta property="og:description" content="${e(description)}" />` +
    `<meta property="og:image" content="${e(image)}" />` +
    `<meta name="twitter:card" content="${large ? "summary_large_image" : "summary"}" />` +
    `<meta name="twitter:site" content="@imdusd" />` +
    `<meta name="twitter:title" content="${e(title)}" />` +
    `<meta name="twitter:description" content="${e(description)}" />` +
    `<meta name="twitter:image" content="${e(image)}" />`
  );
}

const masthead = (mark, link = true) =>
  `<div class="blog-masthead">` +
  (link ? `<a class="blog-mark" href="/" aria-label="imdUSD blog home">${mark}</a>` : `<span class="blog-mark">${mark}</span>`) +
  `<div class="blog-masthead-text"><p class="blog-kicker">imdUSD</p><p class="blog-name">Publications</p></div>` +
  `<p class="blog-masthead-note">Protocol strategy, releases and research</p>` +
  `</div>`;

// The same three-column footer as imdusd.com (src/site.tsx SiteFooter), with RSS in the Read column.
const footer = () =>
  `<footer class="site-footer">` +
  `<div class="foot-brand"><a class="wordmark" href="https://imdusd.com/" aria-label="imdUSD home">imd<b>USD</b></a><span>Built on IdentityMD</span></div>` +
  `<nav class="foot-cols" aria-label="Footer">` +
  `<div class="foot-col"><span class="foot-h">Protocol</span><a href="https://imdusd.com/terminal/">Terminal</a>` +
  `<a href="https://imdusd.com/stats/">Stats</a><a href="https://imdusd.com/docs/">Docs</a></div>` +
  `<div class="foot-col"><span class="foot-h">Read</span><a href="/">Blog</a><a href="/feed.xml">RSS</a>` +
  `<a href="https://whitepaper.imdusd.com" target="_blank" rel="noreferrer">Whitepaper ↗</a></div>` +
  `<div class="foot-col"><span class="foot-h">Ecosystem</span>` +
  `<a href="https://infer.imdusd.com" target="_blank" rel="noreferrer">INFER ↗</a><a href="https://imdusd.com/links/">Links</a>` +
  `<span class="foot-icons"><a class="x-link" href="https://x.com/imdusd" target="_blank" rel="noreferrer" aria-label="imdUSD on X" title="imdUSD on X">` +
  `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a></span></div>` +
  `</nav></footer>`;

/**
 * Writes /<slug>/index.html for every post, the index (over the built shell at <out>/index.html), the 404's
 * body, feed.xml, sitemap.xml and robots.txt. Returns the posts.
 */
export function renderBlog({ outDir, contentDir, site = BLOG_SITE }) {
  const posts = readPosts(contentDir);
  const template = readFileSync(resolve(outDir, "index.html"), "utf8");
  if (!template.includes("<!--BLOG-BODY-->")) throw Error("blog/index.html has no <!--BLOG-BODY--> slot");

  const favicon = readFileSync(resolve(contentDir, "../../public/favicon.svg"), "utf8");
  const markRects = favicon.match(/<g style="fill:var\(--text\)">(.*?)<\/g>/)?.[1];
  if (!markRects) throw Error("public/favicon.svg: mark not found");
  const mark = `<svg viewBox="0 0 16 16" width="30" height="30" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><g fill="currentColor">${markRects}</g></svg>`;

  // Paths in the shell are written for the site root ("./x"); a post sits one level down.
  const page = (dir, title, description, social, body) => {
    let html = template;
    if (dir) html = html.replace(/(["'(])\.\//g, `$1../`);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
      .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, (_, a, b) => `${a}${escapeHtml(description)}${b}`)
      .replace("<!--BLOG-BODY-->", body)
      .replace("</head>", `${social}</head>`);
    mkdirSync(resolve(outDir, dir), { recursive: true });
    writeFileSync(resolve(outDir, dir, "index.html"), html);
  };

  for (const p of posts) {
    const { html, headings } = renderBody(p);
    const contents = toc(headings);
    const card = existsSync(resolve(contentDir, `${p.slug}.png`));
    if (card) {
      mkdirSync(resolve(outDir, p.slug), { recursive: true });
      copyFileSync(resolve(contentDir, `${p.slug}.png`), resolve(outDir, p.slug, "card.png"));
    }
    const image = card ? `${site}/${p.slug}/card.png` : `${site}/icon-512.png`;
    const hasChangelog = headings.some((h) => h.id === "changelog");
    const meta =
      `<p class="post-serial"><span>${issueNo(p.issue)}</span><span>${escapeHtml(longDate(p.meta.date))}</span><span>${escapeHtml(p.meta.author)}</span></p>`;
    const living = p.meta.living
      ? `<p class="post-living"><span class="post-living-tag">Living document</span>Last updated ${escapeHtml(longDate(p.meta.updated || p.meta.date))}` +
        (hasChangelog ? ` · <a href="#changelog">Changelog</a>` : "") +
        `</p>`
      : "";
    const body =
      `<main class="blog" id="blog-main">` +
      masthead(mark) +
      `<div class="post-layout${contents ? " has-toc" : ""}">` +
      `<article class="post">` +
      `<header class="post-head">${plate(p.slug, { size: 96, className: "plate post-plate" })}${meta}` +
      `<h1>${postTitle(p.meta.title)}</h1>` +
      `<p class="post-summary">${escapeHtml(p.meta.summary)}</p>${living}</header>` +
      `<div class="post-body">${html}</div>` +
      `<p class="post-end"><a href="/">← All publications</a></p>` +
      `</article>` +
      contents +
      `</div></main>` +
      footer();
    page(
      p.slug,
      `${p.meta.title} · imdUSD`,
      p.meta.summary,
      socialTags(`${site}/${p.slug}/`, p.meta.title, p.meta.summary, image, { large: card }) +
        `<meta property="article:published_time" content="${p.meta.date}" />` +
        (p.meta.updated ? `<meta property="article:modified_time" content="${p.meta.updated}" />` : ""),
      body,
    );
  }

  const entries = posts
    .map(
      (p) =>
        `<li class="entry"><a class="entry-link" href="${p.slug}/">` +
        `<span class="entry-meta"><span class="entry-no">${issueNo(p.issue)}</span><time datetime="${p.meta.date}">${escapeHtml(longDate(p.meta.date))}</time>` +
        (p.meta.living ? `<span class="entry-living">Living · updated ${escapeHtml(longDate(p.meta.updated || p.meta.date))}</span>` : "") +
        `</span>` +
        `<span class="entry-text"><span class="entry-title">${escapeHtml(p.meta.title)}</span><span class="entry-summary">${escapeHtml(p.meta.summary)}</span></span>` +
        plate(p.slug, { size: 88, className: "plate entry-plate" }) +
        `</a></li>`,
    )
    .join("");
  const indexBody =
    `<main class="blog" id="blog-main">` +
    masthead(mark, false) +
    `<section class="ledger" aria-labelledby="ledger-title"><h1 id="ledger-title" class="ledger-title">Publications</h1>` +
    `<ol class="entries" reversed>${entries}</ol>` +
    `<p class="ledger-foot"><a href="/feed.xml">Subscribe by RSS</a></p></section>` +
    `</main>` +
    footer();
  page("", "imdUSD blog", "Publications from imdUSD: protocol strategy, releases and research.", socialTags(`${site}/`, "imdUSD blog", "Publications from imdUSD: protocol strategy, releases and research.", `${site}/icon-512.png`, { type: "website" }), indexBody);

  // The not-found page: the same shell, served at any address (so absolute paths), never indexed.
  const notFound = template
    .replace(/(["'(])\.\//g, "$1/")
    .replace(/<title>[^<]*<\/title>/, "<title>Not found · imdUSD blog</title>")
    .replace("<head>", '<head>\n    <meta name="robots" content="noindex" />')
    .replace(
      "<!--BLOG-BODY-->",
      `<main class="blog" id="blog-main">${masthead(mark)}<section class="ledger"><h1 class="ledger-title">Not found</h1>` +
        `<p class="ledger-foot">There is no publication at this address. <a href="/">See all publications</a>.</p></section></main>${footer()}`,
    );
  writeFileSync(resolve(outDir, "404.html"), notFound);

  writeFileSync(resolve(outDir, "feed.xml"), feed(posts, site));
  writeFileSync(
    resolve(outDir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      [`  <url><loc>${site}/</loc></url>`, ...posts.map((p) => `  <url><loc>${site}/${p.slug}/</loc><lastmod>${p.meta.updated || p.meta.date}</lastmod></url>`)].join("\n") +
      `\n</urlset>\n`,
  );
  writeFileSync(resolve(outDir, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`);
  return posts;
}

/** RSS 2.0: every post, newest first, its summary as the description. */
export function feed(posts, site = BLOG_SITE) {
  const items = posts
    .map(
      (p) =>
        `    <item>\n` +
        `      <title>${escapeXml(p.meta.title)}</title>\n` +
        `      <link>${site}/${p.slug}/</link>\n` +
        `      <guid isPermaLink="true">${site}/${p.slug}/</guid>\n` +
        `      <pubDate>${rfc822(p.meta.date)}</pubDate>\n` +
        `      <description>${escapeXml(p.meta.summary)}</description>\n` +
        `    </item>\n`,
    )
    .join("");
  const latest = posts.reduce((m, p) => ((p.meta.updated || p.meta.date) > m ? p.meta.updated || p.meta.date : m), "1970-01-01");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n` +
    `    <title>imdUSD blog</title>\n    <link>${site}/</link>\n` +
    `    <atom:link href="${site}/feed.xml" rel="self" type="application/rss+xml" />\n` +
    `    <description>Publications from imdUSD: protocol strategy, releases and research.</description>\n` +
    `    <language>en</language>\n    <lastBuildDate>${rfc822(latest)}</lastBuildDate>\n` +
    items +
    `  </channel>\n</rss>\n`
  );
}
