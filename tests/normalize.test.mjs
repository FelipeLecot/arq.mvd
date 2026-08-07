import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePadron, parseSector, parseAltura, parseGrado, parsePotNumeric, cleanText, parseCvGrado } from '../scripts/normalize.mjs';

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

test('parsePotNumeric returns null for special-regime codes, never 0', () => {
  // v_mdg_parcelas carries the same trap as Centro's altura, but with far more special
  // codes: ranges ("9-12"), positional/PUD markers ("ALT.PUD."), zone codes ("CEP", "PAU9").
  for (const code of ['ALT.ESP.', '9-12', '16.50-37', 'CEP', 'PAU9', 'ALT.PUD.', 'U', '']) {
    assert.equal(parsePotNumeric(code), null, `expected null for "${code}"`);
    assert.notEqual(parsePotNumeric(code), 0, `must not flatten "${code}" to 0`);
  }
  assert.equal(parsePotNumeric('16.50'), 16.5);
  assert.equal(parsePotNumeric('80'), 80);
  assert.equal(parsePotNumeric(null), null);
});

test('cleanText trims and nulls out blanks and named placeholders', () => {
  assert.equal(cleanText('  Arq. Juan Tosi  '), 'Arq. Juan Tosi');
  assert.equal(cleanText(''), null);
  assert.equal(cleanText(null), null);
  assert.equal(cleanText(undefined), null);
  assert.equal(cleanText('-'), '-'); // '-' is only a placeholder when explicitly listed
  assert.equal(cleanText('-', ['-']), null);
  assert.equal(cleanText('sd', ['-', 'sd']), null);
  assert.equal(cleanText('Torre Cabildo', ['-', 'sd']), 'Torre Cabildo');
});

test('parseCvGrado maps Ciudad Vieja\'s 0-4 survey scale onto the shared grade codes', () => {
  // Confirmed against IM's "Criterios de valoración" legend: same 5 definitions as Centro's
  // own grado_proteccion, so this reuses G0-G4 rather than inventing a parallel scale.
  assert.equal(parseCvGrado(0).code, 'G0');
  assert.equal(parseCvGrado(1).code, 'G1');
  assert.equal(parseCvGrado(4).code, 'G4');
  // -1 and null both mean "not classified" on this source (grado_prot_2010 uses -1; one
  // record uses null) - both fall through to SC, same "surveyed, no grade" semantics SC
  // already carries for Centro's own ungraded parcels.
  assert.equal(parseCvGrado(-1).code, 'SC');
  assert.equal(parseCvGrado(null).code, 'SC');
});
