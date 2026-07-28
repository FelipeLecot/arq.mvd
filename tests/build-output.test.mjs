// Guards on the built artefacts. These encode the figures measured against the live
// sources on 2026-07-24 (Centro-only) and 2026-07-28 (citywide expansion); a large
// deviation means either the upstream data moved or a normalisation rule regressed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../scripts/paths.mjs';

const attrsPath = join(DATA_DIR, 'attrs.json');
const hasBuild = existsSync(attrsPath);
const skip = hasBuild ? false : 'run `npm run fetch && npm run build:data` first';

test('Centro keeps its own 9016 curated features, ids first', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(attrs.id.slice(0, 9016).join(','), Array.from({ length: 9016 }, (_, i) => i).join(','));
  assert.equal(attrs.padron.slice(0, 9016).filter((p) => p === null).length, 0);
});

test('citywide parcels from v_mdg_parcelas fill out the rest', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  // 208,556 raw POT parcels minus however many padrones Centro's own inventory already
  // covers; a collapse toward 9016 means the POT source stopped loading.
  assert.ok(attrs.id.length > 200000, `expected >200k total parcels, got ${attrs.id.length}`);
});

test('the 92 Centro "Altura especial" parcels are null, not 0', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  // Within Centro specifically, a 0 would mean the old parseFloat()||0 bug came back —
  // Centro's own altura field never carries a genuine "0", only the special-regime string.
  assert.equal(attrs.altura.slice(0, 9016).filter((a) => a === null).length, 92);
  assert.equal(attrs.altura.slice(0, 9016).filter((a) => a === 0).length, 0);
  // Citywide, a small number of real 0s are expected and correct: v_mdg_parcelas assigns
  // ALTURA "0" to aerodromo/zona-franca service land where no building envelope applies at
  // all. That is a genuine zero, distinct from the special-regime codes (which parse to
  // null, never 0) — see parsePotNumeric's dedicated test.
});

test('grade distribution: Centro grades untouched, NA covers everything outside the inventory', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(meta.gradeCounts.RG, 3875);
  assert.equal(meta.gradeCounts.G2, 2375);
  assert.equal(meta.gradeCounts.G1, 1743);
  assert.equal(meta.gradeCounts.G3, 590);
  assert.equal(meta.gradeCounts.G0, 316);
  assert.equal(meta.gradeCounts.SC, 60);
  assert.equal(meta.gradeCounts.G4, 57);
  assert.ok(meta.gradeCounts.NA > 190000, `expected >190k NA parcels, got ${meta.gradeCounts.NA}`);
});

test('citywide coverage stats are internally consistent', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(meta.coverage.centroParcels, 9016);
  assert.equal(meta.coverage.centroAlturaEspecial, 92);
  // Citywide permit/address coverage is expected to differ from the old Centro-only
  // figures (21% / 99.5%) since it now averages over a much larger, sparser population.
  assert.ok(meta.coverage.permitPct > 0 && meta.coverage.permitPct < 100);
  assert.ok(meta.coverage.addressPct > 90, `address coverage regressed: ${meta.coverage.addressPct}%`);
});

test('geometry is projected into Web Mercator and spans the full city, not just Centro', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  const [minX, minY, maxX, maxY] = meta.bbox;
  // Montevideo department in EPSG:3857; wide enough to catch a mis-zoned build but loose
  // enough to allow for future coastal/rural parcels at the edges of v_mdg_parcelas.
  assert.ok(minX > -6.35e6 && maxX < -6.15e6, `x out of range: ${minX}..${maxX}`);
  assert.ok(minY > -4.20e6 && maxY < -4.10e6, `y out of range: ${minY}..${maxY}`);
  // Citywide should be an order of magnitude wider than Centro's ~3.3 km alone.
  assert.ok(maxX - minX > 20000, `width too small for a citywide build: ${maxX - minX}`);
});
