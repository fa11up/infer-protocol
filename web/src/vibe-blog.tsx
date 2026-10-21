// blog.imdusd.com's backgrounds: imdUSD's own banknote crafts (vibe-imdusd.tsx), led by one of the blog's own:
// "Folio", a family of rose curves plotted as hairlines, the kind of figure a mathematician's notebook or a
// note's guilloché is built from, over the faint ruled lines of a ledger. Slower and fainter than the terminal's:
// the reading column sits on a solid sheet in front of it (style.css .post, .ledger).
import type { Scene, Suite } from "./vibe";
import { IMDUSD_SCENES } from "./vibe-imdusd";

const FOLIO: Scene = {
  id: "folio",
  label: "Folio",
  icon: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M12 4 C15 8 15 16 12 20 C9 16 9 8 12 4 Z" />
      <path d="M4 12 C8 9 16 9 20 12 C16 15 8 15 4 12 Z" />
      <circle cx="12" cy="12" r="1.6" />
    </g>
  ),
  // Concentric rose curves r = a(1 + e cos(k(th + turn))): each hairline is one level of the family, the
  // petals turning a degree or so a minute; under them the page's ledger rules, drifting by a fraction of a line.
  main: `
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 p = (frag - uCenter) / uScale;
  float t = uTime;
  float r = length(p);
  float th = atan(p.y, p.x);
  float k = 7.0;
  float rose = 1.0 + 0.16 * cos(k * (th + t * 0.006)) + 0.05 * cos(3.0 * (th - t * 0.004));
  float level = r / rose;
  float petals = lines(level * 26.0, 1.0) * smoothstep(0.08, 0.2, level) * (1.0 - smoothstep(0.9, 1.15, level));
  float spokes = lines((th + t * 0.003) * 72.0 / 6.2831853, 0.8) * smoothstep(0.55, 0.62, level) * (1.0 - smoothstep(0.78, 0.84, level));
  vec2 q = frag / uRes.y;
  float rules = lines(q.y * 34.0 + 0.15 * sin(q.x * 3.0 + t * 0.05), 0.9);
  float ink = max(petals * uInk1 * 0.85, spokes * uInk1 * 0.5);
  ink = max(ink, rules * uInk1 * 0.22);
  outColor = paint(ink * presence(frag));
}`,
};

export const BLOG_VIBES: Suite = {
  key: "imdusd-blog-vibe",
  scenes: [FOLIO, ...IMDUSD_SCENES],
  // Wide screens: the figure sits in the right margin, beside the reading column. Narrow: high up, behind the masthead.
  focus: (wide) => (wide ? [0.9, 0.62, 0.42] : [0.5, 0.9, 0.42]),
};
