import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonArea, mean, meanOrNull, dominantGrado, findAdjacentGroups, unionGroup } from '../scripts/blocks.mjs';

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

test('findAdjacentGroups merges four touching squares into one group', () => {
  const features = [
    { geometry: square(0, 0, 1, 1) },
    { geometry: square(1, 0, 2, 1) },
    { geometry: square(0, 1, 1, 2) },
    { geometry: square(1, 1, 2, 2) },
    { geometry: square(100, 100, 101, 101) }, // far away, its own group
  ];
  const groups = findAdjacentGroups(features, 0.01);
  const sizes = groups.map((g) => g.length).sort((a, b) => a - b);
  assert.deepEqual(sizes, [1, 4]);
});

test('findAdjacentGroups keeps parcels separated by more than tolerance apart', () => {
  const features = [
    { geometry: square(0, 0, 1, 1) },
    { geometry: square(1.2, 0, 2.2, 1) }, // 0.2 gap, wider than the 0.05 tolerance
  ];
  const groups = findAdjacentGroups(features, 0.05);
  assert.equal(groups.length, 2);
});

test('findAdjacentGroups covers every input index exactly once', () => {
  const features = [
    { geometry: square(0, 0, 1, 1) },
    { geometry: square(1, 0, 2, 1) },
    { geometry: square(10, 10, 11, 11) },
  ];
  const groups = findAdjacentGroups(features, 0.01);
  const covered = groups.flat().sort((a, b) => a - b);
  assert.deepEqual(covered, [0, 1, 2]);
});

test('unionGroup merges two touching squares into one polygon covering both', () => {
  const merged = unionGroup([square(0, 0, 1, 1), square(1, 0, 2, 1)]);
  assert.ok(merged);
  assert.equal(polygonArea(merged), 2);
});

test('unionGroup passes a single geometry through unchanged', () => {
  const g = square(0, 0, 1, 1);
  assert.equal(unionGroup([g]), g);
});

test('unionGroup returns null on unusable input rather than throwing', () => {
  assert.equal(
    unionGroup([{ type: 'Point', coordinates: [0, 0] }, square(0, 0, 1, 1)]),
    null,
  );
});

test('unionGroup returns null on null/undefined geometry entry rather than throwing', () => {
  assert.equal(unionGroup([null, square(0, 0, 1, 1)]), null);
  assert.equal(unionGroup([undefined, square(0, 0, 1, 1)]), null);
});
