'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildState, eventCoversDay, dayNum, civilInTz, inclusiveEnd } = require('../src/lib/calendar');

const TZ = 'America/Los_Angeles';

// Graph returns timed events as UTC wall-clock (we send Prefer: outlook.timezone="UTC"),
// and all-day events as floating calendar dates.
const timed = (subject, utcISO, opts = {}) => ({
  id: subject,
  subject,
  isAllDay: false,
  start: { dateTime: utcISO, timeZone: 'UTC' },
  end: { dateTime: utcISO, timeZone: 'UTC' },
  ...opts,
});

const allDay = (subject, startDate, endDateExclusive) => ({
  id: subject,
  subject,
  isAllDay: true,
  start: { dateTime: `${startDate}T00:00:00.0000000`, timeZone: 'UTC' },
  end: { dateTime: `${endDateExclusive}T00:00:00.0000000`, timeZone: 'UTC' },
});

test('the bug this port exists to prevent: late-evening Pacific events stay on today', () => {
  // 2026-08-29 21:30 Pacific is 2026-08-30 04:30 UTC.
  // Bucketing in UTC — which is what an unmodified port would do on Azure — puts this
  // on tomorrow. In America/Los_Angeles it is still today.
  const now = new Date('2026-08-29T23:00:00Z'); // 16:00 Pacific, same civil day
  const e = timed('Dinner', '2026-08-30T04:30:00');

  const state = buildState([e], TZ, now);

  assert.equal(state.todayEvents.length, 1, 'should be today in Pacific');
  assert.equal(state.tomorrowEvents.length, 0);

  const utcState = buildState([e], 'UTC', now);
  assert.equal(utcState.todayEvents.length, 0, 'and demonstrably tomorrow in UTC');
});

test('timezone drives bucketing, so changing location re-buckets', () => {
  const now = new Date('2026-08-29T23:00:00Z');
  const e = timed('Late call', '2026-08-30T04:30:00');

  // Same instant, different chosen locations.
  assert.equal(buildState([e], 'America/Los_Angeles', now).todayEvents.length, 1);
  assert.equal(buildState([e], 'America/New_York', now).todayEvents.length, 0);
});

test('all-day events are floating dates and never shift by timezone', () => {
  const e = allDay('Holiday', '2026-08-29', '2026-08-30'); // single day
  const itsOwnDay = dayNum({ y: 2026, m: 8, d: 29 });

  // The invariant is about the EVENT, not about what "today" is: an all-day event
  // sits on its own civil date in every zone. (Which day is "today" legitimately
  // differs by zone — see the next test.)
  for (const tz of ['America/Los_Angeles', 'UTC', 'Pacific/Kiritimati', 'Asia/Kolkata']) {
    assert.ok(eventCoversDay(e, itsOwnDay, tz), `all-day should hold its date in ${tz}`);
    assert.ok(!eventCoversDay(e, itsOwnDay + 1, tz), `and not bleed into the next day in ${tz}`);
  }
});

test('which day is "today" correctly follows the chosen zone', () => {
  // 2026-08-29T23:00Z is still Aug 29 in Los Angeles and UTC, but already Aug 30
  // in UTC+14 — so an Aug 29 all-day event is today in the first two, not the third.
  const now = new Date('2026-08-29T23:00:00Z');
  const e = allDay('Holiday', '2026-08-29', '2026-08-30');

  assert.equal(buildState([e], 'America/Los_Angeles', now).todayEvents.length, 1);
  assert.equal(buildState([e], 'UTC', now).todayEvents.length, 1);
  assert.equal(buildState([e], 'Pacific/Kiritimati', now).todayEvents.length, 0);
});

test('multi-day all-day events span the whole range, end-exclusive', () => {
  const now = new Date('2026-08-29T18:00:00Z');
  const e = allDay('Trip', '2026-08-29', '2026-09-01'); // 29, 30, 31

  const todayN = dayNum(civilInTz(now, TZ));
  assert.ok(eventCoversDay(e, todayN, TZ), 'day 1');
  assert.ok(eventCoversDay(e, todayN + 1, TZ), 'day 2');
  assert.ok(eventCoversDay(e, todayN + 2, TZ), 'day 3');
  assert.ok(!eventCoversDay(e, todayN + 3, TZ), 'end is exclusive');
});

test('single-day all-day events display an inclusive end date', () => {
  const end = inclusiveEnd({ dateTime: '2026-08-30T00:00:00.0000000', timeZone: 'UTC' }, true);
  assert.match(end.dateTime, /^2026-08-29T/, 'end should read as the same day, not the next');
});

test('DST boundary does not shift a day bucket', () => {
  // US DST ends 2026-11-01. A civil-date approach must not drift across it.
  const now = new Date('2026-10-31T19:00:00Z'); // 12:00 Pacific, Oct 31
  const e = allDay('After DST', '2026-11-02', '2026-11-03');
  const state = buildState([e], TZ, now);

  const hit = state.upcomingDays.find((d) => d.events.length > 0);
  assert.ok(hit, 'event should appear in upcoming');
  assert.equal(hit.date, '2026-11-02', 'and on its true civil date');
});

