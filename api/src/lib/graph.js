'use strict';

// Microsoft Graph access for the kitchen dashboard.
//
// One credential, one call, read-only. The app registration behind CLIENT_ID holds a
// single application permission (Calendars.Read), confined to a single mailbox by an
// Exchange ApplicationAccessPolicy. Nothing here writes, and no other resource is read.
//
// The secret arrives from the service's environment file at runtime. It is never
// logged, never returned in a response, and never written to disk.

const TOKEN_SKEW_MS = 60_000;

let cachedToken = null; // { value, expiresAt }

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required application setting: ${name}`);
  return v;
}

/**
 * App-only token via client credentials. Cached in module scope for the life of the
 * worker so a burst of requests does not re-mint one per call.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_SKEW_MS) {
    return cachedToken.value;
  }

  const tenantId = requireEnv('TENANT_ID');
  const body = new URLSearchParams({
    client_id: requireEnv('CLIENT_ID'),
    client_secret: requireEnv('CLIENT_SECRET'),
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    // Deliberately does not echo the response body — it can contain request detail
    // we do not want in logs. The status is enough to tell misconfiguration from outage.
    throw new Error(`Token request failed: ${res.status}`);
  }

  const data = await res.json();
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
  };
  return cachedToken.value;
}

/**
 * Read the configured mailbox's calendar over a window, following pagination.
 *
 * Reads a MAILBOX calendar (`/users/{upn}`), not a group calendar (`/groups/{id}`).
 * That is a deliberate correction, not a preference: an M365 Group mailbox does not
 * resolve into an Exchange RBAC custom resource scope at access time, so a group
 * calendar cannot be confined to least privilege. Verified live 2026-08-29 — a
 * correctly-formed scope over the group returned ErrorAccessDenied for the group
 * while still permitting other mailboxes, i.e. the worst of both. A shared mailbox
 * is a first-class user-type recipient and scopes properly.
 *
 * `Prefer: outlook.timezone="UTC"` matters: without it Graph returns wall-clock times
 * in the mailbox's own zone with a separate timeZone field, which the caller then has
 * to disambiguate. Pinning UTC makes every timed event an unambiguous instant, which
 * is what lets the shaping layer bucket days in whatever zone the client asked for.
 */
async function fetchCalendarView(startISO, endISO) {
  const mailbox = requireEnv('CALENDAR_MAILBOX');
  const token = await getAccessToken();

  const url = new URL(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/calendarView`
  );
  url.searchParams.set('startDateTime', startISO);
  url.searchParams.set('endDateTime', endISO);
  url.searchParams.set('$top', '200');
  url.searchParams.set('$orderby', 'start/dateTime');

  const all = [];
  let next = url.toString();
  let pages = 0;

  while (next) {
    if (++pages > 20) throw new Error('calendarView pagination exceeded 20 pages');

    const res = await fetch(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC"',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`calendarView failed: ${res.status}`);
    }

    const data = await res.json();
    all.push(...(data.value || []));
    next = data['@odata.nextLink'] || null;
  }

  return all;
}

module.exports = { fetchCalendarView, getAccessToken };
