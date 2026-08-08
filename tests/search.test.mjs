import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPadronIndex, findExact, findPrefix, parseQuery,
  normalizeText, buildAddressIndex, findAddress, detectQueryKind,
} from '../src/search.js';

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

test('normalizeText folds case and strips accents', () => {
  assert.equal(normalizeText('BVAR ÁRTIGAS'), 'bvar artigas');
  assert.equal(normalizeText('Ejido'), 'ejido');
});

test('buildAddressIndex skips null addresses and keeps positional ids', () => {
  const index = buildAddressIndex(['18 DE JULIO 1234', null, 'EJIDO 1500']);
  assert.deepEqual(index.map((e) => e.id), [0, 2]);
});

test('findAddress matches a case/accent-insensitive substring', () => {
  const index = buildAddressIndex(['Bvar Artigas 1200', 'Ejido 1500', '18 de Julio 900']);
  assert.deepEqual(findAddress(index, 'artigas'), [0]);
  assert.deepEqual(findAddress(index, 'ÁRTIGAS'), [0]);
});

test('findAddress returns an empty array for no match or an empty query', () => {
  const index = buildAddressIndex(['Ejido 1500']);
  assert.deepEqual(findAddress(index, 'nowhere'), []);
  assert.deepEqual(findAddress(index, ''), []);
  assert.deepEqual(findAddress(index, '   '), []);
});

test('findAddress caps results at the given limit', () => {
  const index = buildAddressIndex(['Ejido 100', 'Ejido 101', 'Ejido 102', 'Ejido 103']);
  assert.equal(findAddress(index, 'ejido', 2).length, 2);
});

test('detectQueryKind reads a bare or sector-suffixed number as padron', () => {
  assert.equal(detectQueryKind('432381'), 'padron');
  assert.equal(detectQueryKind(' 432381 A '), 'padron');
  assert.equal(detectQueryKind('432381A'), 'padron');
});

test('detectQueryKind reads anything else as address', () => {
  assert.equal(detectQueryKind('18 de Julio 1234'), 'address');
  assert.equal(detectQueryKind('Ejido'), 'address');
  assert.equal(detectQueryKind(''), 'address');
});
