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
];
