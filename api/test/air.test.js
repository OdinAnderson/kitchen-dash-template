'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { shapeAir, distanceKm, isValidCoords } = require('../src/lib/air');

// New York, the coordinates the dashboard defaults to (see location.js).
const LAT = 40.7128;
const LON = -74.0060;

/** A WAQI feed response, trimmed to the fields shapeAir() reads. */
const feed = (overrides = {}) => ({
  status: 'ok',
  data: {
    aqi: 20,
    city: { name: 'Example City Station', geo: [40.7033, -73.9560] },
    time: { iso: '2026-09-06T15:00:00-04:00' },
    dominentpol: 'pm25',
    attributions: [
      { name: 'Example State Environmental Agency' },
      { name: 'World Air Quality Index Project' },
    ],
    ...overrides,
  },
});

test('shapes a normal station reading', () => {
  const air = shapeAir(feed(), LAT, LON);

  assert.strictEqual(air.aqi, 20);
  assert.strictEqual(air.station, 'Example City Station');
  assert.strictEqual(air.observedAt, '2026-09-06T15:00:00-04:00');
  assert.strictEqual(air.dominant, 'pm25');
  assert.deepStrictEqual(air.attributions, [
    'Example State Environmental Agency',
    'World Air Quality Index Project',
  ]);
});

test('reports how far the reporting station actually is', () => {
  const air = shapeAir(feed(), LAT, LON);
  // The sample station sits ~4km east of the default coordinates.
  assert.ok(air.distanceKm > 3 && air.distanceKm < 5,
    `expected ~4km, got ${air.distanceKm}`);
});

// The case that matters most: WAQI sends the STRING "-" for a station that is online
// but has no current reading. Treating that as a number would render "AQI NaN" on a
// wall display, or worse, colour the ring from it.
test('a station with no current reading is null, not NaN', () => {
  assert.strictEqual(shapeAir(feed({ aqi: '-' }), LAT, LON), null);
});

test('rejects error payloads and junk', () => {
  assert.strictEqual(shapeAir({ status: 'error', data: 'Invalid key' }, LAT, LON), null);
  assert.strictEqual(shapeAir(null, LAT, LON), null);
  assert.strictEqual(shapeAir({}, LAT, LON), null);
  assert.strictEqual(shapeAir({ status: 'ok' }, LAT, LON), null);
});

test('survives a station with no geo, name, or attributions', () => {
  const air = shapeAir(feed({ city: { name: null }, attributions: undefined }), LAT, LON);
  assert.strictEqual(air.aqi, 20);
  assert.strictEqual(air.station, null);
  assert.strictEqual(air.distanceKm, null);
  assert.deepStrictEqual(air.attributions, []);
});

test('rounds a fractional AQI to a whole number', () => {
  assert.strictEqual(shapeAir(feed({ aqi: 57.6 }), LAT, LON).aqi, 58);
});

test('isValidCoords rejects what must never reach an outbound URL', () => {
  assert.ok(isValidCoords(LAT, LON));
  assert.ok(isValidCoords(0, 0));
  assert.ok(!isValidCoords(NaN, LON));
  assert.ok(!isValidCoords(LAT, NaN));
  assert.ok(!isValidCoords(91, LON));      // out of range latitude
  assert.ok(!isValidCoords(LAT, 181));     // out of range longitude
  assert.ok(!isValidCoords(Infinity, LON));
});

test('distanceKm is symmetric and zero for the same point', () => {
  assert.strictEqual(distanceKm(LAT, LON, LAT, LON), 0);
  const a = distanceKm(LAT, LON, 40.7, -73.95);
  const b = distanceKm(40.7, -73.95, LAT, LON);
  assert.ok(Math.abs(a - b) < 1e-9);
});
