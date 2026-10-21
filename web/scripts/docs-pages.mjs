// Renders web/content/docs/**/*.md into static pages under <out>/docs/, after Vite has built the
// docs shell (docs/index.html). Each page is real HTML at /docs/<section>/<page>/ so it links, reads
// without JavaScript and can be indexed; the React entry only mounts the shared header.
//
// The content was written by the swarm, so it is treated as untrusted: raw HTML in the Markdown is
// escaped, never rendered, and every internal link must resolve to a page or the build fails.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, dirname, posix } from "node:path";
import { Marked } from "marked";

const SECTIONS = [
  ["overview", "Overview"],
  ["guides", "Guides"],
  ["keepers", "Keepers"],
  ["governance", "Governance"],
  ["economics", "Economics"],
  ["reference", "Reference"],
];
const AUDIENCE = {
  everyone: "For everyone",
  borrowers: "For borrowers",
  keepers: "For keepers",
  governance: "For governance",
  integrators: "For integrators",
};
const REPO = "https://github.com/fa11up/infer-protocol/blob/main/";

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The public site has no terminal yet, so anything that refers to it is redacted: removed from the
// page (not hidden with CSS) and drawn as a black bar of about the same length. Whole pages about
// the terminal are redacted throughout.
const TERMINAL_RE = /terminal/i;
const REDACT_WHOLE = new Set(["guides/use-the-terminal.md"]);
const plainText = (md) =>
  md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_>#|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
/** Braille filler standing in for `text`: random patterns in the original's word shapes, so lines
 * wrap like the original while none of its words reach the page. Seeded from the text so builds are
 * reproducible. */
const bar = (text) => {
  const src = plainText(text).slice(0, 400) || "xxxx";
  let seed = 2166136261;
  for (const ch of src) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0), seed / 4294967296);
  // Braille patterns U+2801..U+28FF (U+2800 is blank, so it is skipped).
  const filler = src.replace(/\S/g, () => String.fromCodePoint(0x2801 + Math.floor(rnd() * 255)));
  return `<span class="redacted" role="img" aria-label="Redacted"><span aria-hidden="true">${filler}</span></span>`;
};
/** A title with only the word "terminal" barred. */
const titleHtml = (t, redact) => {
  const e = escapeHtml(t);
  return redact ? e.replace(/terminal/gi, (w) => bar(w + "xx")) : e;
};
const titleText = (t, redact) => (redact ? t.replace(/terminal/gi, "████████") : t);

/** GitHub-style heading ids, so `page.md#a-heading` links keep working. */
const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

function frontMatter(source, file) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw Error(`${file}: missing front matter`);
  const meta = { sources: [] };
  let list = null;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) meta[list].push(item[1].trim());
    else {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[2] === "") {
        list = kv[1];
        meta[list] = [];
      } else {
        list = null;
        meta[kv[1]] = kv[2].trim();
      }
    }
  }
  for (const k of ["title", "section", "order"]) if (!meta[k]) throw Error(`${file}: front matter lacks ${k}`);
  return { meta, body: source.slice(m[0].length) };
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = resolve(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : n.endsWith(".md") ? [relative(base, p)] : [];
  });
}

/** Path from one docs page directory to another, both relative to the site root, ending in "/". */
const linkBetween = (fromDir, toDir) => {
  const r = posix.relative(fromDir, toDir);
  return r === "" ? "./" : `${r}/`;
};

/**
 * @param site The public origin (https://imdusd.com) when building the site that is published there:
 * each page then carries its canonical URL and social-card tags, and a sitemap is written. Omitted
 * for the full export, whose host is not known.
 */
