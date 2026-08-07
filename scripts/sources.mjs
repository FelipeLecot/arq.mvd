// The five verified IM sources for the Centro atlas.
//
// Two access routes are live (checked 2026-07-24):
//   - CKAN / datos-abiertos: plain HTTPS GET.
//   - The SHP generator at intgis: TWO-STEP. First GET generar_zip2.php?nom_tab=X&tipo=gis
//     to make the server build the zip, then GET /sit/tmp/X.zip to collect it.
//
// The GeoServer WFS at geoweb.montevideo.gub.uy is down (TLS connects, then empty reply,
// for every protocol/version combination) so it is not used here.

export const SHP_GEN = 'https://intgis.montevideo.gub.uy/sit/php/common/datos/generar_zip2.php';
export const SHP_TMP = 'https://intgis.montevideo.gub.uy/sit/tmp';

// A separate, live GeoServer WFS instance (confirmed 2026-07-28; do not confuse with the dead
// geoweb.montevideo.gub.uy host). Single-GET GeoJSON, no shapefile/latin1 step.
export const WFS_BASE = 'https://geoserver.montevideo.gub.uy/geoserver/ows';

const CKAN_INV = 'https://ckan-data.montevideo.gub.uy/dataset/e8cbc599-210d-47fa-810d-f6e61ef4ee2d';

export const SOURCES = [
  {
    id: 'inventario',
    kind: 'direct',
    file: 'inventario_patrimonial_centro.geojson',
    url: `${CKAN_INV}/resource/9e84d95f-2258-48cc-9a61-521f2785edbf/download/inventario_patrimonial_centro.geojson`,
    note: '9016 features, EPSG:32721 — padron_sector, grado_proteccion, altura. The core layer.',
  },
  {
    id: 'ambito',
    kind: 'direct',
    file: 'ambito_inventario_patrimonial_centro.geojson',
    url: `${CKAN_INV}/resource/ee0a707f-2be7-434a-a988-93b50e9f3cd3/download/ambito_inventario_patrimonial_centro.geojson`,
    note: '1 MultiPolygon — the Centro boundary, used to clip streets and addresses.',
  },
  {
    id: 'permisos',
    kind: 'direct',
    file: 'permisos_construccion.zip',
    url: 'https://datos-abiertos.montevideo.gub.uy/permisos_construccion.zip',
    note: '42141 rows, 1997-2026, semicolon-separated latin1 CSV.',
  },
  {
    // v_sig_vias, NOT v_mdg_vias — only v_sig carries the TIPO field used for street weighting.
    id: 'vias',
    kind: 'shpgen',
    table: 'v_sig_vias',
    note: '33427 segments — NOM_CALLE, TIPO (SENDA/CALLE/...), COD_NOMBRE.',
  },
  {
    id: 'accesos',
    kind: 'shpgen',
    table: 'v_mdg_accesos',
    note: 'Official address points — calle, nro. de puerta, padron.',
  },
  {
    // Discovered 2026-07-28: an unprobed table on the same working SHP generator, never
    // checked by the original research. Citywide, 208,556 parcels, with real POT fields —
    // ALTURA/FOS/RETIRO at 97.2% coverage — that the original research concluded did not
    // exist anywhere in CKAN or the SHP generator. AREA_DIFER also carries a ready-made
    // zone/barrio label ("Pocitos", "Ciudad Vieja", "Centro", ...) on every parcel.
    id: 'parcelasPot',
    kind: 'shpgen',
    table: 'v_mdg_parcelas',
    note: '208556 parcels citywide — ALTURA, FOS, FIS, RETIRO, AREA_DIFER (legal height envelope + zone name).',
  },
  {
    // Citywide declared-heritage points/polygons (Monumento Histórico Nacional / Bien de
    // Interés Departamental or Municipal). Sparse (1195 records) but rich where present:
    // architect and construction date, which the Centro inventory itself does not carry.
    id: 'bienesPatrimoniales',
    kind: 'shpgen',
    table: 'v_pat_mhn_bienespatrimoniales',
    note: '1195 citywide declared heritage records — AUTORIA, FECHA, DECLARATOR, DIRECCION.',
  },
  {
    // Ciudad Vieja's own per-building heritage survey — richer than Centro's inventory (three
    // grade snapshots, conservation state, era, floor-by-floor use). Confirmed live 2026-08-07:
    // 1891 records, EPSG:32721. Disjoint from Centro's inventory (only 2 of 1891 records fall
    // inside its ámbito) — see docs/superpowers/specs/2026-08-07-heritage-data-expansion-design.md.
    id: 'ciudadViejaPatrimonio',
    kind: 'wfs',
    typeName: 'imm:pm_bienes_patrimoniales',
    file: 'pm_bienes_patrimoniales.json',
    note: '1891 records, EPSG:32721 — grado_prot_1983/2000/2010, estado_cons, epoca, uso codes.',
  },
];
