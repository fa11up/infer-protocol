// GET /geo: may this visitor be offered tokenized-stock collateral (planned)? Cloudflare's country for the request
// against src/geofence.json. The page never decides on its own; it renders what this answer allows, and an
// unknown country (no cf object, no header, XX, Tor's T1) is a "no". IP geolocation is beaten by a VPN or proxy:
// this makes our site follow the issuer's terms, it is not a security boundary (the contracts are permissionless).
import GEO from "../src/geofence.json" with { type: "json" };

const BLOCKED = new Set([...Object.values(GEO.blocked).flat(), ...GEO.failClosed]);

/** The visitor's ISO 3166-1 alpha-2 country, upper case, or "" when Cloudflare gave none. */
export function countryOf(request) {
  const c = request.cf?.country ?? request.headers.get("cf-ipcountry") ?? "";
  return /^[A-Za-z][A-Za-z0-9]$/.test(c) ? c.toUpperCase() : "";
}

/** { country, stocks, reason } for a country code ("" = unknown). */
export function geoAnswer(country) {
  if (!country) return { country: "", stocks: false, reason: "unknown" };
  if (BLOCKED.has(country)) return { country, stocks: false, reason: GEO.failClosed.includes(country) ? "unknown" : "restricted" };
  return { country, stocks: true, reason: "allowed" };
}

export function handleGeo(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET only", { status: 405, headers: { allow: "GET, HEAD" } });
  return new Response(JSON.stringify(geoAnswer(countryOf(request))), {
    headers: { "content-type": "application/json", "cache-control": "no-store", vary: "cf-ipcountry" },
  });
}
