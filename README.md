# kitchen-dash (template)

A wall-mounted **kitchen dashboard**: today / tomorrow / the next five days from one
Microsoft 365 calendar, countdowns to flagged events, a daily chore checklist, the
weather forecast, and a real ground-station air-quality reading.

It is one small Node process with **zero npm dependencies**, reading a single mailbox
calendar through a **least-privilege, read-only, app-only Microsoft Graph credential**,
bound to loopback and (optionally) published to your devices with Tailscale Serve.

This repository is a sanitized template. Every identifier in it — tenant and app IDs,
mailboxes, hostnames, paths, coordinates — is a placeholder. Fill in your own.

## Architecture

```
 wall tablet / browser
        │  HTTPS (e.g. Tailscale Serve, or any reverse proxy)
        ▼
 server.js  ── 127.0.0.1:8788, loopback only
   ├─ static UI (index.html, app.js, …)
   ├─ GET /api/state?tz=<IANA zone>  ── Microsoft Graph calendarView (app-only, Calendars.Read)
   ├─ GET /api/air?lat=&lon=         ── WAQI ground-station feed (holds WAQI_TOKEN)
   └─ GET /healthz

 browser ── Open-Meteo forecast + geocoding (no key, client-side)
```

### Layout

```
/                       static assets (served at the mount root)
  index.html              markup, including the daily checklist
  app.js                  rendering
  data.js                 refresh loop: /api/state + weather, merged
  location.js             per-device location preference (default location lives here)
  location-ui.js          the city picker
  weather.js              Open-Meteo, client-side
  diag.html               render diagnostic for older kiosk WebViews
server.js               the whole backend: static files + /api/state + /api/air
api/
  src/lib/graph.js        token + calendarView, the only code holding the Graph secret
  src/lib/calendar.js     shaping: day buckets, countdowns
  src/lib/air.js          WAQI station lookup, holds WAQI_TOKEN
  test/                   unit tests, no credentials or network needed
deploy/kitchen-dash.service   systemd user unit (placeholder paths)
bootstrap.sh            one-shot host setup
.env.example            the configuration template
```

## Setup

### 1. Microsoft Graph: app-only, least privilege

The dashboard reads **one mailbox's calendar** with an app-only (client credentials)
registration. Application permissions are tenant-wide by default, so the scoping is done
in Exchange Online.

