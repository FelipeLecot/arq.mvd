// Build stage: raw sources -> data/centro.topo.json, data/vias.topo.json, data/attrs.json
//
// Geometry and attributes are emitted to SEPARATE files on purpose. Switching the active
// attribute or restyling must never re-parse geometry, so the browser loads topology once
// and swaps columnar attribute arrays freely.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as shapefile from 'shapefile';
import { topology } from 'topojson-server';
import { DATA_DIR, RAW_DIR } from './paths.mjs';
import { readBySuffix } from './zip.mjs';
import { parsePermits } from './permits.mjs';
import { parsePadron, parseSector, parseAltura, parseGrado, GRADE_ORDER } from './normalize.mjs';
import { projectGeometry, projectPoint, pointInGeometry, bbox, bboxIntersects, centroid } from './geo.mjs';

const QUANTIZATION = 1e5;

async function readJson(file) {
  return JSON.parse(await readFile(join(RAW_DIR, file), 'utf8'));
}

/** Read a shapefile out of one of the intgis zips. */
async function readShapefileZip(file) {
  const buf = await readFile(join(RAW_DIR, file));
  const shp = readBySuffix(buf, '.shp');
  const dbf = readBySuffix(buf, '.dbf');
  // The IM exports are latin1; without this, accented street names arrive mojibaked.
  return shapefile.read(shp, dbf, { encoding: 'latin1' });
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const stats = {};

  // ---- Ámbito: the Centro boundary, used to clip everything else -----------------
  const ambitoRaw = await readJson('ambito_inventario_patrimonial_centro.geojson');
  const ambito = projectGeometry(ambitoRaw.features[0].geometry);
  const ambitoBox = bbox(ambito);

  // ---- Permits ------------------------------------------------------------------
  const permits = parsePermits(await readFile(join(RAW_DIR, 'permisos_construccion.zip')));
  stats.permitPadrones = permits.size;

  // ---- Address points, indexed by padron ----------------------------------------
  // Used to give the hover card a street address. Clipped to the ámbito first so we
  // aren't carrying 200k+ citywide points through the join.
  const accesos = await readShapefileZip('v_mdg_accesos.zip');
  const addressByPadron = new Map();
  for (const f of accesos.features) {
    if (!f.geometry) continue;
    const p = projectPoint(f.geometry.coordinates);
    if (p[0] < ambitoBox[0] || p[0] > ambitoBox[2] || p[1] < ambitoBox[1] || p[1] > ambitoBox[3]) continue;
    const props = f.properties || {};
    const padron = Number.parseInt(props.PADRON ?? props.padron, 10);
    if (!Number.isFinite(padron) || addressByPadron.has(padron)) continue;
    const calle = String(props.CALLE ?? props.NOM_CALLE ?? '').trim();
    const nro = String(props.PUERTA ?? props.NRO_PUERTA ?? props.NRO ?? '').trim();
    if (calle) addressByPadron.set(padron, nro ? `${calle} ${nro}` : calle);
  }
  stats.addressesInAmbito = addressByPadron.size;

  // ---- Parcels: the core layer ---------------------------------------------------
  const invRaw = await readJson('inventario_patrimonial_centro.geojson');
  stats.sourceFeatures = invRaw.features.length;

  const parcelFeatures = [];
  const attrs = {
    id: [],
    padron: [],
    sector: [],
    grado: [],
    altura: [],
    permits: [],
    lastPermitYear: [],
    address: [],
    destino: [],
    gradoDetail: [],
  };

  let alturaEspecial = 0;
  let padronParseFailures = 0;
  let permitMatches = 0;

  invRaw.features.forEach((f, i) => {
    if (!f.geometry) return;
    const props = f.properties || {};
    const padron = parsePadron(props.padron_sector);
    const grado = parseGrado(props.grado_proteccion);
    const altura = parseAltura(props.altura);

    if (padron === null) padronParseFailures++;
    if (altura === null) alturaEspecial++;

    const permit = padron !== null ? permits.get(padron) : null;
    if (permit) permitMatches++;

    const id = i;
    parcelFeatures.push({
      type: 'Feature',
      id,
      geometry: projectGeometry(f.geometry),
      properties: { id },
    });

    attrs.id.push(id);
    attrs.padron.push(padron);
    attrs.sector.push(parseSector(props.padron_sector));
    attrs.grado.push(grado.code);
    attrs.altura.push(altura);
    attrs.permits.push(permit ? permit.count : 0);
    attrs.lastPermitYear.push(permit ? permit.lastYear : null);
    attrs.address.push(padron !== null ? addressByPadron.get(padron) ?? null : null);
    attrs.destino.push(permit ? permit.destino : null);
    attrs.gradoDetail.push(grado.detail);
  });

  stats.parcels = parcelFeatures.length;
  stats.alturaEspecial = alturaEspecial;
  stats.padronParseFailures = padronParseFailures;
  stats.parcelsWithPermits = permitMatches;
  stats.parcelsWithAddress = attrs.address.filter(Boolean).length;

  // ---- Streets, clipped to the ámbito --------------------------------------------
  // v_sig_vias (not v_mdg_vias) because only it carries TIPO, which drives line weight.
  const vias = await readShapefileZip('v_sig_vias.zip');
  const viaFeatures = [];
  for (const f of vias.features) {
    if (!f.geometry) continue;
    const geom = projectGeometry(f.geometry);
    if (!bboxIntersects(bbox(geom), ambitoBox)) continue;
    const c = centroid(geom);
    if (!c || !pointInGeometry(c, ambito)) continue;
    const props = f.properties || {};
    viaFeatures.push({
      type: 'Feature',
      geometry: geom,
      properties: {
        name: String(props.NOM_CALLE ?? '').trim() || null,
        tipo: String(props.TIPO ?? '').trim() || null,
      },
    });
  }
  stats.streetsInAmbito = viaFeatures.length;
  stats.streetTypes = [...new Set(viaFeatures.map((f) => f.properties.tipo))].filter(Boolean);

  // ---- Emit ----------------------------------------------------------------------
  const parcelsTopo = topology(
    { parcels: { type: 'FeatureCollection', features: parcelFeatures } },
    QUANTIZATION,
  );
  const viasTopo = topology(
    {
      vias: { type: 'FeatureCollection', features: viaFeatures },
      ambito: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: ambito, properties: {} }] },
    },
    QUANTIZATION,
  );

  const gradeCounts = {};
  for (const g of attrs.grado) gradeCounts[g] = (gradeCounts[g] || 0) + 1;

  const meta = {
    generated: new Date().toISOString(),
    bbox: bbox(ambito),
    counts: { parcels: stats.parcels, streets: stats.streetsInAmbito },
    gradeCounts,
    gradeOrder: GRADE_ORDER,
    coverage: {
      // Surfaced in the UI so the atlas states its own limits rather than implying
      // citywide or complete data.
      permitPct: +((100 * stats.parcelsWithPermits) / stats.parcels).toFixed(1),
      addressPct: +((100 * stats.parcelsWithAddress) / stats.parcels).toFixed(1),
      alturaEspecial,
    },
  };

  await writeFile(join(DATA_DIR, 'centro.topo.json'), JSON.stringify(parcelsTopo));
  await writeFile(join(DATA_DIR, 'vias.topo.json'), JSON.stringify(viasTopo));
  await writeFile(join(DATA_DIR, 'attrs.json'), JSON.stringify({ meta, attrs }));

  console.log('Build complete:');
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  console.log('  grades:', JSON.stringify(gradeCounts));
  console.log('  coverage:', JSON.stringify(meta.coverage));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
