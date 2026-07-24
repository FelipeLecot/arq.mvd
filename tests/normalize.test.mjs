import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePadron, parseSector, parseAltura, parseGrado } from '../scripts/normalize.mjs';

test('parsePadron strips the sector suffix', () => {
  assert.equal(parsePadron('432381 A'), 432381);
  assert.equal(parsePadron('432381'), 432381);
  assert.equal(parsePadron(' 12 B '), 12);
  assert.equal(parsePadron(''), null);
  assert.equal(parsePadron(null), null);
});

test('parseSector keeps the letter separately', () => {
  assert.equal(parseSector('432381 A'), 'A');
  assert.equal(parseSector('432381'), null);
});

test('parseAltura returns null for "Altura especial", never 0', () => {
  // The trap: parseFloat('Altura especial') || 0 would flatten 92 buildings to the ground.
  assert.equal(parseAltura('Altura especial'), null);
  assert.notEqual(parseAltura('Altura especial'), 0);
  assert.equal(parseAltura('36'), 36);
  assert.equal(parseAltura('16.50'), 16.5);
  assert.equal(parseAltura(null), null);
});

test('parseGrado extracts a short code from the full sentence', () => {
  const g3 = parseGrado(
    'Grado 3 - Protección Estructural. Edificio que debe ser conservado mejorando sus condiciones.',
  );
  assert.equal(g3.code, 'G3');
  assert.equal(g3.label, 'Protección Estructural');
  assert.ok(g3.detail.includes('Edificio que debe ser conservado'));

  assert.equal(parseGrado('Régimen General').code, 'RG');
  assert.equal(parseGrado('Sin Catalogar').code, 'SC');
  assert.equal(parseGrado(null).code, 'SC');
  assert.equal(parseGrado('Grado 0 - Sustitución deseable. Inmueble con valores negativos.').code, 'G0');
  assert.equal(parseGrado('Grado 4 - Protección Integral. Edificio de valor excepcional.').code, 'G4');
});