1. **Create a mailbox for the calendar.** A *shared mailbox* (e.g. `calendar@example.com`)
   works best — see [Why a mailbox calendar, not a group calendar](#why-a-mailbox-calendar-not-a-group-calendar).
   Share it with the people who should edit events.
2. **Register an app** in Entra ID (single tenant). Add the Microsoft Graph
   **Application** permission `Calendars.Read` — nothing else — and grant admin consent.
   Create a client secret and note the expiry.
3. **Confine it to that one mailbox** with an Exchange `ApplicationAccessPolicy`
   (or the newer RBAC for Applications) in Exchange Online PowerShell:

   ```powershell
   $APP_ID = "00000000-0000-0000-0000-000000000000"   # Application (client) ID
   $CAL    = "calendar@example.com"                   # the calendar mailbox

   Connect-ExchangeOnline
   # A mail-enabled security group containing only the calendar mailbox:
   New-DistributionGroup -Name "Kitchen Dashboard Scope" -Type Security -Members $CAL
   New-ApplicationAccessPolicy -AppId $APP_ID -PolicyScopeGroupId "Kitchen Dashboard Scope" `
     -AccessRight RestrictAccess -Description "Kitchen dashboard: one calendar only"
   ```

4. **Verify the scope — both directions.** Never check only the mailbox that should work;
   a broken intermediate state can pass a positive-only test while the credential can
   still read the whole tenant:

   ```powershell
   Test-ApplicationAccessPolicy -Identity calendar@example.com -AppId $APP_ID   # Granted
   Test-ApplicationAccessPolicy -Identity someone@example.com  -AppId $APP_ID   # Denied
   ```

   *Alternative:* Exchange **RBAC for Applications** (a management scope over the
   mailbox plus a `New-ManagementRoleAssignment` of `Application Calendars.Read` to the
   service principal) does the same job; verify it with
   `Test-ServicePrincipalAuthorization -Identity $APP_ID -Resource calendar@example.com`
   (expect `InScope: True`) and again against a mailbox that must be denied.
   `Test-ServicePrincipalAuthorization` bypasses the permission cache, so it reflects
   configuration immediately.

   Policy changes can take **30 minutes to 2 hours** to reach actual Graph enforcement
   for an active app — during that window a stale result proves nothing either way.

Placeholder reference — replace with your own values and keep them out of commits if you
prefer (none of these are secrets, but they identify your tenant):

| Thing | Example value |
|---|---|
| Tenant ID | `00000000-0000-0000-0000-000000000000` |
| App (client) ID — read-only registration | `11111111-1111-1111-1111-111111111111` |
| Calendar mailbox | `calendar@example.com` |
| Exchange scope group | `Kitchen Dashboard Scope` |
| Microsoft Graph resource (well-known) | `00000003-0000-0000-c000-000000000000` |

### 2. Air quality token (optional)

Get a free token at <https://aqicn.org/data-platform/register>. Without it the server
logs that AQI is disabled, `/api/air` returns `air_unavailable`, and the tile falls back
to a modelled estimate. Everything else still renders.

### 3. Environment variables

Copy `.env.example` to `~/.config/kitchen-dash/env` with mode `600` and fill it in.
**Never commit real values.**

| Variable | Required | Purpose |
|---|---|---|
| `TENANT_ID` | yes | Entra tenant ID |
| `CLIENT_ID` | yes | the read-only app registration |
| `CLIENT_SECRET` | yes | its client secret |
| `CALENDAR_MAILBOX` | yes | UPN of the mailbox whose calendar is shown, e.g. `calendar@example.com` |
| `WAQI_TOKEN` | no | air-quality token (see above) |
| `PORT` | no | listen port, default `8788` |
| `DEFAULT_TZ` | no | IANA zone used when a request has no valid `tz`, default `America/New_York` |
| `COUNTDOWN_MARKERS` | no | comma-separated countdown markers, default `⏳,⌛,[countdown]` |

Keep this file **dedicated to the dashboard**. Don't put the Graph secret in a shared
shell profile or an env file sourced by other services — anything there is inherited by
every process that loads it.

### 4. Run locally

```bash
cd api && npm test            # no credentials or network needed
cd ..
set -a; . ~/.config/kitchen-dash/env; set +a
node server.js                # http://127.0.0.1:8788/
```

Node 20+ is required. There is nothing to install: `server.js` uses only the standard
library.

### 5. Deploy as a systemd service

```bash
git clone https://github.com/YOUR-USER/kitchen-dash.git ~/apps/kitchen-dash
cd ~/apps/kitchen-dash && ./bootstrap.sh
```

`bootstrap.sh` is idempotent and prints no secret values. It checks Node, runs the tests,
creates `~/.config/kitchen-dash/env` from `.env.example` on first run (and stops so you can
fill it in), installs `deploy/kitchen-dash.service` as a **user** unit with its
placeholder paths (`/home/USER/...`) rewritten to wherever your clone lives, starts it,
and checks `/healthz` and `/api/state`.

To keep it running when you log out: `sudo loginctl enable-linger $USER`.
After editing the env file: `systemctl --user restart kitchen-dash`.
Logs: `journalctl --user -u kitchen-dash -f`.

### 6. Publish it (optional: Tailscale Serve)

The server binds **loopback only** and has no sign-in flow — access control is whatever
fronts it. With Tailscale, access is tailnet membership:

```bash
tailscale serve --bg --https 8443 --set-path /kitchen http://127.0.0.1:8788
```

Then point the wall tablet at `https://<host>.<tailnet>.ts.net:8443/kitchen`.
The app resolves its API calls relative to the page, so it works under any mount path.
Any other reverse proxy works too; just don't expose port 8788 directly to the internet.

## Customize

- **Default location** — `DEFAULT_LOCATION` in `location.js` (name, coordinates, IANA
  timezone). Each device can also pick its own city from the weather header; that choice
  is stored per-device in `localStorage`. Also consider `DEFAULT_TZ`.
- **Countdowns** — put a marker in an event's title (see below). Change the markers with
  `COUNTDOWN_MARKERS`.
- **Calendar** — `CALENDAR_MAILBOX` selects the mailbox; the Graph read lives in
  `api/src/lib/graph.js` and the day/countdown shaping in `api/src/lib/calendar.js`.
- **Daily checklist** — edit the `<li>` items in `index.html` (`data-dow` limits an item
  to one weekday; ticks reset daily at ~2am).
- **Event emoji** — keyword → emoji table at the top of `app.js`.

Migrating events from an existing calendar into the new mailbox is out of scope for this
template.

## Timezone

`/api/state` takes `?tz=<IANA zone>` and buckets days in that zone (the browser sends the
selected location's zone). This is not cosmetic: a server running in UTC that used host
local time for day boundaries would silently push late-evening events onto the next day.
`api/test/calendar.test.js` covers that case explicitly, along with DST and all-day
boundaries.

### Known limitation: event times render in the device's timezone

Day bucketing follows the **selected location**, but the clock times printed on each
event are rendered in the **browser's** timezone. These agree in the normal cases — the
kitchen screen at home, and a travelling copy set to where you actually are. They diverge
only if you select a location you are not in. Fixing it means routing every render site
through `Intl.DateTimeFormat` with an explicit `timeZone`.

## Why a mailbox calendar, not a group calendar

Reading `/groups/{id}/calendarView` on a Microsoft 365 Group cannot be made
least-privilege in practice. In testing, with the app holding exactly one permission
(`Calendars.Read`) and correctly denied the directory:

- an Exchange RBAC `CustomRecipientScope` over the group was well-formed, and
  `Get-Recipient -RecipientPreviewFilter` matched exactly the group mailbox;
- yet enforcement returned `ErrorAccessDenied` for **that group** while returning `200`
  for an **unrelated user mailbox** — the scope inverted.

A `GroupMailbox` does not resolve into an RBAC custom resource scope at access time, even
though the filter matches in preview. A shared mailbox is a first-class user-type
recipient and scopes correctly.

## Flagging an event for a countdown

Put an hourglass in the event title:

```
⏳ Alex's birthday
```

It appears in the countdown strip with a day count and drops off once the date passes.
The marker is stripped from what the screen renders — the title shows as
"Alex's birthday".

### Why a title marker

It is the only flag with no setup and no per-client machinery behind it.

| Mechanism | New Outlook | Mobile | Graph | Why not |
|---|---|---|---|---|
| **Title marker** | ✅ | ✅ | ✅ | — chosen |
| Category | ✅ | ✅ | ✅ | Outlook's master category list is per-mailbox and clients resolve it inconsistently for shared mailboxes; the label drifts as people hand-type it |
| `importance=high` | ❌ | ❌ | ✅ | Cannot be set in New Outlook or either mobile app |
| Separate calendar | ✅ | ✅ | ✅ | Workable, but an event lives on one calendar, and moving events is fiddly on mobile |
| Extended properties | ❌ | ❌ | ✅ | Technically ideal, but no Outlook client can set them |
| `showAs` / `sensitivity` | ✅ | ✅ | ✅ | Carry real meaning — hijacking them corrupts free/busy or hides event detail |

Accepted by default: `⏳`, `⌛` (a plausible autocorrect of the first), and `[countdown]`
for anyone without a convenient emoji picker. Matched **anywhere** in the title, not just
as a prefix — a flag that depends on position is a flag that silently fails.
`importance=high` is still honoured for older events.

Automations flag events the same way people do — a `PATCH` of `subject` with the marker
included. One mechanism, one thing to document, one thing that can break.

## Refresh cadence

| Loop | Interval | What it does |
|---|---|---|
| Network | 30 min | `GET /api/state?tz=…` plus the weather call |
| Reminder tick | 60 s | Re-checks cached events for the 15-minute chime |

These are deliberately separate. A single 60-second loop that both re-fetches and checks
reminders can't simply be lengthened to 30 minutes without breaking the chime: an event
can enter and leave its 15-minute window between two polls. The tick costs nothing — no
network — and reads events already in memory.

The server caches the shaped calendar payload for 5 minutes and air-quality readings for
15 minutes per location, so reloads and extra devices don't each hit Graph or WAQI.

A failed calendar fetch leaves the last good screen up rather than blanking a wall
display, and a failed weather fetch doesn't take the calendar with it.

## Weather

Fetched **client-side** from Open-Meteo, which needs no credential, using the coordinates
of the selected location and `timezone=auto`. It never passes through the server.
Air quality is the exception, and for exactly that reason: it needs a credential.

### Weather sub-tiles

Each weather icon sits on a **saturated backdrop** matching its conditions — eight
buckets (clear, partly, cloud, rain, snow, fog, storm, night) rather than one per WMO
code, because finer distinctions do not survive being read from across a kitchen. The
colour is behind the **icon**, not the tile, so temperature and description keep full
contrast on the flat panel. Icons carry a drop-shadow so white clouds and yellow suns keep
an edge against paler backdrops.

Animated weather icons by Bas Milius (MIT) — <https://github.com/basmilius/weather-icons>.

## Air quality

The current reading is **always** on the Now tile, as `<conditions> · AQI <n>` on the
description line. The UV index is encoded in the weather icon itself (`uv-index-<n>`), so
it doesn't repeat the number.

At **AQI 50 or above**, the tile additionally gets the EPA band colour as a **slowly
pulsing** ring plus a badge with the value and band name. The pulse is a ~2.8s breath
rather than a blink — this runs day and night, and a fast flash is both irritating and
quickly tuned out. `prefers-reduced-motion` drops it to a static ring.

Only the Now tile shows it. The forecast tiles answer *what should I expect*; AQI answers
*should I open a window right now*.

### Where the number comes from

The AQI is a **real reporting ground station** from the World Air Quality Index project
(WAQI), served through `/api/air`. Open-Meteo's air-quality feed covers North America
with a coarse (~45km) CAMS global model with no ground stations blended in; in testing it
disagreed with every nearby real monitor and crossed an AQI band boundary (reporting
"Moderate" on a "Good" day). Wildfire smoke — a plume a coarse model smooths away and a
nearby monitor sees — is exactly the case this tile exists for.

**PM2.5 / PM10 in the popup stay on Open-Meteo**, because they are *concentrations* in
µg/m³; WAQI reports per-pollutant figures as AQI sub-indices (same field names, different
units). If the station call fails, the tile falls back to Open-Meteo's modelled value and
the popup labels it `modelled estimate — no station`, so a fallback is never passed off as
measured. Station name, distance, and source attribution appear in the popup — the
attribution is a condition of WAQI's terms of use.

## Day coverage

`Today` and `Tomorrow` in the left block, then five days in `Upcoming` starting the day
**after** tomorrow — seven consecutive days with no repeat. Date-only strings are parsed
at local midday, because `new Date("2026-09-02")` parses as **UTC midnight**, which west
of Greenwich renders as the previous day.

## Tests

```
cd api && npm test
```

Runs without credentials or network — the shaping layer is pure.

## Security notes

- The Graph credential can read exactly one mailbox's calendar and nothing else; verify
  both the allowed and a denied mailbox after any permission change.
- Secrets live only in the mode-`600` env file; the server never logs or returns them
  (it logs only whether `WAQI_TOKEN` is set).
- The server listens on `127.0.0.1` only; put an authenticating proxy or a private
  network (e.g. a tailnet) in front of it.
