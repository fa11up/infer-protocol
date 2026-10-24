// Re-reads the issuer's restricted-jurisdictions page and fails if the paragraph src/geofence.json quotes has
// changed (GEOFENCE: re-read at every terminal deploy and at least monthly). Network; not part of `npm test`.
import GEO from "../src/geofence.json" with { type: "json" };

const norm = (s) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
const res = await fetch(GEO.issuer.restrictedJurisdictions, { headers: { "user-agent": "imdusd-geofence-check" } });
if (!res.ok) {
  console.error(`geofence-terms: ${GEO.issuer.restrictedJurisdictions} answered ${res.status}`);
  process.exit(1);
}
const page = norm(await res.text());
if (!page.includes(norm(GEO.issuer.quote))) {
  console.error("geofence-terms: the issuer's restricted-jurisdictions text changed since " + GEO.issuer.read + ": re-read it, update src/geofence.json, get legal's sign-off");
  process.exit(1);
}
console.log(`geofence-terms: unchanged since ${GEO.issuer.read}`);
