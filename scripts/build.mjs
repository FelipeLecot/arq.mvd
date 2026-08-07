// Build stage: raw sources -> data/centro.topo.json, data/vias.topo.json, data/attrs.json
//
// Geometry and attributes are emitted to SEPARATE files on purpose. Switching the active
// attribute or restyling must never re-parse geometry, so the browser loads topology once
// and swaps columnar attribute arrays freely.
//
// Coverage is two-tier: Centro's own inventory (grado_proteccion, 100% coverage, curated
// geometry) stays authoritative wherever it applies. Every other parcel in the city comes
// from v_mdg_parcelas — no heritage grade, but a real legal-height/FOS/setback envelope
// (ALTURA/FOS/RETIRO) that the original research concluded did not exist in open data.
// Those parcels get grado 'NA' ("fuera del inventario patrimonial") rather than being
// folded into Centro's 'SC' ("Sin Catalogar") — the two mean different things.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as shapefile from 'shapefile';
import { topology } from 'topojson-server';
import { presimplify, simplify } from 'topojson-simplify';
import { feature, quantize } from 'topojson-client';
import { DATA_DIR, RAW_DIR } from './paths.mjs';
import { readBySuffix } from './zip.mjs';
import { parsePermits } from './permits.mjs';
import { parsePadron, parseSector, parseAltura, parseGrado, parsePotNumeric, parseCvGrado, cleanText, GRADE_ORDER } from './normalize.mjs';
import { buildBlocks } from './blocks.mjs';
import { projectGeometry, bbox } from './geo.mjs';

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

