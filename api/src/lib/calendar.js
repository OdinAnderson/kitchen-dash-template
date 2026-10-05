'use strict';

// Calendar shaping for the kitchen dashboard.
//
// Ported from an earlier cron-based dashboard script, with one deliberate change: the
// original ran on a host pinned to one local timezone and used the *host's* local
// timezone for every day boundary (`new Date(y, m, d)`). Servers and serverless
// runtimes commonly run in UTC, so that logic would silently bucket events against UTC
// midnight — late-evening events west of Greenwich would land on the wrong day.
//
// Every day boundary here is therefore computed in an EXPLICIT IANA timezone supplied
// by the caller. Day arithmetic is done on civil dates (year/month/day) converted to
// day numbers, never on wall-clock Date math, so DST transitions cannot shift a bucket.

/** Civil {y,m,d} for an instant, as observed in `tz`. */
function civilInTz(date, tz) {
  // en-CA formats as YYYY-MM-DD, which parses cleanly.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const [y, m, d] = parts.split('-').map(Number);
  return { y, m, d };
}

/** Days since the epoch for a civil date. Comparison and offset unit. */
function dayNum({ y, m, d }) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function civilFromDayNum(n) {
  const dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** ISO date string (no time) for a civil date — what the client renders from. */
function civilToISODate({ y, m, d }) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Civil date on which an event's start falls.
 * All-day events carry a floating calendar date and must NOT be shifted by timezone.
 * Timed events are real instants; we ask Graph for UTC (see graph.js) so they are
 * unambiguous, then observe them in `tz`.
 */
function startCivil(e, tz) {
  if (e.isAllDay) {
    const [y, m, d] = e.start.dateTime.split('T')[0].split('-').map(Number);
    return { y, m, d };
  }
  return civilInTz(new Date(e.start.dateTime + 'Z'), tz);
}

function endCivilExclusive(e) {
  const [y, m, d] = e.end.dateTime.split('T')[0].split('-').map(Number);
  return { y, m, d };
}

/**
 * Does this event occupy `dayN`?
 * All-day: any day in [start, end) — Graph's all-day end date is exclusive.
 * Timed: only its start day.
 */
function eventCoversDay(e, dayN, tz) {
  if (!e.start || !e.subject) return false;
  const startN = dayNum(startCivil(e, tz));
  if (e.isAllDay && e.end) {
    return dayN >= startN && dayN < dayNum(endCivilExclusive(e));
  }
  return startN === dayN;
}

/**
 * Graph's all-day end is exclusive (a one-day event ends the next morning).
 * Convert to inclusive so a single-day event shows the same start and end date.
 */
function inclusiveEnd(endObj, isAllDay) {
  if (!isAllDay || !endObj || !endObj.dateTime) return endObj;
  const [y, m, d] = endObj.dateTime.split('T')[0].split('-').map(Number);
  const prev = civilFromDayNum(dayNum({ y, m, d }) - 1);
  return {
    dateTime: `${civilToISODate(prev)}T00:00:00.0000000`,
    timeZone: endObj.timeZone,
  };
}

function formatEvent(e, markers) {
  const ev = {
    subject: stripCountdownMarker(e.subject, markers),
    start: e.start,
    end: inclusiveEnd(e.end, e.isAllDay),
    isAllDay: !!e.isAllDay,
  };
  if (e.id) ev.eventId = e.id;
  if (e.importance) ev.importance = e.importance;
  if (e.categories && e.categories.length) ev.categories = e.categories;
  if (e.location && e.location.displayName) ev.location = e.location.displayName;
  if (e.bodyPreview) ev.bodyPreview = e.bodyPreview;
  if (e.attendees && e.attendees.length) {
    ev.attendees = e.attendees.map((a) => ({
      name: a.emailAddress && a.emailAddress.name,
      email: a.emailAddress && a.emailAddress.address,
    }));
  }
  if (e.organizer && e.organizer.emailAddress) ev.organizer = e.organizer.emailAddress.name;
  return ev;
}

// How an event asks to be counted down to: a marker in its title.
//
// Chosen over the alternatives because it is the only flag with no setup and no
// per-client machinery behind it. Categories depend on Outlook's master category
// list, which is PER MAILBOX and which clients resolve inconsistently for shared
// mailboxes — that is what made the previous attempt unreliable. `importance` cannot
// be set at all in New Outlook or either mobile app. A title is editable everywhere,
// by everyone, including agents via a plain PATCH of `subject`.
//
// The marker is metadata rather than part of the name, so it is stripped from the
// title the dashboard renders — you type "⏳ Alex's birthday", the screen shows
// "Alex's birthday".
const COUNTDOWN_MARKERS = ['⏳', '⌛', '[countdown]'];

/** Accepted markers, from an array or comma-separated string. */
function markerList(markers) {
  if (markers == null || markers === '') return COUNTDOWN_MARKERS;
  const list = Array.isArray(markers) ? markers : String(markers).split(',');
  const cleaned = list.map((m) => String(m).trim()).filter(Boolean);
  return cleaned.length ? cleaned : COUNTDOWN_MARKERS;
}

/**
 * Does the title carry a marker?
 * Matched anywhere in the string, not just as a prefix — people put it at the end
 * about as often, and a flag that depends on position is a flag that silently fails.
 * Text markers are matched case-insensitively; emoji have no case.
 */
function hasCountdownMarker(subject, markers) {
  const s = String(subject == null ? '' : subject).toLowerCase();
  return markerList(markers).some((m) => s.includes(m.toLowerCase()));
}

/**
 * The title with the marker removed and whitespace tidied.
 * Falls back to the original if stripping would leave nothing — a title of just a
 * marker is odd, but showing an empty row is worse.
 */
function stripCountdownMarker(subject, markers) {
  const original = String(subject == null ? '' : subject);
  let out = original;
  for (const m of markerList(markers)) {
    out = out.split(new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')).join(' ');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out || original;
}

function isCountdown(e, markers) {
  if (hasCountdownMarker(e.subject, markers)) return true;
  return (e.importance || '').toLowerCase() === 'high'; // legacy, pre-dates this scheme
}

/**
 * Countdowns: flagged events only, future-dated, nearest first.
 * `categoryName` is injectable so the deployment can rename the category without a
 * code change.
 */
function buildCountdowns(events, todayN, tz, markers) {
  const out = [];
  for (const e of events) {
    if (!e.start || !e.subject) continue;
    if (!isCountdown(e, markers)) continue;

    const days = dayNum(startCivil(e, tz)) - todayN;
    if (days < 0) continue;

    const cd = { ...formatEvent(e, markers), label: stripCountdownMarker(e.subject, markers), days };
    delete cd.subject;
    out.push(cd);
  }
  out.sort((a, b) => a.days - b.days);
  return out;
}

/**
 * Shape the raw Graph event list into the payload the dashboard renders.
 * `now` is injectable so tests are deterministic.
 */
function buildState(events, tz, now = new Date(), markers) {
  const todayN = dayNum(civilInTz(now, tz));

  const onDay = (n) =>
    events.filter((e) => eventCoversDay(e, n, tz)).map((e) => formatEvent(e, markers));

  // Five days beginning the day after tomorrow, matching the legacy layout.
  const upcomingDays = [];
  for (let i = 0; i < 5; i++) {
    const n = todayN + 2 + i;
    upcomingDays.push({
      date: civilToISODate(civilFromDayNum(n)),
      events: onDay(n),
    });
  }

  return {
    timeZone: tz,
    updatedAt: now.toISOString(),
    todayEvents: onDay(todayN),
    tomorrowEvents: onDay(todayN + 1),
    upcomingDays,
    countdowns: buildCountdowns(events, todayN, tz, markers),
  };
}

module.exports = {
  buildState,
  COUNTDOWN_MARKERS,
  isCountdown,
  hasCountdownMarker,
  stripCountdownMarker,
  // exported for tests
  civilInTz,
  dayNum,
  eventCoversDay,
  inclusiveEnd,
  formatEvent,
  buildCountdowns,
};
