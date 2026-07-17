// ============================================================
// Parse a location the operator pastes when configuring a channel's address.
// Getting coordinates WRONG sends the customer to the wrong place, so this is
// pinned down by tests. Accepts:
//   - a Google Maps link   (…?q=LAT,LNG…  or  …/@LAT,LNG,17z…)
//   - raw "LAT, LNG"       (-20.41, -54.56)
// Shortened maps.app.goo.gl / goo.gl links carry no coordinates in the URL
// (they need a redirect to resolve) → returns null so the UI can ask for the
// full link instead of silently sending a wrong pin.
// ============================================================

export interface LatLng {
  lat: number;
  lng: number;
}

function inRange(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Extract coordinates from a pasted Maps link or a raw "lat, lng" string.
 *  Returns null when nothing valid is found. */
export function parseLocation(input: string): LatLng | null {
  if (!input) return null;
  const s = decodeURIComponent(input.trim());

  // Google Maps `q=LAT,LNG` or `query=LAT,LNG` (the share-a-pin format).
  const q = s.match(/[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (q) {
    const lat = parseFloat(q[1]);
    const lng = parseFloat(q[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // Google Maps `/@LAT,LNG,zoom` (the map-view URL).
  const at = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = parseFloat(at[1]);
    const lng = parseFloat(at[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // Raw "LAT, LNG" — only when the whole string is just the pair, so a random
  // number inside other text can't be mistaken for coordinates.
  const raw = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (raw) {
    const lat = parseFloat(raw[1]);
    const lng = parseFloat(raw[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  return null;
}

/** The clickable Google Maps link we store as the chat message text for a sent
 *  location — same shape the inbound parser produces, so a sent pin reads like
 *  a received one in the thread. */
export function mapsLink(loc: LatLng): string {
  return `https://maps.google.com/maps?q=${loc.lat},${loc.lng}&z=17&hl=pt-BR`;
}
