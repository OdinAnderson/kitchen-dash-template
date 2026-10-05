'use strict';

// Air quality for the kitchen dashboard, from the World Air Quality Index project.
//
// WAQI aggregates real government monitoring stations — typically a state or
// national agency / AirNow station a few km from the display. This replaces
// Open-Meteo's air quality feed, which is a 45km CAMS *model* grid cell over North
// America with no US ground stations blended into it. The two disagree badly: measured
// on 2026-09-06, eight real monitors within 17km read 13-40 while Open-Meteo claimed
// 57 for the same coordinates — a band change, Good reported as Moderate. For a tile
// whose entire job is "should I open a window right now", that is the wrong answer.
//
// This runs server-side ONLY because the token is a credential. The call itself is
// CORS-clean and would work from the browser, but embedding the token would commit it
// to the repo. The forecast stays client-side precisely because it needs no credential.
//
// The token is never logged and never returned in a response — note that the request
// URL carries it as a query parameter, so the URL itself must not appear in any error.

const WAQI_TIMEOUT_MS = 10_000;

/** Great-circle distance in km, to report how far the reporting station actually is. */
function distanceKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** True for a real, finite coordinate pair inside the valid range. */
function isValidCoords(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/**
 * WAQI's feed payload -> the fields the dashboard needs. Pure: no network, no env,
 * so the shaping is unit-testable the same way the calendar's is.
 *
 * Deliberately does NOT compute the AQI band (label/colour). That logic lives in
 * weather.js, which already owns it and exports it for tests — duplicating the EPA
 * breakpoints here would give us two copies to keep in step.
 *
 * Returns null rather than throwing when a station has nothing to report: WAQI sends
 * `aqi: "-"` for a station that is online but currently has no reading, which is a
 * normal state and not an error.
 */
function shapeAir(payload, lat, lon) {
  if (!payload || payload.status !== 'ok' || !payload.data) return null;

  const d = payload.data;
  // "-" (no current reading) is a string, so this rejects it without special-casing.
  if (typeof d.aqi !== 'number' || !Number.isFinite(d.aqi)) return null;

  const geo = d.city && Array.isArray(d.city.geo) ? d.city.geo : null;
  const km = geo && geo.length === 2 && isValidCoords(lat, lon)
    ? Math.round(distanceKm(lat, lon, geo[0], geo[1]) * 10) / 10
    : null;

  return {
    aqi: Math.round(d.aqi),
    station: d.city && d.city.name ? d.city.name : null,
    distanceKm: km,
    observedAt: d.time && d.time.iso ? d.time.iso : null,
    dominant: d.dominentpol || null, // WAQI's spelling, not a typo on our side
    // Displaying these is a condition of WAQI's terms, so they travel with the data
    // rather than being something the UI has to remember to source separately.
    attributions: Array.isArray(d.attributions)
      ? d.attributions.map((a) => a && a.name).filter(Boolean)
      : [],
  };
}

/**
 * Fetch the nearest reporting station for a coordinate pair.
 *
 * Throws on misconfiguration or a failed call so the caller can distinguish that from
 * "station has no reading" (null). The thrown message never includes the URL.
 */
async function fetchAirQuality(lat, lon) {
  const token = process.env.WAQI_TOKEN;
  if (!token) throw new Error('Missing required application setting: WAQI_TOKEN');
  if (!isValidCoords(lat, lon)) throw new Error('Invalid coordinates');

  const url = `https://api.waqi.info/feed/geo:${lat};${lon}/?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(WAQI_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`WAQI request failed: ${res.status}`);

  const payload = await res.json();
  if (payload && payload.status === 'error') {
    // payload.data is a short reason such as "Invalid key" — safe to surface, and the
    // one message worth seeing in a log because it means the token needs attention.
    throw new Error(`WAQI error: ${payload.data}`);
  }

  return shapeAir(payload, lat, lon);
}

module.exports = { fetchAirQuality, shapeAir, distanceKm, isValidCoords };
