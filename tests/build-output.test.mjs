// Guards on the built artefacts. These encode the figures measured against the live
// sources on 2026-07-24 (Centro-only) and 2026-07-28 (citywide expansion); a large
// deviation means either the upstream data moved or a normalisation rule regressed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../scripts/paths.mjs';

const attrsPath = join(DATA_DIR, 'attrs.json');
const blocksPath = join(DATA_DIR, 'blocks.topo.json');
const hasBuild = existsSync(attrsPath);
const skip = hasBuild ? false : 'run `npm run fetch && npm run build:data` first';
const skipBlocks = hasBuild && existsSync(blocksPath) ? false : 'run `npm run fetch && npm run build:data` first';

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

test('blocks: touching parcels merge into far fewer city-block shapes', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  // Measured on the 2026-08-02 build; a large deviation means the adjacency tolerance or
  // the underlying parcel geometry changed. Unchanged by the switch to merging quantized
  // geometry — the ~0.44 m grid is fine enough not to regroup anything at a 0.5 m tolerance.
  assert.equal(meta.counts.blocks, 8360);
  // Sanity bound rather than an exact figure, so minor upstream data wobble doesn't break
  // this test the way an exact-equality assertion would.
  assert.ok(
    meta.counts.blocks < meta.counts.parcels / 3,
    `expected at least a 3x reduction from parcels to blocks, got ${meta.counts.parcels} -> ${meta.counts.blocks}`,
  );
});

test('blocks: the union actually dissolves, rather than falling back to unmerged members', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  // The whole point of merging is one outline per block. When buildBlocks ran against raw
  // pre-quantization coordinates, polygon-clipping choked on sub-tolerance digitizing noise
  // at shared parcel edges and 2942 of 8360 blocks (35.2%) fell back to keeping their
  // members' own geometry — still correct, but with visible internal seams and ~9x the
  // vertices. Merging the quantized geometry instead takes that to 0. A bound rather than
  // an exact 0 so a handful of genuinely degenerate groups upstream wouldn't fail the build.
  assert.equal(typeof meta.blockUnionFailures, 'number', 'blockUnionFailures must be persisted in meta');
  assert.ok(
    meta.blockUnionFailures < meta.counts.blocks / 100,
    `block union failure rate regressed: ${meta.blockUnionFailures}/${meta.counts.blocks}`,
  );
});

test('blocks: the emitted topology matches the ids and count the client assumes', { skip: skipBlocks }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  const topo = JSON.parse(readFileSync(blocksPath, 'utf8'));
  const geometries = topo.objects.blocks.geometries;

  assert.equal(geometries.length, meta.counts.blocks, 'emitted block geometries vs meta.counts.blocks');
  // presimplify()/simplify() strip `transform` and emit absolute floats; shipping that
  // instead of quantized deltas is what made this file 91% oversized once already, and
  // nothing but the file size showed it. Its presence proves quantize() ran last.
  assert.ok(topo.transform, 'blocks.topo.json must be quantized (no transform => simplify output shipped raw)');
  // The client derives block ids positionally — prepareFeatures index, idToColor(i) — and
  // looks the same index up in blockAttrs' parallel arrays. If the emitted order ever
  // stopped matching, every hover would report a different block's attributes.
  const misaligned = geometries.findIndex((g, i) => g.properties.id !== i);
  assert.equal(misaligned, -1, `geometry at index ${misaligned} carries a non-positional id`);
});

test('blocks: attribute arrays are index-aligned and fully populated', { skip }, () => {
  const { blockAttrs, meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  const n = meta.counts.blocks;
  for (const key of ['id', 'parcelIds', 'parcelCount', 'grado', 'gradoSharePct', 'altura', 'permits']) {
    assert.equal(blockAttrs[key].length, n, `blockAttrs.${key} length mismatch`);
  }
  assert.equal(blockAttrs.parcelCount.filter((c) => c < 1).length, 0, 'every block has at least one parcel');
  assert.equal(blockAttrs.grado.filter((g) => g == null).length, 0, 'every block has a dominant grado');
});
