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

function serveStatic(req, res, url) {
  // Strip any mount prefix Tailscale Serve adds, then resolve inside ROOT and verify
  // the result really is inside ROOT — a path check done after normalisation, so
  // encoded traversal cannot escape.
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      // The UI is versioned by query string in index.html; a short cache keeps a
      // kiosk reload cheap without pinning stale code for long.
      'Cache-Control': 'public, max-age=300',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

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

server.listen(PORT, HOST, () => {
  console.log(`kitchen-dash listening on http://${HOST}:${PORT} (loopback only)`);
  console.log(`  calendar: ${process.env.CALENDAR_MAILBOX || '(CALENDAR_MAILBOX unset)'}`);
  // Presence only — never the value.
  console.log(`  air:      ${process.env.WAQI_TOKEN ? 'WAQI token set' : '(WAQI_TOKEN unset — AQI disabled)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
