// Location preference for the kitchen dashboard.
//
// Per-device, stored in localStorage: the kitchen screen keeps its home city while a copy
// opened elsewhere holds its own. Same origin, separate storage.
//
// The timezone is never typed or guessed — it arrives from Open-Meteo's geocoding
// response alongside the coordinates, and is what both the weather call and the
// calendar's day bucketing are keyed on. Change the location, and the whole display
// re-buckets to match.

(function (global) {
  'use strict';

  var STORAGE_KEY = 'kitchen-dash.location';

  // Default location until a device picks its own. CUSTOMIZE: set this to your city
  // (any name; the coordinates and IANA timezone are what matter).
  var DEFAULT_LOCATION = Object.freeze({
    name: 'New York',
    region: 'New York',
    country: 'US',
    latitude: 40.7128,
    longitude: -74.0060,
    timezone: 'America/New_York',
  });

  function isUsable(loc) {
    return !!loc &&
      typeof loc.latitude === 'number' &&
      typeof loc.longitude === 'number' &&
      typeof loc.timezone === 'string' &&
      !!loc.timezone;
  }

  /**
   * The stored location, or the default above.
   * Storage can throw (private mode, cleared site data, a kiosk with storage
   * disabled), and a half-written value is worse than none — so anything
   * unreadable or malformed falls back rather than propagating.
   */
  function getLocation() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_LOCATION;
      var parsed = JSON.parse(raw);
      return isUsable(parsed) ? parsed : DEFAULT_LOCATION;
    } catch (e) {
      return DEFAULT_LOCATION;
    }
  }

  /** Persist a location. Returns false if storage refused it; the caller still works. */
  function setLocation(loc) {
    if (!isUsable(loc)) return false;
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearLocation() {
    try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to do */ }
  }

  /** "Springfield, Illinois" — what the settings control shows. */
  function describe(loc) {
    var l = loc || getLocation();
    return [l.name, l.region].filter(Boolean).join(', ');
  }

  /**
   * City search via Open-Meteo's geocoding API. No key, no auth, same provider as
   * the forecast.
   *
   * Results are disambiguated on purpose: "Springfield" matches Illinois, Missouri
   * and Massachusetts, so the caller must show region and country or the
   * wrong one gets picked silently.
   */
  async function searchPlaces(query, limit) {
    var q = (query || '').trim();
    if (q.length < 2) return [];

    var url = 'https://geocoding-api.open-meteo.com/v1/search' +
      '?name=' + encodeURIComponent(q) +
      '&count=' + (limit || 8) +
      '&language=en&format=json';

    var res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error('Place search failed: ' + res.status);

    var data = await res.json();
    return (data.results || [])
      .map(function (r) {
        return {
          name: r.name,
          region: r.admin1 || '',
          country: r.country_code || '',
          latitude: r.latitude,
          longitude: r.longitude,
          timezone: r.timezone,
        };
      })
      .filter(isUsable);
  }

  global.KitchenLocation = {
    DEFAULT: DEFAULT_LOCATION,
    get: getLocation,
    set: setLocation,
    clear: clearLocation,
    describe: describe,
    search: searchPlaces,
  };
})(window);