export function renderDocs({ outDir, contentDir, terminal, site }) {
  const files = walk(contentDir).map((f) => f.split("\\").join("/"));
  const pages = files.map((file) => {
    const { meta, body } = frontMatter(readFileSync(resolve(contentDir, file), "utf8"), file);
    const [section, name] = file.replace(/\.md$/, "").split("/");
    if (!SECTIONS.some(([s]) => s === section)) throw Error(`${file}: unknown section ${section}`);
    // A wholly redacted page gets a neutral address in the public build, so its URL does not leak.
    const slug = !terminal && REDACT_WHOLE.has(file) ? "redacted" : name;
    return { file, section, name, dir: `docs/${section}/${slug}`, meta, body, order: Number(meta.order) };
  });
  pages.sort(
    (a, b) =>
      SECTIONS.findIndex(([s]) => s === a.section) - SECTIONS.findIndex(([s]) => s === b.section) || a.order - b.order,
  );
  const byFile = new Map(pages.map((p) => [p.file, p]));

  const template = readFileSync(resolve(outDir, "docs/index.html"), "utf8");
  if (!template.includes("<!--DOCS-BODY-->")) throw Error("docs/index.html has no <!--DOCS-BODY--> slot");

  // The site mark (the favicon's pixels), in the text colour so it follows the theme.
  const favicon = readFileSync(resolve(contentDir, "../../public/favicon.svg"), "utf8");
  const markRects = favicon.match(/<g style="fill:var\(--text\)">(.*?)<\/g>/)?.[1];
  if (!markRects) throw Error("public/favicon.svg: mark not found");
  const mark = `<svg viewBox="0 0 16 16" width="28" height="28" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><g fill="currentColor">${markRects}</g></svg>`;

  // Sections fold closed; the one holding the current page starts open. Native <details>, no script.
  const nav = (currentDir) => {
    const here = pages.find((p) => p.dir === currentDir)?.section;
    return (
      `<nav class="docs-nav" id="docs-contents" aria-label="Documentation">` +
      `<a class="docs-home" href="${linkBetween(currentDir, "docs")}" aria-label="Docs home"${currentDir === "docs" ? ' aria-current="page"' : ""}>${mark}</a>` +
      SECTIONS.map(([s, label]) => {
        const items = pages.filter((p) => p.section === s);
        return `<details${s === here ? " open" : ""}><summary>${label}</summary><ul>${items
          .map(
            (p) =>
              `<li><a href="${linkBetween(currentDir, p.dir)}"${p.dir === currentDir ? ' aria-current="page"' : ""}>${titleHtml(p.meta.title, redact)}</a></li>`,
          )
          .join("")}</ul></details>`;
      }).join("") +
      `</nav>`
    );
  };

  const footer = (currentDir) => {
    const root = posix.relative(currentDir, "") || ".";
    return (
      `<footer class="site-footer">` +
      `<div class="foot-brand"><a class="wordmark" href="${root}/" aria-label="imdUSD home">imd<b>USD</b></a><span>Built on IdentityMD</span></div>` +
      `<nav class="foot-cols" aria-label="Footer">` +
      `<div class="foot-col"><span class="foot-h">Protocol</span>` +
      (terminal ? `<a href="${root}/terminal/">Terminal</a><a href="${root}/stats/">Stats</a>` : "") +
      `<a href="${linkBetween(currentDir, "docs")}">Docs</a></div>` +
      `<div class="foot-col"><span class="foot-h">Read</span><a href="https://blog.imdusd.com/">Blog</a>` +
      `<a href="https://whitepaper.imdusd.com" target="_blank" rel="noreferrer">Whitepaper ↗</a></div>` +
      `<div class="foot-col"><span class="foot-h">Ecosystem</span>` +
      `<a href="https://infer.imdusd.com" target="_blank" rel="noreferrer">INFER ↗</a><a href="${root}/links/">Links</a>` +
      `<span class="foot-icons"><a class="x-link" href="https://x.com/imdusd" target="_blank" rel="noreferrer" aria-label="imdUSD on X" title="imdUSD on X">` +
      `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a></span></div>` +
      `</nav></footer>`
    );
  };

  const redact = !terminal;
  // A vault function, event or error named in code links to its reference entry on its first mention
  // in a page. Headings and existing links are left alone; function names in tables are too (they are
  // dense there), but an error is mostly met in a "what can block it" table, so those do link.
  const REF_PAGES = [
    { file: "reference/vault-functions.md", inTables: false },
    { file: "reference/events-and-errors.md", inTables: true },
  ]
    .map((r) => ({ ...r, page: byFile.get(r.file) }))
    .filter((r) => r.page);
  const refOf = new Map();
  for (const r of REF_PAGES) for (const [, name] of r.page.body.matchAll(/^###\s+`(\w+)\(/gm)) refOf.set(name, r);
  const markAll = (key) => {
    const walk = (t) => {
      if (!t || typeof t !== "object") return;
      if (t.type === "codespan") t[key] = true;
      for (const k of ["tokens", "items", "header"]) if (Array.isArray(t[k])) t[k].forEach(walk);
      if (Array.isArray(t.rows)) t.rows.forEach((r) => r.forEach(walk));
    };
    return walk;
  };
  const noLink = markAll("noLink");
  const inTable = markAll("inTable");
  const render = (page) => {
    const linked = new Set();
    const whole = redact && REDACT_WHOLE.has(page.file);
    const hit = (raw) => redact && (whole || TERMINAL_RE.test(raw));
    const marked = new Marked({ gfm: true });
    const used = new Map();
    marked.use({
      walkTokens(token) {
        if (token.type === "heading") noLink(token);
        if (token.type === "table") inTable(token);
        if (token.type !== "link") return;
        noLink(token);
        const [target, hash] = token.href.split("#");
        if (/^[a-z]+:/i.test(target)) return; // external
        if (!target) return; // same-page anchor
        if (!target.endsWith(".md")) throw Error(`${page.file}: link to a non-page ${token.href}`);
        const file = posix.normalize(posix.join(posix.dirname(page.file), target));
        const to = byFile.get(file);
        if (!to) throw Error(`${page.file}: broken link ${token.href} (no ${file})`);
        token.href = linkBetween(page.dir, to.dir) + (hash ? `#${hash}` : "");
      },
      renderer: {
        // Swarm-written content: raw HTML is shown as text, never rendered.
        html: (token) => escapeHtml(token.text),
        paragraph(token) {
          return hit(token.raw) ? `<p>${bar(token.raw)}</p>\n` : `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
        },
        listitem(item) {
          if (!hit(item.raw)) return false; // default rendering
          return `<li>${bar(item.text)}</li>\n`;
        },
        // Tables are built here so every body cell carries its column's name (data-label): on a phone
        // each row becomes a stacked card, labelled from it. Redacted cells become bars.
        table(token) {
          const cell = (c) => (hit(c.text) ? bar(c.text) : this.parser.parseInline(c.tokens));
          // Alignment as a class, never an inline style: the public site's Content-Security-Policy
          // allows no inline styles, and a class is what the stylesheet already speaks.
          const align = (i) => (token.align[i] ? ` ta-${token.align[i]}` : "");
          const labels = token.header.map((h) => (hit(h.text) ? "" : plainText(h.text)));
          // A column whose every value is short never wraps; the long-prose columns take the squeeze.
          const short = token.header.map((_, i) => token.rows.every((r) => plainText(r[i]?.text ?? "").length <= 30));
          const cls = (i) => {
            const classes = `${short[i] ? "nowrap" : ""}${align(i)}`.trim();
            return classes ? ` class="${classes}"` : "";
          };
          const head = token.header.map((h, i) => `<th scope="col"${cls(i)}>${cell(h)}</th>`).join("");
          const rows = token.rows
            .map(
              (row) =>
                `<tr>${row.map((c, i) => `<td data-label="${escapeHtml(labels[i] ?? "")}"${cls(i)}>${cell(c)}</td>`).join("")}</tr>`,
            )
            .join("\n");
          return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
        },
        blockquote(token) {
          return hit(token.raw) ? `<blockquote><p>${bar(token.raw)}</p></blockquote>\n` : false;
        },
        code(token) {
          return hit(token.text) ? `<p>${bar(token.text)}</p>\n` : false;
        },
        codespan(token) {
          const m = /^(\w+)(\(.*\))?$/.exec(token.text);
          const ref = m && refOf.get(m[1]);
          if (!ref || page === ref.page || token.noLink || (token.inTable && !ref.inTables) || linked.has(m[1])) return false;
          linked.add(m[1]);
          return `<a class="fn-link" href="${linkBetween(page.dir, ref.page.dir)}#${m[1]}"><code>${token.text}</code></a>`;
        },
        heading(token) {
          const inner = whole && token.depth > 1
            ? bar(token.text)
            : redact && TERMINAL_RE.test(token.text)
              ? titleHtml(token.text, true)
              : this.parser.parseInline(token.tokens);
          // A redacted heading's id must not spell out what it hides.
          let id = whole || (redact && TERMINAL_RE.test(token.text)) ? "redacted" : slugify(token.text);
          // Reference entries get short anchors (#bark, #Bark, not #barkaddress-owner) so other pages can link them.
          const fn = REF_PAGES.some((r) => r.page === page) && /^`(\w+)\(/.exec(token.text);
          if (fn) id = fn[1];
          const n = used.get(id) ?? 0;
          used.set(id, n + 1);
          if (n) id = `${id}-${n}`;
          return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`;
        },
      },
    });
    return marked.parse(page.body);
  };

  // Check every #anchor link resolves to a heading on its target page.
  for (const p of pages) {
    // Launch values are shown as an em dash with one note per page, never spelled out inline.
    if (p.body.includes("(under consideration)")) throw Error(`${p.file}: write a pending value as — and set pending: true`);
  }
  const PENDING_NOTE = `<p class="pending-note">A <span aria-hidden="true">—</span><span class="sr-only">dash</span> marks a value set at mainnet launch.</p>`;
  const rendered = new Map(
    pages.map((p) => [p.file, p.meta.pending === "true" ? render(p).replace("</h1>", `</h1>${PENDING_NOTE}`) : render(p)]),
  );
  for (const p of pages) {
    for (const [, href] of rendered.get(p.file).matchAll(/href="([^"]*#[^"]+)"/g)) {
      const [path, hash] = href.split("#");
      const dir = path ? posix.normalize(posix.join(p.dir, path)).replace(/\/$/, "") : p.dir;
      const target = pages.find((q) => q.dir === dir);
      if (!target) continue;
      if (!rendered.get(target.file).includes(` id="${hash}"`)) throw Error(`${p.file}: anchor #${hash} not found in ${target.file}`);
    }
  }

  const page = (dir, title, description, body) => {
    const depth = dir.split("/").length; // docs = 1, docs/a/b = 3
    const up = "../".repeat(depth);
    let html = template;
    if (depth !== 1) html = html.replace(/(["'(])\.\.\//g, `$1${up}`);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
      .replace(
        /(<meta\s+name="description"\s+content=")[^"]*(")/,
        (_, a, b) => `${a}${escapeHtml(description)}${b}`,
      )
      .replace("<!--DOCS-BODY-->", body);
    if (site) html = html.replace("</head>", `${socialTags(site, `${site}/${dir}/`, title, description)}</head>`);
    mkdirSync(resolve(outDir, dir), { recursive: true });
    writeFileSync(resolve(outDir, dir, "index.html"), html);
  };

  const summary = (md) =>
    (md.replace(/^#.*$/gm, "").match(/^[^\s#>|`-].+$/m)?.[0] ?? "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[`*_]/g, "")
      .slice(0, 160);

  pages.forEach((p, i) => {
    const prev = pages[i - 1];
    const next = pages[i + 1];
    const sources = [...new Set((p.meta.sources ?? []).map((s) => s.replace(/:.*$/, "")))];
    const label = SECTIONS.find(([s]) => s === p.section)[1];
    const body =
      `<main class="docs" id="docs-main">` +
      `<a class="docs-skip" href="#docs-contents">Contents</a>` +
      `<article class="doc">` +
      `<p class="doc-meta">${label}${p.meta.audience ? ` · ${AUDIENCE[p.meta.audience] ?? escapeHtml(p.meta.audience)}` : ""}</p>` +
      (redact && REDACT_WHOLE.has(p.file) ? `<p class="redaction-note">Redacted until mainnet launch.</p>` : "") +
      rendered.get(p.file) +
      (sources.length && !(redact && REDACT_WHOLE.has(p.file))
        ? `<p class="doc-sources">Sources: ${sources.map((s) => `<a href="${REPO}${escapeHtml(s)}" target="_blank" rel="noreferrer">${escapeHtml(s)}</a>`).join(", ")}</p>`
        : "") +
      `<nav class="doc-pager" aria-label="Next and previous">` +
      (prev ? `<a class="prev" href="${linkBetween(p.dir, prev.dir)}"><span class="pager-label">Previous</span>${titleHtml(prev.meta.title, redact)}</a>` : "<span></span>") +
      (next ? `<a class="next" href="${linkBetween(p.dir, next.dir)}"><span class="pager-label">Next</span>${titleHtml(next.meta.title, redact)}</a>` : "<span></span>") +
      `</nav></article>` +
      nav(p.dir) +
      `</main>` +
      footer(p.dir);
    const desc = summary(p.body);
    const safeDesc = redact && (REDACT_WHOLE.has(p.file) || TERMINAL_RE.test(desc)) ? "" : desc;
    page(p.dir, `${titleText(p.meta.title, redact)} · imdUSD docs`, safeDesc || `imdUSD docs: ${titleText(p.meta.title, redact)}`, body);
  });

  const index =
    `<main class="docs" id="docs-main">` +
    `<a class="docs-skip" href="#docs-contents">Contents</a>` +
    `<article class="doc docs-index"><p class="doc-meta">imdUSD</p><h1>Documentation</h1>` +
    `<p class="lede">How imdUSD works, how to use it, and how to read and keep the contracts.</p>` +
    SECTIONS.map(([s, label]) => {
      const items = pages.filter((p) => p.section === s);
      return `<section><h2>${label}</h2><ul>${items
        .map(
          (p) =>
            `<li><a href="${linkBetween("docs", p.dir)}">${titleHtml(p.meta.title, redact)}</a>${p.meta.audience ? `<span class="audience">${AUDIENCE[p.meta.audience] ?? ""}</span>` : ""}</li>`,
        )
        .join("")}</ul></section>`;
    }).join("") +
    `</article>` +
    nav("docs") +
    `</main>` +
    footer("docs");
  page("docs", "imdUSD docs", "How imdUSD works: borrowing, redemption, liquidation, the swarm oracle and the contracts.", index);
  if (site) {
    // Every public page but the redacted one, which is not for crawlers until it has content.
    const urls = ["", ...(terminal ? ["stats/"] : []), "links/", "docs/", ...pages.filter((p) => !(redact && REDACT_WHOLE.has(p.file))).map((p) => `${p.dir}/`)];
    writeFileSync(
      resolve(outDir, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) => `  <url><loc>${site}/${u}</loc></url>`).join("\n") +
        `\n</urlset>\n`,
    );
    writeLlms({ outDir, pages, site, redact });
  }
  return pages.length;
}

// llms.txt (https://llmstxt.org): the site for a language model. llms.txt is the protocol in brief and
// an index of every docs page; llms-full.txt is every page as Markdown, in reading order. Both are
// built from the same content as the pages, so they cannot drift from them, and follow the same
// rules: what is redacted on a page is left out here (a dropped block, not a bar), and links are
// absolute.
const LLMS_SUMMARY = `# imdUSD

> imdUSD is a stablecoin meant to be worth one US dollar, borrowed against sIMD (staked IMD, the IdentityMD token) on Ethereum. Its collateral is priced by panels of IdentityMD agents answering a fixed question, signed and checked on chain. Any holder can redeem it for $1 of sIMD less a fee, and keepers liquidate positions that fall below the minimum collateral ratio.

Status: not yet launched on mainnet. Contract addresses and launch values are published at launch; in the docs a value set at launch is written as —. A listed address is not proof of a deployment: check it on chain, and check that each vault-created contract names the vault back, before integrating.

## The protocol in brief

- **Token.** \`ImdUSD\` ("imdUSD", ERC-20, 18 decimals). Only the vault mints and burns it. No owner, no pause, no upgrade path.
- **Vault.** \`ParameterizedVault\` holds every position (an account's collateral and debt). Its collateral, token, feeds, Treasury and parameters are fixed at deployment; no feed can be swapped.
- **Collateral.** sIMD, the 24-decimal share token of IdentityMD's staking vault. Deposit sIMD with \`lock\`, or IMD with \`lockIMD\` (the vault stakes it for you). Everything the vault pays out is sIMD; unstake it in the staking vault for IMD.
- **Borrow and repay.** \`draw\` mints imdUSD while collateral (in dollars) stays at least \`mat\` times debt; \`wipe\` repays (fees first); \`free\` withdraws collateral. Total principal is capped by the debt ceiling \`line\`. Debt grows with the annual stability fee \`duty\`.
- **Minimum collateral ratio.** \`mat\` follows the IdentityMD network health index (a signed figure, \`NhiFeed\`): a healthier network lowers it. The same index sets the liquidation grace \`lull\`.
- **Redemption (the price floor).** \`cash\` burns imdUSD for $1 of sIMD per imdUSD, less a fee that rises with redemption volume and decays over time. If backing per imdUSD (reserve plus secured collateral, over supply, never counted above $1) is below $1, every redeemer is paid that lower amount instead of redemption closing. The Treasury's sIMD pays first; then the redeemer names a borrower close to \`mat\`, whose debt is cancelled and collateral pays out. New capital counts toward backing only gradually, over about a day.
- **Liquidation.** Below \`mat\`, any keeper can mark a position (\`bark\`). After the grace \`lull\`, any keeper can liquidate (\`bite\`) within the window \`tail\`: burn imdUSD to cancel debt and receive sIMD worth it plus a bonus (\`CHOP_PERCENT\` of the debt repaid, shared by the marker (\`chip\`), the Treasury (\`cut\`) and the liquidator). \`heel\` clears a mark once the position is safe again. Bad debt can be cancelled with imdUSD the Treasury holds (\`cover\`); there is no insurance fund.
- **Price.** sIMD in dollars = IMD/ETH (\`PriceFeed\`: a block-window price the agent panels attest) × ETH/USD (Chainlink, via \`UsdPriceFeed\`) × IMD per sIMD (\`SharePriceFeed\`, from the staking vault). No key can set a price: anyone submits a signed answer through \`SwarmRelay\`, and a feed accepts it only if the signature, panel size, freshness, question and deviation bound all check out. A stale price refuses actions with \`StaleFeed\`.
- **Divergence guard.** A second IMD/ETH price, \`SpotFeed\` (the last block of the window), never prices anything; if it differs from the primary by more than \`skew\`, borrowing, risky withdrawals, work minting, marking, liquidating, clearing and redeeming pause with \`PriceDivergence\`. Deposits and repayments stay open.
- **Paying for prices.** \`OracleAsker\` buys price updates from the swarm, only when the health feed is near stale, a feed has been silent a whole lifetime, or IMD's pool has fallen below a price feed (never for a rise), funded by a governed daily IMD budget the Treasury sends (\`fundOracle\`).
- **Treasury.** Holds the reserve (sIMD and any governance-listed asset, each with a price feed and haircut) and the protocol's fees. Its operator can never withdraw collateral, a listed reserve asset, or imdUSD that outstanding bad debt needs.
- **Governance.** \`Parameters\` holds the economic settings. One governor proposes; every change waits a fixed 48-hour delay (\`TIMELOCK\`) and then anyone may apply it. Hard limits are written into the contract. There is no voting and no way to replace the feeds, the price signer, the collateral or the Treasury.
- **Minting from work.** \`earn\` mints imdUSD for accepted swarm tasks (\`wage\` per task) from \`SwarmWorkOracle\`, a signed tally rather than an on-chain proof, capped by the work ceiling \`earnLine\`. Off until governance sets a wage.
- **What is unproven.** The peg relies on traders redeeming below the redemption price; nothing pulls the price down from above $1. Prices and network health come from one signer answering fixed questions. A fast fall can outrun liquidation and leave bad debt.
- **INFER.** The protocol's token, with its own guide: https://infer.imdusd.com/llms.txt
`;

function writeLlms({ outDir, pages, site, redact }) {
  const shown = pages.filter((p) => !(redact && REDACT_WHOLE.has(p.file)));
  const byFile = new Map(shown.map((p) => [p.file, p]));
  const hit = (raw) => redact && TERMINAL_RE.test(raw);
  const absolute = (page, md) =>
    md.replace(/\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/g, (m, target, hash = "") => {
      if (/^[a-z]+:/i.test(target)) return m;
      const to = byFile.get(posix.normalize(posix.join(posix.dirname(page.file), target)));
      if (!to) throw Error(`${page.file}: llms link to a missing or redacted page ${target}`);
      return `](${site}/${to.dir}/${hash})`;
    });
  // A page's Markdown with every redacted block left out: a paragraph, heading, blockquote or code
  // block that mentions what is redacted; a list item; a table row (or the whole table, by its header).
  const body = (page) =>
    new Marked({ gfm: true })
      .lexer(page.body)
      .map((t) => {
        if (!hit(t.raw)) return t.raw;
        if (t.type === "list") {
          const items = t.items.filter((i) => !hit(i.raw));
          return items.length ? items.map((i) => i.raw.replace(/\n*$/, "\n")).join("") + "\n" : "";
        }
        if (t.type === "table") {
          const [head, rule, ...rows] = t.raw.trimEnd().split("\n");
          if (hit(head)) return "";
          return [head, rule, ...rows.filter((r) => !hit(r))].join("\n") + "\n\n";
        }
        return "";
      })
      .join("");
  const url = (p) => `${site}/${p.dir}/`;
  const summary = (md) =>
    (md.replace(/^#.*$/gm, "").match(/^[^\s#>|\`-].+$/m)?.[0] ?? "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[\`*_]/g, "")
      .replace(/(.{40,}?[.!?])\s.*$/, "$1");
  const index =
    LLMS_SUMMARY +
    SECTIONS.map(([s, label]) => {
      const items = shown.filter((p) => p.section === s);
      return `\n## ${label}\n\n${items
        .map((p) => {
          const d = summary(body(p));
          return `- [${p.meta.title}](${url(p)})${d && !hit(d) ? `: ${d}` : ""}`;
        })
        .join("\n")}\n`;
    }).join("") +
    `\n## Optional\n\n` +
    `- [Every docs page in one file](${site}/llms-full.txt): the full documentation as Markdown\n` +
    `- [Whitepaper](https://whitepaper.imdusd.com): the design and its reasoning\n` +
    `- [Source](${REPO.replace(/\/blob\/main\/$/, "")}): the contracts, with every docs page's sources cited\n` +
    `- [INFER](https://infer.imdusd.com/llms.txt): the protocol's token, its contracts and how to use them\n`;
  const full =
    `<!-- ${site}/docs as Markdown, generated at build. A value written — is set at mainnet launch. -->\n\n` +
    LLMS_SUMMARY +
    shown
      .map((p) => {
        const sources = [...new Set((p.meta.sources ?? []).map((x) => x.replace(/:.*$/, "")))];
        return (
          `\n---\n\n<!-- ${url(p)} -->\n\n` +
          absolute(p, body(p)).replace(/\n{3,}/g, "\n\n").trim() +
          (sources.length ? `\n\nSources: ${sources.map((x) => `${REPO}${x}`).join(", ")}` : "") +
          "\n"
        );
      })
      .join("");
  for (const [name, text] of [["llms.txt", index], ["llms-full.txt", full]]) {
    if (redact && TERMINAL_RE.test(text)) throw Error(`${name} mentions what the public site redacts`);
    writeFileSync(resolve(outDir, name), text);
  }
}

/** Canonical URL and the social-card tags for one page, for the <head> of a published page. */
export function socialTags(site, url, title, description, { type = "article" } = {}) {
  const e = escapeHtml;
  return (
    `<link rel="canonical" href="${e(url)}" />` +
    `<meta property="og:type" content="${type}" />` +
    `<meta property="og:site_name" content="imdUSD" />` +
    `<meta property="og:url" content="${e(url)}" />` +
    `<meta property="og:title" content="${e(title)}" />` +
    `<meta property="og:description" content="${e(description)}" />` +
    `<meta property="og:image" content="${e(site)}/icon-512.png" />` +
    `<meta property="og:image:width" content="512" />` +
    `<meta property="og:image:height" content="512" />` +
    `<meta name="twitter:card" content="summary" />` +
    `<meta name="twitter:title" content="${e(title)}" />` +
    `<meta name="twitter:description" content="${e(description)}" />` +
    `<meta name="twitter:image" content="${e(site)}/icon-512.png" />`
  );
}
