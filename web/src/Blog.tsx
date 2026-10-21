import { SiteHeader } from "./site";

/** The blog's pages are static HTML built from web/content/blog (scripts/blog-pages.mjs); React adds only the
 * shared header, as on the docs pages. The blog reads no chain, so the header carries no price chips. */
export function Blog() {
  return <SiteHeader page="blog" />;
}