test('countdowns: flagged only, future only, nearest first', () => {
  const now = new Date('2026-08-29T18:00:00Z');
  const events = [
    allDay('Past big thing', '2026-08-01', '2026-08-02'),
    allDay('Soon', '2026-09-05', '2026-09-06'),
    allDay('Later', '2026-10-05', '2026-10-06'),
    allDay('Not important', '2026-09-02', '2026-09-03'),
  ];
  events[0].importance = 'high';
  events[1].importance = 'high';
  events[2].importance = 'high';
  events[3].importance = 'normal';

  const { countdowns } = buildState(events, TZ, now);

  assert.deepEqual(countdowns.map((c) => c.label), ['Soon', 'Later'], 'past and normal excluded, sorted');
  assert.ok(countdowns[0].days > 0 && countdowns[0].days < countdowns[1].days);
  assert.equal(countdowns[0].subject, undefined, 'countdowns use label, not subject');
});

test('upcoming window is five days starting the day after tomorrow', () => {
  const now = new Date('2026-08-29T18:00:00Z');
  const { upcomingDays } = buildState([], TZ, now);

  assert.equal(upcomingDays.length, 5);
  assert.equal(upcomingDays[0].date, '2026-08-31', 'starts day after tomorrow');
  assert.equal(upcomingDays[4].date, '2026-09-04');
});

test('payload carries no weather and no location', () => {
  const state = buildState([], TZ, new Date('2026-08-29T18:00:00Z'));
  assert.equal(state.weather, undefined, 'weather is fetched browser-side');
  assert.equal(state.location, undefined, 'the family-location field is retired');
  assert.equal(state.timeZone, TZ);
  assert.ok(state.updatedAt);
});


// --- countdown flagging: a marker in the title ---

const { isCountdown, hasCountdownMarker, stripCountdownMarker, COUNTDOWN_MARKERS } =
  require('../src/lib/calendar');

test('a marker anywhere in the title flags the event', () => {
  assert.ok(hasCountdownMarker('⏳ Alex birthday'), 'prefix');
  assert.ok(hasCountdownMarker('Alex birthday ⏳'), 'suffix — people put it either end');
  assert.ok(hasCountdownMarker('Alex ⏳ birthday'), 'middle');
  assert.ok(!hasCountdownMarker('Alex birthday'), 'unmarked');
  assert.ok(!hasCountdownMarker(''), 'empty');
  assert.ok(!hasCountdownMarker(undefined), 'missing subject must not throw');
});

test('both hourglass glyphs and the text form are accepted', () => {
  // ⌛ is a plausible mistype/autocorrect of ⏳; [countdown] is for anyone without
  // a convenient emoji picker.
  assert.ok(hasCountdownMarker('⌛ Trip'));
  assert.ok(hasCountdownMarker('[countdown] Trip'));
  assert.ok(hasCountdownMarker('[COUNTDOWN] Trip'), 'text form is case-insensitive');
});

test('the marker is stripped from the displayed title', () => {
  assert.equal(stripCountdownMarker('⏳ Alex birthday'), 'Alex birthday');
  assert.equal(stripCountdownMarker('Alex birthday ⏳'), 'Alex birthday');
  assert.equal(stripCountdownMarker('⏳  Alex   birthday'), 'Alex birthday', 'whitespace tidied');
  assert.equal(stripCountdownMarker('[countdown] Trip'), 'Trip');
  assert.equal(stripCountdownMarker('Alex birthday'), 'Alex birthday', 'unmarked unchanged');
});

test('a title that is only a marker keeps something to show', () => {
  assert.equal(stripCountdownMarker('⏳'), '⏳', 'better than rendering an empty row');
});

test('markers are configurable', () => {
  assert.ok(hasCountdownMarker('🎯 Launch', '🎯'));
  assert.ok(!hasCountdownMarker('⏳ Launch', '🎯'), 'default no longer applies');
  assert.ok(hasCountdownMarker('!! Launch', '🎯,!!'), 'comma-separated list');
  assert.equal(stripCountdownMarker('🎯 Launch', '🎯'), 'Launch');
});

test('importance=high still works, so events predating this scheme survive', () => {
  assert.ok(isCountdown({ subject: 'Old thing', importance: 'high' }));
  assert.ok(!isCountdown({ subject: 'Old thing', importance: 'normal' }));
});

test('marked events show the clean title in day views too, not just countdowns', () => {
  const now = new Date('2026-08-29T18:00:00Z');
  const e = allDay('⏳ Alex birthday', '2026-08-29', '2026-08-30');
  const state = buildState([e], TZ, now);

  assert.equal(state.todayEvents[0].subject, 'Alex birthday', 'marker is metadata, not the name');
  assert.equal(state.countdowns[0].label, 'Alex birthday');
});

test('end to end: marked and legacy events counted down, unmarked ignored', () => {
  const now = new Date('2026-08-29T18:00:00Z');
  const mk = (subject, date, extra = {}) =>
    Object.assign(allDay(subject, date, date.slice(0, 8) + String(+date.slice(8) + 1).padStart(2, '0')), extra);

  const events = [
    mk('⏳ Trip', '2026-09-05'),
    mk('Legacy', '2026-09-20', { importance: 'high' }),
    mk('Dentist', '2026-09-02'),
  ];
  const { countdowns } = buildState(events, TZ, now);
  assert.deepEqual(countdowns.map((c) => c.label), ['Trip', 'Legacy']);
});

test('COUNTDOWN_MARKERS is exported so docs and UI name it once', () => {
  assert.ok(COUNTDOWN_MARKERS.includes('⏳'));
});
