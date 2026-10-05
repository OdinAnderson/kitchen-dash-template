// Data layer for the kitchen dashboard.
//
// Replaces the legacy `fetch('state.json')` against a file written by cron. Calendar
// data now comes from /api/state (a managed Function reading one scoped mailbox), and
// weather is fetched straight from Open-Meteo, which needs no credential.
//
// The two are merged into the same object shape the renderer already consumes, so
// updateFromState() and the widgets below it are untouched.

(function (global) {
  'use strict';

  // Network fetch cadence. The legacy screen re-fetched every 60 seconds against a
  // local file; against a Function that is 1,440 needless invocations a day for data
  // that changes a few times a week.
  var STATE_POLL_MS = 30 * 60 * 1000;

  // Local reminder cadence. This is deliberately NOT the fetch interval: the chime
  // fires when an event is within 15 minutes, so a 30-minute check could step over
  // the window entirely and never sound. The tick re-evaluates events already in
  // memory — no network, no Function invocation.
  var TICK_MS = 60 * 1000;

  /** Send the viewer to sign in again rather than leaving a stale screen up. */
  function reauthenticate() {
    var here = global.location.pathname + global.location.search;
    global.location.href = '/.auth/login/aad?post_login_redirect_uri=' + encodeURIComponent(here);
  }

  async function fetchCalendar(location) {
    // Resolved against the document rather than the site root: the dashboard may be
    // mounted at /kitchen/ by Tailscale Serve, or at / on a static host. An absolute
    // path would break under the former.
    var url = new URL('api/state?tz=' + encodeURIComponent(location.timezone),
                      global.document.baseURI).toString();
    var res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });

    // Only meaningful on a host that fronts this with a sign-in flow. Served over
    // Tailscale, access is tailnet membership and this never fires.
    if (res.status === 401 || res.status === 403) {
      reauthenticate();
      return null;
    }
    if (!res.ok) throw new Error('state HTTP ' + res.status);
    return res.json();
  }

  /**
   * One refresh: calendar and weather in parallel, merged.
   *
   * Settled rather than all() on purpose — a weather outage must not blank the
   * calendar, and vice versa. Returns null only when the calendar itself failed,
   * which the caller treats as "keep showing the last good state".
   */
  async function fetchState() {
    var location = global.KitchenLocation.get();

    var results = await Promise.allSettled([
      fetchCalendar(location),
      global.KitchenWeather.fetch(location),
    ]);

    var calendar = results[0].status === 'fulfilled' ? results[0].value : null;
    var weather = results[1].status === 'fulfilled' ? results[1].value : null;

    if (results[0].status === 'rejected') {
      console.error('calendar refresh failed:', results[0].reason && results[0].reason.message);
    }
    if (!calendar) return null;

    calendar.weather = weather;
    calendar.location = location;
    return calendar;
  }

  global.KitchenData = {
    fetchState: fetchState,
    reauthenticate: reauthenticate,
    STATE_POLL_MS: STATE_POLL_MS,
    TICK_MS: TICK_MS,
  };
})(window);
