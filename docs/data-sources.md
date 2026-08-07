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
  lists all of them. **Wired into `scripts/fetch.mjs`** via a new `kind: 'wfs'` source (Task 1;
  single GET, not the SHP generator's two-step dance) — see the `ciudadViejaPatrimonio`/
  `imm:pm_bienes_patrimoniales` row below for the in-use example.

## In use

| id (`sources.mjs`) | Table/resource | Coverage | Key fields | Notes |
|---|---|---|---|---|
| `inventario` | `inventario_patrimonial_centro.geojson` (CKAN) | Centro, 9,016 parcels | `padron_sector`, `grado_proteccion`, `altura` | The core Centro layer. `altura` is a string; 92 parcels read "Altura especial". `grado_proteccion` is a full sentence, parsed by `parseGrado`. |
| `ambito` | `ambito_inventario_patrimonial_centro.geojson` (CKAN) | Centro boundary, 1 MultiPolygon | — | Still used to fit the initial view (`createProjection`). No longer used to clip other sources (removed in the citywide expansion). |
| `permisos` | `permisos_construccion.zip` (CKAN, direct) | Citywide, 42,141 rows, 1997–2026 | `padron`, `destino`, `area`, `anio`, `tipo_obra` | Semicolon-separated, latin1 CSV. Measures permit *activity* since 1997, not construction date — no era source exists in open data. |
| `vias` | `v_sig_vias` (SHP gen) | Citywide, 33,427 segments | `NOM_CALLE`, `TIPO`, `COD_NOMBRE` | Use `v_sig_vias`, not `v_mdg_vias` — only this one carries `TIPO`, which drives street line weight. |
| `accesos` | `v_mdg_accesos` (SHP gen) | Citywide, 200k+ points | `NOM_CALLE`, `NUM_PUERTA` (+ `CALLE`/`PUERTA`/`NRO_PUERTA`/`NRO` legacy fallbacks that never match — the raw DBF only carries `GID`, `PADRON`, `COD_NOMBRE`, `NOM_CALLE`, `NUM_PUERTA`, `LETRA`, `PARIDAD`), `PADRON` | Official address points, joined by padrón. `NOM_CALLE` and `NUM_PUERTA` are the only real street-name/door-number fields on this table; `CALLE` (checked into the street-name fallback chain) doesn't exist on `v_mdg_accesos` at all, and `PUERTA`/`NRO_PUERTA`/`NRO` (the door-number fallbacks) never matched anything either (pre-existing bug fixed Task 7) — all four are dead fallbacks kept harmless by `??` chaining, not real fields. |
| `parcelasPot` | `v_mdg_parcelas` (SHP gen) | Citywide, 208,556 parcels | `PADRON`, `ALTURA`, `FOS`, `FIS`, `RETIRO`, `AREA_DIFER`, `RGS`, `GALIBO`, `USOPRE`, `CATEGORIA` (plus `AREATOT`, `AREACAT`, `PH`, `CARPETA_PH`, `SUB_CATEGO`, `PLANESP`, `PLANPARCIA`, `PROMO`, `NOM_TRANS`, `TIPO_TRANS`, `ESTADO_TRA`, `RN_AREA_DI`) | **The citywide legal-height (POT) layer.** Never probed by the original research, which concluded no such table existed. `ALTURA`/`FOS`/`RETIRO` are ~97% non-null on the raw table, but a large minority of those are special-regime string codes (`ALT.ESP.`, `9-12`, `CEP`, `PAU9`, ...), not numbers. Now reads `ALTURA`, `AREA_DIFER`, and dozens of additional planning/zoning fields off the raw DBF (`AREATOT`, `AREACAT`, `PH`, `CARPETA_PH`, `CATEGORIA`, `SUB_CATEGO`, `RGS`, `USOPRE`, `RETIRO`, `FOS`, `FIS`, `GALIBO`, `PLANESP`, `PLANPARCIA`, `PROMO`, `NOM_TRANS`/`TIPO_TRANS`/`ESTADO_TRA`, `RN_AREA_DI`) — stored in `attrs.json` as camelCase (`areaTotal`, `areaCatastral`, `categoriaZona`, `subCategoriaZona`, `usoPredominante`, `planEspecial`, `planParcial`, `promocion`, `transicionNombre`/`transicionTipo`/`transicionEstado`, `rnAreaDiferenciada`, ...) for UI consumption. `ALTURA` is parsed through `parsePotNumeric` in `scripts/normalize.mjs`, the same never-coerce-to-0 discipline `parseAltura` applies to Centro's "Altura especial"; a genuine `"0"` also occurs (aerodromo/zona-franca service land with no building envelope at all) and is a real zero, not a parsing bug. `AREA_DIFER` labels every parcel with a named planning zone (`"Pocitos"`, `"Ciudad Vieja"`, `"Centro"`, `"Carrasco"`, ... — about 40 values) that doubles as a barrio filter; it's a POT zoning partition, not Montevideo's informal barrio map, so it sometimes merges several barrios into one zone. It's already parsed and stored as `attrs.barrio`. |
| `bienesPatrimoniales` | `v_pat_mhn_bienespatrimoniales` (SHP gen) | Citywide, 1,195 records (1,107 after dedup by padrón) | `PADRON`, `AUTORIA`, `FECHA`, `DECLARATOR`, `IDENTIFICA`, `DIRECCION`, `DECRETO`, `MHN`, `NRO_ESPACI` | Declared heritage landmarks (Monumento Histórico Nacional / Bien de Interés Departamental or Municipal). Sparse — flags specific declared properties, not full per-parcel coverage — but carries an **architect** (41% of records) and **construction date** (91%), which no other source in this pipeline has. Now reads `MHN` (landmark category/protection type), `DECRETO` (declaring decree), and `NRO_ESPACI` (landmark identifier). A companion points-only layer, `v_pat_mhn_puntos`, exists but isn't fetched. |
| `ciudadViejaPatrimonio` | `imm:pm_bienes_patrimoniales` (WFS, `geoserver.montevideo.gub.uy`) | Ciudad Vieja, 1,891 records (1,835 distinct padrones) | `nro_padron`, `grado_prot_1983`/`_2000`/`_2010`, `estado_cons_ext`/`_int`, `epoca_ori`, `categoria`, `tipo_prop`, `reg_prop`, `uso_global_ori`/`_act`, `uso_ori_*`/`uso_act_*` (8 floor-level fields), `intervenciones_*` (4 fields), `denom_ori`/`_act` | The live backing data for `inventariociudadvieja.montevideo.gub.uy` — a per-building heritage survey richer than Centro's own (three grade snapshots, conservation state, era, detailed uses). Only `grado_prot_2010` is merged into the shared `grado` field, via `parseCvGrado` (same 0-4 scale as Centro, confirmed against IM's own legend); `grado_prot_1983`/`grado_prot_2000` ship raw, separate, and unmerged as `attrs.cvGrado1983`/`attrs.cvGrado2000` — never a fallback into `grado`. `attrs.gradoSource` records which *survey* graded a parcel (`'centro' | 'ciudad-vieja' | null`), not which year. Only 2 of 1,891 records fall inside Centro's ámbito, both already covered by Centro's own grade. Every other field ships raw (`cv`-prefixed in `attrs.json`) — no legend found for `estado_cons`/`epoca`/`categoria`/`tipo_prop`/`reg_prop`/`uso_*` despite checking IM's Ciudad Vieja portal. |

## Found, not yet wired in (candidates for a future phase)

| Layer | Where | Coverage | What it has | Why it matters |
|---|---|---|---|---|
| `imm:pm_espacios_libres_patrimoniales` | WFS | Ciudad Vieja | Patrimonial open spaces (plazas) | Patrimonial open spaces. Not yet inspected in depth. |
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
