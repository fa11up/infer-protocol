// The scaffold of imdusd.com's plain reading pages (/build/, /partners/): the site header and footer around a title,
// a lede and sections of cards. They read no chain, so they are in every build, like the links page.
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "./site";

export function InfoPage({
  page,
  kicker,
  title,
  lede,
  children,
}: {
  page: "build" | "partners";
  kicker: string;
  title: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="site">
      <SiteHeader page={page} />
      <main className="plain" id="main">
        <header className="plain-head">
          <p className="micro">{kicker}</p>
          <h1>{title}</h1>
          <div className="lede">{lede}</div>
        </header>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

/** A titled section; its id is the heading's anchor. */
export function InfoSection({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="plain-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {intro && <p className="plain-intro">{intro}</p>}
      {children}
    </section>
  );
}

export type InfoLink = { text: string; url: string; external?: boolean };
/** One card: a heading, a few lines and its links, the first of which is the card's main action. */
export function Card({ title, tag, children, links = [] }: { title: string; tag?: string; children: ReactNode; links?: InfoLink[] }) {
  return (
    <article className="plain-card">
      <h3>
        {title}
        {tag && <span className="plain-tag">{tag}</span>}
      </h3>
      <div className="plain-card-body">{children}</div>
      {links.length > 0 && (
        <p className="plain-links">
          {links.map((l) => (
            <a key={l.url} href={l.url} {...(l.external ? { target: "_blank", rel: "noreferrer" } : {})}>
              {l.text}
              {l.external ? (
                <>
                  {" ↗"}
                  <span className="sr-only"> (opens in a new tab)</span>
                </>
              ) : (
                " →"
              )}
            </a>
          ))}
        </p>
      )}
    </article>
  );
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="plain-cards">{children}</div>;
}
