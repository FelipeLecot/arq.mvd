// Guards on the built artefacts. These encode the figures measured against the live
// sources on 2026-07-24; a large deviation means either the upstream data moved or a
// normalisation rule regressed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../scripts/paths.mjs';

const attrsPath = join(DATA_DIR, 'attrs.json');
const hasBuild = existsSync(attrsPath);
const skip = hasBuild ? false : 'run `npm run fetch && npm run build:data` first';

test('all 9016 inventory features survive the build', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(attrs.id.length, 9016);
});

test('every padron_sector parses', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(attrs.padron.filter((p) => p === null).length, 0);
});

test('the 92 "Altura especial" parcels are null, not 0', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(attrs.altura.filter((a) => a === null).length, 92);
  assert.equal(attrs.altura.filter((a) => a === 0).length, 0);
});

test('grade distribution matches the source', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.deepEqual(meta.gradeCounts, {
    RG: 3875, G2: 2375, G1: 1743, G3: 590, G0: 316, SC: 60, G4: 57,
  });
});

test('permit coverage stays near the measured 21%', { skip }, () => {
  // A big drop here almost certainly means the sector-strip in parsePadron regressed.
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.ok(
    meta.coverage.permitPct > 15 && meta.coverage.permitPct < 27,
    `permit coverage ${meta.coverage.permitPct}% is outside the expected band`,
  );
});

test('geometry is projected into Web Mercator over Montevideo', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  const [minX, minY, maxX, maxY] = meta.bbox;
  // Centro sits near -6.25e6, -4.15e6 in EPSG:3857. Catches a mis-zoned or
  // unprojected build immediately.
  assert.ok(minX > -6.30e6 && maxX < -6.24e6, `x out of range: ${minX}..${maxX}`);
  assert.ok(minY > -4.16e6 && maxY < -4.14e6, `y out of range: ${minY}..${maxY}`);
  // Centro is roughly 3.3 x 2.1 km; in Mercator at this latitude that inflates ~1.22x.
  assert.ok(maxX - minX > 2000 && maxX - minX < 8000, `width ${maxX - minX}`);
});