/** Extend a running [minX, minY, maxX, maxY] with a projected geometry, in place. */
function growBbox(box, geometry) {
  const [minX, minY, maxX, maxY] = bbox(geometry);
  if (minX < box[0]) box[0] = minX;
  if (minY < box[1]) box[1] = minY;
  if (maxX > box[2]) box[2] = maxX;
  if (maxY > box[3]) box[3] = maxY;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const stats = {};

  // ---- Ámbito: Centro's boundary. Still emitted as an overlay, but no longer used to clip
  // anything — the atlas is citywide now, so nothing else is filtered against it. -----------
  const ambitoRaw = await readJson('ambito_inventario_patrimonial_centro.geojson');
  const ambito = projectGeometry(ambitoRaw.features[0].geometry);

  // ---- Permits, citywide ----------------------------------------------------------------
  const permits = parsePermits(await readFile(join(RAW_DIR, 'permisos_construccion.zip')));
  stats.permitPadrones = permits.size;

  // ---- Address points, citywide, indexed by padron ---------------------------------------
  const accesos = await readShapefileZip('v_mdg_accesos.zip');
  const addressByPadron = new Map();
  for (const f of accesos.features) {
    if (!f.geometry) continue;
    const props = f.properties || {};
    const padron = Number.parseInt(props.PADRON ?? props.padron, 10);
    if (!Number.isFinite(padron) || addressByPadron.has(padron)) continue;
    const calle = String(props.CALLE ?? props.NOM_CALLE ?? '').trim();
    const nro = String(props.PUERTA ?? props.NRO_PUERTA ?? props.NRO ?? '').trim();
    if (calle) addressByPadron.set(padron, nro ? `${calle} ${nro}` : calle);
  }
  stats.addresses = addressByPadron.size;

  // ---- POT parcels (v_mdg_parcelas): citywide legal-height envelope + zone name ----------
  // Read once into two shapes: an attribute lookup (used to enrich EVERY parcel, including
  // Centro's) and a feature list (used only for parcels Centro's own inventory doesn't cover).
  const potShp = await readShapefileZip('v_mdg_parcelas.zip');
  const potAttrsByPadron = new Map();
  const potFeatures = [];
  for (const f of potShp.features) {
    if (!f.geometry) continue;
    const props = f.properties || {};
    const padron = Number.parseInt(props.PADRON, 10);
    const entry = {
      altura: parsePotNumeric(props.ALTURA),
      areaDifer: String(props.AREA_DIFER ?? '').trim() || null,
      areaTotal: Number.isFinite(props.AREATOT) ? props.AREATOT : null,
      areaCatastral: Number.isFinite(props.AREACAT) ? props.AREACAT : null,
      esPropiedadHorizontal: props.PH === 1,
      carpetaPh: Number.isFinite(props.CARPETA_PH) ? props.CARPETA_PH : null,
      categoriaZona: cleanText(props.CATEGORIA),
      subCategoriaZona: cleanText(props.SUB_CATEGO),
      rgs: cleanText(props.RGS),
      usoPredominante: cleanText(props.USOPRE),
      // RETIRO/FOS/FIS/GALIBO mix pure numbers ("60") with qualifier codes ("20R", "NC",
      // "ADET") — parsePotNumeric (as ALTURA uses) would silently drop the qualifier, so
      // these stay raw trimmed strings instead of coerced numbers.
      retiro: cleanText(props.RETIRO),
      fos: cleanText(props.FOS),
      fis: cleanText(props.FIS),
      galibo: cleanText(props.GALIBO),
      planEspecial: cleanText(props.PLANESP),
      planParcial: cleanText(props.PLANPARCIA),
      promocion: cleanText(props.PROMO),
      transicionNombre: cleanText(props.NOM_TRANS),
      transicionTipo: cleanText(props.TIPO_TRANS),
      transicionEstado: cleanText(props.ESTADO_TRA),
      rnAreaDiferenciada: cleanText(props.RN_AREA_DI),
    };
    if (Number.isFinite(padron) && !potAttrsByPadron.has(padron)) potAttrsByPadron.set(padron, entry);
    potFeatures.push({ padron: Number.isFinite(padron) ? padron : null, geometry: f.geometry, ...entry });
  }
  stats.potParcels = potFeatures.length;

  // ---- Citywide declared heritage landmarks (v_pat_mhn_bienespatrimoniales) --------------
  // Sparse (1195 records) but carries architect and construction date, which Centro's own
  // inventory does not. Indexed by padron; first match wins on duplicates.
  const bienesShp = await readShapefileZip('v_pat_mhn_bienespatrimoniales.zip');
  const heritageByPadron = new Map();
  for (const f of bienesShp.features) {
    const props = f.properties || {};
    const padron = Number.parseInt(props.PADRON, 10);
    if (!Number.isFinite(padron) || heritageByPadron.has(padron)) continue;
    heritageByPadron.set(padron, {
      name: cleanText(props.IDENTIFICA, ['-']),
      architect: cleanText(props.AUTORIA, ['-']),
      builtDate: cleanText(props.FECHA, ['-']),
      declaration: cleanText(props.DECLARATOR, ['-']),
      protectionType: cleanText(props.MHN, ['-']),
      direccion: cleanText(props.DIRECCION, ['-']),
      decreto: cleanText(props.DECRETO, ['-']),
      nroEspacio: Number.isFinite(props.NRO_ESPACI) ? props.NRO_ESPACI : null,
    });
  }
  stats.heritageRecords = heritageByPadron.size;

  // ---- Ciudad Vieja per-building heritage survey (pm_bienes_patrimoniales, WFS) -----------
  // Confirmed 2026-08-07 disjoint from Centro's own inventory: only 2 of 1891 records fall
  // inside the ámbito boundary, and both padrones are already covered by Centro's own curated
  // grade in pass 1 below — so this map is only ever consulted for pass-2 POT parcels, never
  // overrides Centro's own grade. See docs/superpowers/specs/2026-08-07-heritage-data-expansion-design.md.
  const cvRaw = await readJson('pm_bienes_patrimoniales.json');
  const cvHeritageByPadron = new Map();
  const num = (v) => (Number.isFinite(v) ? v : null);
  for (const f of cvRaw.features) {
    const props = f.properties || {};
    const padron = Number.isFinite(props.nro_padron) ? props.nro_padron : null;
    if (padron === null || cvHeritageByPadron.has(padron)) continue; // first sector row wins, same rule as every other padrón-keyed join here
    cvHeritageByPadron.set(padron, {
      grado: parseCvGrado(props.grado_prot_2010).code,
      grado1983: num(props.grado_prot_1983),
      grado2000: num(props.grado_prot_2000),
      estadoConsExt: num(props.estado_cons_ext),
      estadoConsInt: num(props.estado_cons_int),
      epoca: num(props.epoca_ori),
      categoria: num(props.categoria),
      tipoProp: num(props.tipo_prop),
      regProp: num(props.reg_prop),
      usoGlobalOri: num(props.uso_global_ori),
      usoGlobalAct: num(props.uso_global_act),
      usoOriSs: num(props.uso_ori_ss),
      usoOriPb: num(props.uso_ori_pb),
      usoOriEp: num(props.uso_ori_ep),
      usoOriPa: num(props.uso_ori_pa),
      usoActSs: num(props.uso_act_ss),
      usoActPb: num(props.uso_act_pb),
      usoActEp: num(props.uso_act_ep),
      usoActPa: num(props.uso_act_pa),
      intervencionesExtPb: num(props.intervenciones_ext_pb),
      intervencionesExtPpaa: num(props.intervenciones_ext_ppaa),
      intervencionesIntPb: num(props.intervenciones_int_pb),
      intervencionesIntPpaa: num(props.intervenciones_int_ppaa),
      buildingNameOrig: cleanText(props.denom_ori, ['-', 'sd']),
      buildingName: cleanText(props.denom_act, ['-', 'sd']),
    });
  }
  stats.cvHeritageRecords = cvHeritageByPadron.size;

  // ---- Parcels: Centro's own inventory first (curated geometry, heritage grade) ----------
  const invRaw = await readJson('inventario_patrimonial_centro.geojson');
  stats.centroSourceFeatures = invRaw.features.length;

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
    gradoSource: [],
    cvGrado1983: [],
    cvGrado2000: [],
    cvEstadoConsExt: [],
    cvEstadoConsInt: [],
    cvEpoca: [],
    cvCategoria: [],
    cvTipoProp: [],
    cvRegProp: [],
    cvUsoGlobalOri: [],
    cvUsoGlobalAct: [],
    cvUsoOriSs: [],
    cvUsoOriPb: [],
    cvUsoOriEp: [],
    cvUsoOriPa: [],
    cvUsoActSs: [],
    cvUsoActPb: [],
    cvUsoActEp: [],
    cvUsoActPa: [],
    cvIntervencionesExtPb: [],
    cvIntervencionesExtPpaa: [],
    cvIntervencionesIntPb: [],
    cvIntervencionesIntPpaa: [],
    cvBuildingNameOrig: [],
    cvBuildingName: [],
    barrio: [],
    areaTotal: [],
    areaCatastral: [],
    esPropiedadHorizontal: [],
    carpetaPh: [],
    categoriaZona: [],
    subCategoriaZona: [],
    rgs: [],
    usoPredominante: [],
    retiro: [],
    fos: [],
    fis: [],
    galibo: [],
    planEspecial: [],
    planParcial: [],
    promocion: [],
    transicionNombre: [],
    transicionTipo: [],
    transicionEstado: [],
    rnAreaDiferenciada: [],
    heritageName: [],
    architect: [],
    builtDate: [],
    heritageDeclaration: [],
    protectionType: [],
    direccion: [],
    decreto: [],
    nroEspacio: [],
  };

  let alturaEspecial = 0;
  let padronParseFailures = 0;
  let permitMatches = 0;
  let nextId = 0;
  const dataBbox = [Infinity, Infinity, -Infinity, -Infinity];

  function pushParcel({ geometry, padron, sector, grado, gradoDetail, gradoSource, altura, cv }) {
    const id = nextId++;
    const projected = projectGeometry(geometry);
    growBbox(dataBbox, projected);
    parcelFeatures.push({ type: 'Feature', id, geometry: projected, properties: { id } });

    const permit = padron !== null ? permits.get(padron) : null;
    if (permit) permitMatches++;
    const heritage = padron !== null ? heritageByPadron.get(padron) : null;
    const pot = padron !== null ? potAttrsByPadron.get(padron) : null;

    attrs.id.push(id);
    attrs.padron.push(padron);
    attrs.sector.push(sector);
    attrs.grado.push(grado);
    attrs.altura.push(altura);
    attrs.permits.push(permit ? permit.count : 0);
    attrs.lastPermitYear.push(permit ? permit.lastYear : null);
    attrs.address.push(padron !== null ? addressByPadron.get(padron) ?? null : null);
    attrs.destino.push(permit ? permit.destino : null);
    attrs.gradoDetail.push(gradoDetail);
    attrs.barrio.push(pot ? pot.areaDifer : null);
    attrs.areaTotal.push(pot ? pot.areaTotal : null);
    attrs.areaCatastral.push(pot ? pot.areaCatastral : null);
    attrs.esPropiedadHorizontal.push(pot ? pot.esPropiedadHorizontal : null);
    attrs.carpetaPh.push(pot ? pot.carpetaPh : null);
    attrs.categoriaZona.push(pot ? pot.categoriaZona : null);
    attrs.subCategoriaZona.push(pot ? pot.subCategoriaZona : null);
    attrs.rgs.push(pot ? pot.rgs : null);
    attrs.usoPredominante.push(pot ? pot.usoPredominante : null);
    attrs.retiro.push(pot ? pot.retiro : null);
    attrs.fos.push(pot ? pot.fos : null);
    attrs.fis.push(pot ? pot.fis : null);
    attrs.galibo.push(pot ? pot.galibo : null);
    attrs.planEspecial.push(pot ? pot.planEspecial : null);
    attrs.planParcial.push(pot ? pot.planParcial : null);
    attrs.promocion.push(pot ? pot.promocion : null);
    attrs.transicionNombre.push(pot ? pot.transicionNombre : null);
    attrs.transicionTipo.push(pot ? pot.transicionTipo : null);
    attrs.transicionEstado.push(pot ? pot.transicionEstado : null);
    attrs.rnAreaDiferenciada.push(pot ? pot.rnAreaDiferenciada : null);
    attrs.heritageName.push(heritage ? heritage.name : null);
    attrs.architect.push(heritage ? heritage.architect : null);
    attrs.builtDate.push(heritage ? heritage.builtDate : null);
    attrs.heritageDeclaration.push(heritage ? heritage.declaration : null);
    attrs.protectionType.push(heritage ? heritage.protectionType : null);
    attrs.direccion.push(heritage ? heritage.direccion : null);
    attrs.decreto.push(heritage ? heritage.decreto : null);
    attrs.nroEspacio.push(heritage ? heritage.nroEspacio : null);
    attrs.gradoSource.push(gradoSource);
    attrs.cvGrado1983.push(cv ? cv.grado1983 : null);
    attrs.cvGrado2000.push(cv ? cv.grado2000 : null);
    attrs.cvEstadoConsExt.push(cv ? cv.estadoConsExt : null);
    attrs.cvEstadoConsInt.push(cv ? cv.estadoConsInt : null);
    attrs.cvEpoca.push(cv ? cv.epoca : null);
    attrs.cvCategoria.push(cv ? cv.categoria : null);
    attrs.cvTipoProp.push(cv ? cv.tipoProp : null);
    attrs.cvRegProp.push(cv ? cv.regProp : null);
    attrs.cvUsoGlobalOri.push(cv ? cv.usoGlobalOri : null);
    attrs.cvUsoGlobalAct.push(cv ? cv.usoGlobalAct : null);
    attrs.cvUsoOriSs.push(cv ? cv.usoOriSs : null);
    attrs.cvUsoOriPb.push(cv ? cv.usoOriPb : null);
    attrs.cvUsoOriEp.push(cv ? cv.usoOriEp : null);
    attrs.cvUsoOriPa.push(cv ? cv.usoOriPa : null);
    attrs.cvUsoActSs.push(cv ? cv.usoActSs : null);
    attrs.cvUsoActPb.push(cv ? cv.usoActPb : null);
    attrs.cvUsoActEp.push(cv ? cv.usoActEp : null);
    attrs.cvUsoActPa.push(cv ? cv.usoActPa : null);
    attrs.cvIntervencionesExtPb.push(cv ? cv.intervencionesExtPb : null);
    attrs.cvIntervencionesExtPpaa.push(cv ? cv.intervencionesExtPpaa : null);
    attrs.cvIntervencionesIntPb.push(cv ? cv.intervencionesIntPb : null);
    attrs.cvIntervencionesIntPpaa.push(cv ? cv.intervencionesIntPpaa : null);
    attrs.cvBuildingNameOrig.push(cv ? cv.buildingNameOrig : null);
    attrs.cvBuildingName.push(cv ? cv.buildingName : null);
  }

  const centroPadrones = new Set();
  for (const f of invRaw.features) {
    if (!f.geometry) continue;
    const props = f.properties || {};
    const padron = parsePadron(props.padron_sector);
    const grado = parseGrado(props.grado_proteccion);
    const altura = parseAltura(props.altura);

    if (padron === null) padronParseFailures++;
    else centroPadrones.add(padron);
    if (altura === null) alturaEspecial++;

    pushParcel({
      geometry: f.geometry,
      padron,
      sector: parseSector(props.padron_sector),
      grado: grado.code,
      gradoDetail: grado.detail,
      gradoSource: 'centro',
      altura,
      cv: null,
    });
  }
  stats.centroParcels = nextId;
  stats.centroAlturaEspecial = alturaEspecial;
  stats.centroPadronParseFailures = padronParseFailures;

  // ---- Citywide parcels: everything v_mdg_parcelas covers that Centro's inventory doesn't
  for (const pf of potFeatures) {
    if (pf.padron !== null && centroPadrones.has(pf.padron)) continue; // Centro's version wins.
    const cv = pf.padron !== null ? cvHeritageByPadron.get(pf.padron) : null;
    pushParcel({
      geometry: pf.geometry,
      padron: pf.padron,
      sector: null,
      grado: cv ? cv.grado : 'NA',
      gradoDetail: null,
      gradoSource: cv ? 'ciudad-vieja' : null,
      altura: pf.altura,
      cv,
    });
  }

  stats.parcels = nextId;
  stats.parcelsWithPermits = permitMatches;
  stats.parcelsWithAddress = attrs.address.filter(Boolean).length;
  stats.parcelsWithHeritageDetail = attrs.architect.filter(Boolean).length;

  // ---- Parcel topology, built BEFORE the blocks so the blocks can be merged from it -----
  const parcelsTopo = topology(
    { parcels: { type: 'FeatureCollection', features: parcelFeatures } },
    QUANTIZATION,
  );

  // ---- Blocks: merge touching parcels into city-block geometry for the zoomed-out LOD --
  // Merged from the parcel geometry AS QUANTIZED, not from the raw projected floats.
  // Neighbouring cadastral parcels are digitized with sub-millimetre disagreement along
  // their shared edge; polygon-clipping's union throws or degenerates on that noise often
  // enough that merging the raw coordinates failed on ~35% of multi-parcel groups, leaving
  // most "blocks" as unmerged MultiPolygons with visible internal parcel seams. Decoding
  // the topology snaps every coordinate to the same ~0.4 m grid the browser will render,
  // so a shared edge becomes bit-identical on both sides and the union succeeds. It also
  // means block outlines line up exactly with the parcel outlines they replace at the LOD
  // swap. feature() preserves the input feature order, so index i still addresses the same
  // parcel in attrs.* — load-bearing for every attrs.grado[i] lookup inside aggregateGroups.
  const quantizedParcels = feature(parcelsTopo, parcelsTopo.objects.parcels).features;
  // Nothing reads the raw projected geometry after this point, and holding 208k parcels'
  // worth of it alongside both the topology and its decode is a few hundred MB against a
  // ~4 GB default heap. Dropping it here keeps the peak below where it was before the
  // reorder rather than above it.
  parcelFeatures.length = 0;
  const { blockFeatures, blockAttrs, unionFailures } = buildBlocks(quantizedParcels, attrs);
  stats.blocks = blockFeatures.length;
  stats.blockUnionFailures = unionFailures;

  // ---- Streets, citywide ------------------------------------------------------------------
  // v_sig_vias (not v_mdg_vias) because only it carries TIPO, which drives line weight.
  const vias = await readShapefileZip('v_sig_vias.zip');
  const viaFeatures = [];
  for (const f of vias.features) {
    if (!f.geometry) continue;
    const geom = projectGeometry(f.geometry);
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
  stats.streets = viaFeatures.length;
  stats.streetTypes = [...new Set(viaFeatures.map((f) => f.properties.tipo))].filter(Boolean);

  // ---- Emit ----------------------------------------------------------------------
  // parcelsTopo is already built above — the blocks are derived from its quantized output.
  const viasTopo = topology(
    {
      vias: { type: 'FeatureCollection', features: viaFeatures },
      ambito: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: ambito, properties: {} }] },
    },
    QUANTIZATION,
  );
  const blocksTopoRaw = topology(
    { blocks: { type: 'FeatureCollection', features: blockFeatures } },
    QUANTIZATION,
  );
  // Blocks are only ever shown at k < BLOCK_LOD_MAX_K (src/main.js), where the viewport
  // spans roughly Centro's original ~3.3 km extent over a canvas a few hundred px wide —
  // on the order of 10 m/pixel. minWeight=100 (~10m x 10m) discards vertices whose
  // removal would distort the outline by less than about a pixel at that scale.
  // presimplify() decodes the quantized arcs to absolute coordinates to compute correct
  // simplification weights, and its output (like simplify()'s) has no `transform` — so
  // without re-quantizing, the emitted arcs would be full-precision floats instead of the
  // compact deltas every other file uses, growing the payload instead of shrinking it.
  const blocksTopo = quantize(simplify(presimplify(blocksTopoRaw), 100), QUANTIZATION);

  const gradeCounts = {};
  for (const g of attrs.grado) gradeCounts[g] = (gradeCounts[g] || 0) + 1;

  const meta = {
    generated: new Date().toISOString(),
    bbox: dataBbox,
    counts: { parcels: stats.parcels, streets: stats.streets, blocks: stats.blocks },
    // How many blocks fell back to keeping their members' own geometry because the union
    // failed. Persisted rather than only logged so a regression in the merge (the shape
    // that already cost one rebuild — see the quantization note above) is testable and
    // trackable across builds instead of visible only in a build log nobody kept.
    blockUnionFailures: stats.blockUnionFailures,
    gradeCounts,
    gradeOrder: GRADE_ORDER,
    coverage: {
      // Surfaced in the UI so the atlas states its own limits rather than implying
      // complete data. Citywide now, so these read lower than the Centro-only figures did —
      // that is real signal (permits/addresses are far sparser outside Centro), not a bug.
      permitPct: +((100 * stats.parcelsWithPermits) / stats.parcels).toFixed(1),
      addressPct: +((100 * stats.parcelsWithAddress) / stats.parcels).toFixed(1),
      heritageDetailPct: +((100 * stats.parcelsWithHeritageDetail) / stats.parcels).toFixed(1),
      alturaEspecial: attrs.altura.filter((a) => a === null).length,
      centroParcels: stats.centroParcels,
      centroAlturaEspecial: stats.centroAlturaEspecial,
    },
  };

  await writeFile(join(DATA_DIR, 'centro.topo.json'), JSON.stringify(parcelsTopo));
  await writeFile(join(DATA_DIR, 'vias.topo.json'), JSON.stringify(viasTopo));
  await writeFile(join(DATA_DIR, 'blocks.topo.json'), JSON.stringify(blocksTopo));
  await writeFile(join(DATA_DIR, 'attrs.json'), JSON.stringify({ meta, attrs, blockAttrs }));

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
