import { SiteHeader } from "./site";

/** The docs pages are static HTML built from web/content/docs; React adds only the shared header. Its own
 * module, so a docs page loads the header and nothing of the homepage's chain reads. */
export function Docs() {
  return <SiteHeader page="docs" />;
}
