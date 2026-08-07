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

test('grade distribution: Centro grades untouched by pass 1, Ciudad Vieja grades merged in by pass 2', { skip }, () => {
  const { meta } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  // Measured on the 2026-08-07 build (post Task 4-7). RG is Centro-only and unchanged from
  // the pre-expansion figure (3875) since pass 1 doesn't consult the Ciudad Vieja map; every
  // other grade grew by however many of the 1835 Ciudad Vieja heritage records matched a
  // citywide padron (1743 did — see the gradoSource test below) and NA shrank by that same
  // 1743.
  assert.equal(meta.gradeCounts.RG, 3875);
  assert.equal(meta.gradeCounts.G0, 537);
  assert.equal(meta.gradeCounts.G1, 2351);
  assert.equal(meta.gradeCounts.G2, 2981);
  assert.equal(meta.gradeCounts.G3, 852);
  assert.equal(meta.gradeCounts.G4, 102);
  assert.equal(meta.gradeCounts.SC, 61);
  assert.ok(meta.gradeCounts.NA > 190000 && meta.gradeCounts.NA < 199846, `expected NA to shrink from 199846 by roughly the Ciudad Vieja match count, got ${meta.gradeCounts.NA}`);
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

test('addresses carry an actual door number, not just a street name', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  // Regression guard for the NUM_PUERTA bug (Task 7): the old fallback chain
  // (PUERTA/NRO_PUERTA/NRO) never matched v_mdg_accesos' real field, so every populated
  // address was street-name-only and addressPct > 90 above would have passed even in that
  // broken state. Measured on this build: 207,856/207,856 populated addresses contain a
  // digit. A collapse toward 0 means the door-number fallback chain regressed again.
  const withDigit = attrs.address.filter((a) => a && /\d/.test(a)).length;
  assert.ok(withDigit > 200000, `expected >200k addresses with a door number, got ${withDigit}`);
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

test('gradoSource identifies which survey graded each parcel', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.equal(attrs.gradoSource.slice(0, 9016).filter((s) => s !== 'centro').length, 0, 'every Centro parcel is gradoSource centro');
  const cvCount = attrs.gradoSource.filter((s) => s === 'ciudad-vieja').length;
  // Measured 1743 of the 1835 raw Ciudad Vieja heritage records (meta build log's
  // cvHeritageRecords) actually matched a citywide padron; the rest didn't join to any
  // v_mdg_parcelas row (e.g. already inside Centro's own inventory, or an unmatched padron).
  assert.ok(cvCount > 1500 && cvCount < 1891, `expected roughly 1835 ciudad-vieja gradoSource parcels, got ${cvCount}`);
});

test('Ciudad Vieja cv* fields are populated exactly where gradoSource says they should be', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  for (let i = 0; i < attrs.id.length; i++) {
    const hasCv = attrs.cvGrado2000[i] !== null || attrs.cvEstadoConsExt[i] !== null;
    if (attrs.gradoSource[i] === 'ciudad-vieja') {
      // Measured 0/1743 exceptions: every ciudad-vieja-sourced parcel carries at least one
      // of these two cv fields.
      assert.ok(hasCv, `parcel ${i} is gradoSource ciudad-vieja but has neither cvGrado2000 nor cvEstadoConsExt`);
    } else {
      assert.equal(attrs.cvBuildingName[i], null, `parcel ${i} has cvBuildingName without ciudad-vieja gradoSource`);
    }
  }
});

test('the remaining v_mdg_parcelas fields are populated citywide', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  assert.ok(attrs.areaTotal.filter((v) => v !== null).length > 200000, 'areaTotal should be ~100% populated');
  assert.ok(attrs.categoriaZona.filter((v) => v !== null).length > 200000, 'categoriaZona should be ~100% populated');
  assert.equal(typeof attrs.esPropiedadHorizontal[0], 'boolean');
});

test('landmark fields (protectionType, direccion) ride alongside the existing architect/date fields', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  const withArchitect = attrs.architect.filter((v) => v !== null).length;
  const withProtectionType = attrs.protectionType.filter((v) => v !== null).length;
  const withDireccion = attrs.direccion.filter((v) => v !== null).length;
  assert.ok(withProtectionType >= withArchitect, 'protectionType (100% of landmark records) should be at least as common as architect (41%)');
  // Measured: 1129 direccion vs 473 architect — direccion rides on the same landmark record
  // set as protectionType, so it should be at least as common as the sparser architect field.
  assert.ok(withDireccion >= withArchitect, 'direccion (declared-landmark records) should be at least as common as architect (41%)');
});

test('permit firstYear/totalArea/expediente are wired through and internally consistent', { skip }, () => {
  const { attrs } = JSON.parse(readFileSync(attrsPath, 'utf8'));
  let violations = 0;
  let totalAreaViolations = 0;
  for (let i = 0; i < attrs.id.length; i++) {
    if (attrs.firstPermitYear[i] != null && attrs.lastPermitYear[i] != null && attrs.firstPermitYear[i] > attrs.lastPermitYear[i]) violations++;
    // Measured 0/22054 exceptions: a parcel with a summed totalPermitArea must actually have
    // at least one permit on record — never a leftover sum with no permit count behind it.
    if (attrs.totalPermitArea[i] != null && (attrs.permits[i] == null || attrs.permits[i] < 1)) totalAreaViolations++;
  }
  assert.equal(violations, 0);
  assert.equal(totalAreaViolations, 0, 'totalPermitArea should never be set without a corresponding permits count');
  assert.ok(attrs.lastPermitExpediente.filter((v) => v !== null).length > 0, 'at least some permits should carry an expediente');
});
