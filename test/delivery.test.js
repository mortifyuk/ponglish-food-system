const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, validCoordinates } = require('../lib/delivery');

test('distance from a point to itself is zero', () => {
  assert.equal(haversineKm(27.2579, 33.8116, 27.2579, 33.8116), 0);
});
test('distance is symmetric', () => {
  const a = haversineKm(27.2579, 33.8116, 27.3, 33.85);
  const b = haversineKm(27.3, 33.85, 27.2579, 33.8116);
  assert.ok(Math.abs(a - b) < 1e-9);
});
test('coordinates validate ranges and finite values', () => {
  assert.equal(validCoordinates(27.2, 33.8), true);
  assert.equal(validCoordinates(91, 33.8), false);
  assert.equal(validCoordinates(27.2, 181), false);
  assert.equal(validCoordinates(NaN, 33.8), false);
});
test('10 km delivery boundary is a circular distance, not latitude-only', () => {
  const origin = [27.2579, 33.8116];
  const near = haversineKm(origin[0], origin[1], 27.30, 33.84);
  const far = haversineKm(origin[0], origin[1], 27.40, 33.95);
  assert.ok(near < 10);
  assert.ok(far > 10);
});
