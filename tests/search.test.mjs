import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPadronIndex, findExact, findPrefix, parseQuery } from '../src/search.js';

test('buildPadronIndex maps each padron to the feature ids that carry it', () => {
  const index = buildPadronIndex([100, 200, 100, 300]);
  assert.deepEqual(index.get(100), [0, 2]);
  assert.deepEqual(index.get(200), [1]);
  assert.deepEqual(index.get(300), [3]);
  assert.equal(index.size, 3);
});

test('buildPadronIndex skips null/undefined entries rather than indexing them', () => {
  const index = buildPadronIndex([100, null, undefined, 200]);
  assert.equal(index.size, 2);
  assert.equal(index.has(null), false);
  assert.equal(index.has(undefined), false);
});

test('findExact returns every id for a duplicated padron', () => {
  const index = buildPadronIndex([432381, 1, 432381, 432381]);
  assert.deepEqual(findExact(index, 432381), [0, 2, 3]);
});

test('findExact returns a single-element array for a unique padron', () => {
  const index = buildPadronIndex([432381, 1]);
  assert.deepEqual(findExact(index, 1), [1]);
});

test('findExact returns an empty array for no match, not undefined', () => {
  const index = buildPadronIndex([100, 200]);
  assert.deepEqual(findExact(index, 999), []);
});

test('findPrefix matches on the decimal string prefix', () => {
  const index = buildPadronIndex([120113, 120126, 125806, 432381]);
  const matches = findPrefix(index, '120').sort();
  assert.deepEqual(matches, [120113, 120126]);
});

test('findPrefix returns an empty array for an empty prefix', () => {
  const index = buildPadronIndex([100, 200]);
  assert.deepEqual(findPrefix(index, ''), []);
});

test('findPrefix caps the number of results at the given limit', () => {
  const index = buildPadronIndex([100, 101, 102, 103, 104]);
  const matches = findPrefix(index, '10', 3);
  assert.equal(matches.length, 3);
});

test('findPrefix defaults to a cap of 8', () => {
  const padrones = Array.from({ length: 20 }, (_, i) => 1000 + i);
  const index = buildPadronIndex(padrones);
  assert.equal(findPrefix(index, '1').length, 8);
});

test('parseQuery strips whitespace and reads the leading digit run', () => {
  assert.equal(parseQuery(' 432381 '), 432381);
  assert.equal(parseQuery('432381 A'), 432381);
  assert.equal(parseQuery('007'), 7);
});

test('parseQuery returns null for input with no leading digits', () => {
  assert.equal(parseQuery(''), null);
  assert.equal(parseQuery('abc'), null);
  assert.equal(parseQuery(null), null);
  assert.equal(parseQuery(undefined), null);
});
