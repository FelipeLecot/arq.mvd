# Data sources

Every source this atlas draws from, where it lives, how it's fetched, and what it's good for.
Sources actually wired into `scripts/sources.mjs` are marked **in use**; the rest were found
during the 2026-07-28 citywide research pass and are candidates for a future phase — see
`citywide-expansion.md` for the rollout plan.

## Access routes

Three ways IM publishes geodata; only two are reliable.

- **CKAN** (`ckan-data.montevideo.gub.uy`, catalog browsable at `catalogodatos.gub.uy`) — plain
  HTTPS GET on a resource URL. Works. The CKAN API (`/api/3/action/package_search`,
  `/api/3/action/package_show`) is the fastest way to search the catalog programmatically —
  faster and more complete than reading the HTML catalog pages, which get summarized/truncated by
  generic page-fetch tools.
- **SHP generator** (`intgis.montevideo.gub.uy`) — works, and is **two-step**: `GET
  generar_zip2.php?nom_tab=<table>&tipo=gis` asks the server to build the zip (returns an HTML
  shim, not data), then `GET /sit/tmp/<table>.zip` collects it. An unknown table name returns a
  small HTML 404 rather than erroring, so it's safely probeable — try a table name, check the
  response starts with a zip magic number (`PK`). This is how every `kind: 'shpgen'` entry in
  `scripts/sources.mjs` is fetched (see `scripts/fetch.mjs`).
- **GeoServer WFS at `geoweb.montevideo.gub.uy`** — dead. TLS connects, then an empty reply, for
  every WFS version/protocol combination tried. Do not confuse this with the *different*, live
  GeoServer below.
