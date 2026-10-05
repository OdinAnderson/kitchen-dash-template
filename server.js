'use strict';

// Kitchen dashboard server — the self-hosted alternative to an Azure Static Web App.
//
// Serves the static UI and the /api/state endpoint from one process, bound to
// LOOPBACK ONLY. Tailscale Serve publishes it to the tailnet over HTTPS, so nothing
// listens on a public interface and no port is opened on the host.
//
// Access control is tailnet membership. There is no sign-in flow, no identity
// provider, and no session to expire — which is the point: a wall display that
// needs re-authenticating is a wall display that is sometimes blank. The tablet is
// on the tailnet or it cannot reach this at all.
//
// The Graph client secret is read from a dedicated env file owned by this service
// (systemd EnvironmentFile, mode 600), NOT from a shared shell/profile env file that
// other processes inherit. The dashboard's credential has no business being reachable
// from anything else running on the host.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchCalendarView } = require('./api/src/lib/graph');
const { buildState } = require('./api/src/lib/calendar');
const { fetchAirQuality, isValidCoords } = require('./api/src/lib/air');

const PORT = Number(process.env.PORT || 8788);
const HOST = '127.0.0.1';
const ROOT = __dirname;
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/New_York';
const COUNTDOWN_MARKERS = process.env.COUNTDOWN_MARKERS || '';
const WINDOW_DAYS = 365;

// Cache the shaped payload briefly. The screen polls every 30 minutes, but a reload,
// a second device, or a hand refresh should not each re-mint a token and re-read the
// calendar.
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, tz: null, body: null };

// Air quality gets its own cache, keyed on coordinates: location is a per-device
// preference, so the kitchen tablet and a travelling phone ask for different places
// and must not share an entry. Stations report hourly, so a 15-minute TTL never
// serves anything materially stale while collapsing every device — and every reload —
// into one upstream call. That matters here: the WAQI token is a free non-commercial
// one, and this is the whole of its quota protection.
const AIR_CACHE_MS = 15 * 60 * 1000;
// Bounded so a device that wanders through many locations cannot grow this without
// limit; entries are cheap and the working set is realistically one or two.
const AIR_CACHE_MAX = 32;
const airCache = new Map(); // key -> { at, body }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function resolveTimeZone(requested) {
  if (!requested) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: requested });
    return requested;
  } catch {
    return DEFAULT_TZ;
  }
}

async function handleState(req, res, url) {
  const tz = resolveTimeZone(url.searchParams.get('tz'));

  if (cache.body && cache.tz === tz && Date.now() - cache.at < CACHE_MS) {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'X-Cache': 'hit' });
    return res.end(cache.body);
  }

  try {
    const now = new Date();
    const end = new Date(now.getTime() + WINDOW_DAYS * 86400000);
    const events = await fetchCalendarView(now.toISOString(), end.toISOString());
    const body = JSON.stringify(buildState(events, tz, now, COUNTDOWN_MARKERS));

    cache = { at: Date.now(), tz, body };
    console.log(`[state] ${events.length} events, tz=${tz}`);

    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'X-Cache': 'miss' });
    res.end(body);
  } catch (err) {
    // Detail to the log, not to the screen — errors here can name configuration.
    console.error('[state] failed:', err.message);
    res.writeHead(502, { 'Content-Type': TYPES['.json'] });
    res.end(JSON.stringify({ error: 'calendar_unavailable' }));
  }
}

/**
 * GET /api/air?lat=&lon= — nearest reporting ground station.
 *
 * Exists server-side only because the WAQI token is a credential; the upstream call
 * is CORS-clean and the browser could make it directly, but not without committing
 * the token. See api/src/lib/air.js.
 */
