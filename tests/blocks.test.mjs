import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonArea, mean, meanOrNull, dominantGrado } from '../scripts/blocks.mjs';

function square(x0, y0, x1, y1) {
  return {
    type: 'Polygon',
    coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
  };
}

test('polygonArea computes a unit square as area 1', () => {
  assert.equal(polygonArea(square(0, 0, 1, 1)), 1);
});

test('mean treats every value as real, including zero', () => {
  assert.equal(mean([0, 0, 4]), 4 / 3);
  assert.equal(mean([]), 0);
});

test('meanOrNull skips nulls and returns null only when nothing is left', () => {
  assert.equal(meanOrNull([10, null, 20]), 15);
  assert.equal(meanOrNull([null, null]), null);
  assert.equal(meanOrNull([]), null);
});

test('dominantGrado picks the largest-area code', () => {
  const result = dominantGrado([
    { code: 'G2', area: 100 },
    { code: 'NA', area: 300 },
  ]);
  assert.equal(result.code, 'NA');
  assert.equal(result.sharePct, 75);
});

test('dominantGrado breaks an exact area tie in favor of the more protective grade', () => {
  // A block exactly half G4/half NA should read as G4, not silently drop the one
  // heritage-grade parcel it contains just because area alone can't break the tie.
  const result = dominantGrado([
    { code: 'G4', area: 50 },
    { code: 'NA', area: 50 },
  ]);
  assert.equal(result.code, 'G4');
  assert.equal(result.sharePct, 50);
});
