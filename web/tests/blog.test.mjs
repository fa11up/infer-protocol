// blog.imdusd.com's content and build rules (scripts/blog-pages.mjs): every post has its front matter, slugs are
// unique, the feed is well-formed XML naming every post, a post renders its title, living line and contents, and
// both sites' navigation links the blog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readPosts, renderBlog, feed, frontMatter, plate, BLOG_SITE } from "../scripts/blog-pages.mjs";

const content = new URL("../content/blog/", import.meta.url).pathname;

/** A small well-formedness check: every tag closes in order and every & is an entity. */
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(body), "a bare & in the XML");
  const stack = [];
  for (const [, close, name, self] of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
    if (self) continue;
    if (close) assert.equal(stack.pop(), name, `</${name}> closes the wrong element`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], "unclosed elements");
}

test("every post has the required front matter and a unique, URL-safe slug", () => {
  const posts = readPosts(content);
  assert.ok(posts.length >= 1);
  for (const p of posts) {
    for (const k of ["title", "date", "summary", "author"]) assert.ok(p.meta[k], `${p.file}: ${k}`);
    assert.match(p.meta.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
  assert.equal(new Set(posts.map((p) => p.slug)).size, posts.length);
  // newest first; issue numbers count from the oldest
  for (let i = 1; i < posts.length; i++) assert.ok(posts[i - 1].meta.date >= posts[i].meta.date);
  assert.deepEqual([...posts.map((p) => p.issue)].sort((a, b) => a - b), posts.map((_, i) => i + 1));
});

test("front matter refuses a post without a title, and a malformed date", () => {
  assert.throws(() => frontMatter("---\ndate: 2026-10-21\nsummary: x\n---\nbody", "x.md"), /lacks title/);
  assert.throws(() => frontMatter('---\ntitle: "t"\ndate: 21 Oct\nsummary: x\n---\n', "x.md"), /YYYY-MM-DD/);
});

test("the feed is well-formed RSS naming every post", () => {
  const posts = readPosts(content);
  const xml = feed(posts);
  wellFormed(xml);
  assert.match(xml, /<rss version="2.0"/);
  for (const p of posts) assert.ok(xml.includes(`<link>${BLOG_SITE}/${p.slug}/</link>`), p.slug);
  // titles with XML-special characters are escaped
  wellFormed(feed([{ slug: "a", meta: { title: 'A & B <"c">', summary: "x & y", date: "2026-01-01" } }]));
});

test("a post renders its title, plate, living line, contents and changelog; raw HTML is text", () => {
  const out = mkdtempSync(join(tmpdir(), "blog-"));
  const dir = mkdtempSync(join(tmpdir(), "blog-content-"));
  const blog = join(dir, "content", "blog");
  mkdirSync(blog, { recursive: true });
  mkdirSync(join(dir, "public"));
  copyFileSync(new URL("../public/favicon.svg", import.meta.url), join(dir, "public", "favicon.svg"));
  const sections = ["One", "Two", "Three", "Four"].map((h) => `## ${h}\n\nText.\n`).join("\n");
  writeFileSync(
    join(blog, "test-post.md"),
    `---\ntitle: "A test"\ndate: 2026-10-21\nupdated: 2026-10-22\nsummary: "Sum"\nliving: true\n---\n${sections}\n<script>alert(1)</script>\n\n| Item | Amount |\n|---|---|\n| a | 1,000 |\n\n## Changelog\n\n- **2026-10-21** First.\n`,
  );
  writeFileSync(join(out, "index.html"), `<html><head><title>x</title><meta name="description" content="" /></head><body><!--BLOG-BODY--><script type="module" src="./assets/a.js"></script></body></html>`);
  renderBlog({ outDir: out, contentDir: blog });
  const html = readFileSync(join(out, "test-post", "index.html"), "utf8");
  assert.match(html, /<h1>A test<\/h1>/);
  assert.match(html, /class="plate post-plate"/);
  assert.match(html, /Living document<\/span>Last updated 22 Oct 2026/);
  assert.match(html, /href="#changelog">Changelog/);
  assert.match(html, /class="post-toc"/);
  assert.match(html, /<td data-label="Amount" class="num">1,000<\/td>/);
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw HTML must not render");
  assert.match(html, /\.\.\/assets\/a\.js/, "a post's asset paths point one level up");
  assert.match(html, /twitter:card" content="summary"/);
  const index = readFileSync(join(out, "index.html"), "utf8");
  assert.match(index, /href="test-post\/"/);
  assert.match(readFileSync(join(out, "404.html"), "utf8"), /name="robots" content="noindex"/);
});

test("the plate is deterministic per slug and carries no inline style", () => {
  assert.equal(plate("a"), plate("a"));
  assert.notEqual(plate("a"), plate("b"));
  assert.ok(!/style=/.test(plate("a")));
});

test("both sites link the blog from the shared footer and the docs pages' footer, not the header", () => {
  const site = readFileSync(resolve(content, "../../src/site.tsx"), "utf8");
  assert.match(site, /export const BLOG = "https:\/\/blog\.imdusd\.com\/"/);
  const header = site.slice(site.indexOf("export function SiteHeader"), site.indexOf("export function SiteFooter"));
  const footer = site.slice(site.indexOf("export function SiteFooter"));
  assert.doesNotMatch(header, />\s*(Blog|Whitepaper ↗)\s*<\/a>/, "header carries neither a Blog nor a Whitepaper link");
  assert.match(footer, />\s*Blog\s*<\/a>/);
  assert.match(footer, /Whitepaper ↗/);
  assert.match(readFileSync(resolve(content, "../../scripts/docs-pages.mjs"), "utf8"), /https:\/\/blog\.imdusd\.com\/">Blog</);
});