async function handleAir(req, res, url) {
  const rawLat = url.searchParams.get('lat');
  const rawLon = url.searchParams.get('lon');

  // Presence is checked before conversion: Number(null) and Number('') are both 0,
  // and 0,0 is a REAL coordinate off West Africa — so without this a request that
  // simply forgot its parameters would quietly return a station in the Gulf of Guinea
  // instead of an error.
  if (!rawLat || !rawLon) {
    res.writeHead(400, { 'Content-Type': TYPES['.json'] });
    return res.end(JSON.stringify({ error: 'invalid_coordinates' }));
  }

  const lat = Number(rawLat);
  const lon = Number(rawLon);

  // Validated rather than trusted, in the same spirit as resolveTimeZone: these go
  // into an outbound URL, so they are checked as real coordinates before use.
  if (!isValidCoords(lat, lon)) {
    res.writeHead(400, { 'Content-Type': TYPES['.json'] });
    return res.end(JSON.stringify({ error: 'invalid_coordinates' }));
  }

  // ~110m of precision, which is far finer than the distance to any station and
  // keeps devices in the same house on one cache entry.
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const hit = airCache.get(key);
  if (hit && Date.now() - hit.at < AIR_CACHE_MS) {
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'X-Cache': 'hit' });
    return res.end(hit.body);
  }

  try {
    const air = await fetchAirQuality(lat, lon);
    // null means the nearest station is online but reporting nothing right now. That
    // is cached too — it is a real answer, and re-asking every 30s would not change it.
    const body = JSON.stringify(air || { aqi: null });

    if (airCache.size >= AIR_CACHE_MAX) airCache.delete(airCache.keys().next().value);
    airCache.set(key, { at: Date.now(), body });

    console.log(`[air] ${air ? `aqi=${air.aqi} station=${air.station}` : 'no reading'}`);
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'X-Cache': 'miss' });
    res.end(body);
  } catch (err) {
    // Detail to the log, not to the screen — the message can name configuration.
    // The client treats this as "no AQI" and keeps the forecast, so a missing token
    // costs the ring and nothing else.
    console.error('[air] failed:', err.message);
    res.writeHead(502, { 'Content-Type': TYPES['.json'] });
    res.end(JSON.stringify({ error: 'air_unavailable' }));
  }
}

// Static files are served from an explicit ALLOWLIST, not from the whole directory.
// The clone also holds .git/, README, package files, deploy/ and api/ source; none of
// that is UI and none of it should be reachable over the network. Anything not
// listed here is a 404 — including dotfiles (.env*, .git), which are additionally
// rejected by segment before the allowlist is even consulted.
//
// CUSTOMIZE: if you add a UI file that index.html loads, add it here.
const STATIC_FILES = new Set([
  'index.html',
  'diag.html',            // standalone render diagnostic for kiosk WebViews
  'app.js',
  'data.js',
  'weather.js',
  'location.js',
  'location-ui.js',
  'style.css',
  'styles-location.css',
  'favicon.svg',
  'manifest.json',
]);
// Directories served one level deep, restricted by extension.
const STATIC_DIRS = new Map([
  ['icons', new Set(['.png'])],
  ['weather-icons', new Set(['.svg'])],
]);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Map a request pathname to an absolute file path, or null if it must not be served.
 * Pure (no I/O), so it can be unit-tested.
 */
function resolveStaticPath(pathname, root = ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  let rel = decoded.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  const segments = rel.split('/');
  // No empty, '.', '..' or dot-prefixed segments anywhere: blocks traversal and every
  // dotfile/dot-directory (.git, .env, .env.example, …) regardless of the allowlist.
  if (segments.some((seg) => seg === '' || seg.startsWith('.'))) return null;

  let allowed = false;
  if (segments.length === 1) {
    allowed = STATIC_FILES.has(segments[0]);
  } else if (segments.length === 2) {
    const exts = STATIC_DIRS.get(segments[0]);
    allowed = !!exts && SAFE_NAME.test(segments[1]) &&
      exts.has(path.extname(segments[1]).toLowerCase());
  }
  if (!allowed) return null;

  // Belt and braces: normalise and confirm the result is still inside root.
  const full = path.resolve(root, ...segments);
  if (!full.startsWith(path.resolve(root) + path.sep)) return null;
  return full;
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
}

function serveStatic(req, res, url) {
  // Tailscale Serve strips its --set-path mount prefix before proxying, so the path
  // here is relative to the app root.
  const full = resolveStaticPath(url.pathname);
  if (!full) return notFound(res);

  fs.readFile(full, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      // The UI is versioned by query string in index.html; a short cache keeps a
      // kiosk reload cheap without pinning stale code for long.
      'Cache-Control': 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    // Matched by suffix so the app works under any mount path Serve gives it.
    if (url.pathname.endsWith('/api/state')) return handleState(req, res, url);
    if (url.pathname.endsWith('/api/air')) return handleAir(req, res, url);
    if (url.pathname.endsWith('/healthz')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    serveStatic(req, res, url);
  });
}

// Listen only when run directly (`node server.js`); tests require() this module and
// start their own instance on an ephemeral port.
if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`kitchen-dash listening on http://${HOST}:${PORT} (loopback only)`);
    console.log(`  calendar: ${process.env.CALENDAR_MAILBOX || '(CALENDAR_MAILBOX unset)'}`);
    // Presence only — never the value.
    console.log(`  air:      ${process.env.WAQI_TOKEN ? 'WAQI token set' : '(WAQI_TOKEN unset — AQI disabled)'}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

module.exports = { createServer, resolveStaticPath, STATIC_FILES, STATIC_DIRS };