- **GeoServer WFS at `geoserver.montevideo.gub.uy`** — a **separate, live** instance, not found by
  the original research (which only tried the dead `geoweb` host). Discovered by reading the JS
  behind `inventariociudadvieja.montevideo.gub.uy`'s map
  (`sites/all/libraries/mapacv/MapaDistribucion.js` references it directly). Returns GeoJSON
  straight from `GetFeature&outputFormat=application/json` — no shapefile/latin1 parsing needed —
  and supports `CQL_FILTER`/`BBOX` for server-side filtering. 298 feature types across 9
  workspaces (`imm`, `geomatica`, `ivial`, ...); `GetCapabilities` at
  `https://geoserver.montevideo.gub.uy/geoserver/ows?service=wfs&version=2.0.0&request=GetCapabilities`
  lists all of them. **Not yet wired into `scripts/fetch.mjs`** — it needs a new source `kind`
  (single GET, not the SHP generator's two-step dance).

## In use

| id (`sources.mjs`) | Table/resource | Coverage | Key fields | Notes |
|---|---|---|---|---|
| `inventario` | `inventario_patrimonial_centro.geojson` (CKAN) | Centro, 9,016 parcels | `padron_sector`, `grado_proteccion`, `altura` | The core Centro layer. `altura` is a string; 92 parcels read "Altura especial". `grado_proteccion` is a full sentence, parsed by `parseGrado`. |
| `ambito` | `ambito_inventario_patrimonial_centro.geojson` (CKAN) | Centro boundary, 1 MultiPolygon | — | Still used to fit the initial view (`createProjection`). No longer used to clip other sources (removed in the citywide expansion). |
| `permisos` | `permisos_construccion.zip` (CKAN, direct) | Citywide, 42,141 rows, 1997–2026 | `padron`, `destino`, `area`, `anio`, `tipo_obra` | Semicolon-separated, latin1 CSV. Measures permit *activity* since 1997, not construction date — no era source exists in open data. |
| `vias` | `v_sig_vias` (SHP gen) | Citywide, 33,427 segments | `NOM_CALLE`, `TIPO`, `COD_NOMBRE` | Use `v_sig_vias`, not `v_mdg_vias` — only this one carries `TIPO`, which drives street line weight. |
| `accesos` | `v_mdg_accesos` (SHP gen) | Citywide, 200k+ points | `CALLE`/`NOM_CALLE`, `PUERTA`/`NRO_PUERTA`, `PADRON` | Official address points, joined by padrón. |
| `parcelasPot` | `v_mdg_parcelas` (SHP gen) | Citywide, 208,556 parcels | `PADRON`, `ALTURA`, `FOS`, `FIS`, `RETIRO`, `AREA_DIFER`, `RGS`, `GALIBO`, `USOPRE`, `CATEGORIA` | **The citywide legal-height (POT) layer.** Never probed by the original research, which concluded no such table existed. `ALTURA`/`FOS`/`RETIRO` are ~97% non-null, but a large minority of those are special-regime string codes (`ALT.ESP.`, `9-12`, `CEP`, `PAU9`, ...), not numbers — `parsePotNumeric` in `scripts/normalize.mjs` handles this the same way `parseAltura` handles Centro's "Altura especial". A genuine `"0"` also occurs (aerodromo/zona-franca service land with no building envelope at all) and is a real zero, not a parsing bug. `AREA_DIFER` labels every parcel with a named planning zone (`"Pocitos"`, `"Ciudad Vieja"`, `"Centro"`, `"Carrasco"`, ... — about 40 values) that doubles as a barrio filter; it's a POT zoning partition, not Montevideo's informal barrio map, so it sometimes merges several barrios into one zone. |
| `bienesPatrimoniales` | `v_pat_mhn_bienespatrimoniales` (SHP gen) | Citywide, 1,195 records (1,107 after dedup by padrón) | `PADRON`, `AUTORIA`, `FECHA`, `DECLARATOR`, `IDENTIFICA`, `DIRECCION` | Declared heritage landmarks (Monumento Histórico Nacional / Bien de Interés Departamental or Municipal). Sparse — flags specific declared properties, not full per-parcel coverage — but carries an **architect** (41% of records) and **construction date** (91%), which no other source in this pipeline has. A companion points-only layer, `v_pat_mhn_puntos`, exists but isn't fetched. |

## Found, not yet wired in (candidates for a future phase)

| Layer | Where | Coverage | What it has | Why it matters |
|---|---|---|---|---|
| `imm:pm_bienes_patrimoniales` | WFS (`geoserver.montevideo.gub.uy`) | Ciudad Vieja, 1,891 records | `nro_padron`, `denom_ori`/`denom_act` (building name), **`grado_prot_1983`/`_2000`/`_2010`** (three survey years), `prot_legal`, `estado_cons_ext`/`_int`, floor-by-floor use codes, `epoca_ori` | The live backing data for `inventariociudadvieja.montevideo.gub.uy` — a per-building heritage survey richer than Centro's own (three grade snapshots, conservation state, era, detailed uses). Fields are numeric codes with **no legend fetched yet** — find one on that site's "Criterios de valoración" page before rendering these as labels. |
| `imm:pm_espacios_libres_patrimoniales` | WFS | Ciudad Vieja | Patrimonial open spaces (plazas) | Companion to the above; not yet inspected in depth. |
| `imm:v_pm_tramos_vias_patrimoniales` | WFS | Ciudad Vieja | Patrimonial street segments | Street-level heritage context; not yet inspected. |
| `imm:uptu_patrimonio` | WFS | Citywide, 634 records | `padron`, `resolucion`, `identificacion`, `direccion`, readable `proteccion` label (e.g. "Monum. Histórico") | A citywide declared-landmark layer, likely overlapping `bienesPatrimoniales` above (both are "declared landmark" layers from different systems) — reconcile which is more complete, or merge both, before wiring in. |
| `imm:mdg_parcelas` | WFS | Citywide, 208,556 parcels | `padron` + audit metadata only | The WFS's version of bare parcel geometry (no POT fields) — same shape as the CKAN `parcelas-catastrales` dataset. Not needed while `v_mdg_parcelas` (which has the POT fields) covers geometry too. |

## Confirmed gaps

No bulk per-building heritage-grade dataset exists for Pocitos, Carrasco, Punta Gorda, Prado,
Peñarol, Reus Norte, or Colón — IM's own patrimonio page describes their protection as
neighborhood-level, not individually surveyed in open data (unlike Ciudad Vieja and Centro). Only
the two sparse citywide "declared landmark" layers above apply there. No official "barrios"
boundary dataset exists either (checked the full IM package list — only Municipios and Centros
Comunales Zonales, both administrative subdivisions, not the informal barrio map); `AREA_DIFER` on
`v_mdg_parcelas` is the best available proxy.
