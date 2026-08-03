# Atlas de Montevideo

A client-side architectural atlas of Montevideo, drawn entirely from Intendencia de Montevideo
(IM) open data using no basemap tiles and no mapping library. Parcels, streets and labels render on
Canvas 2D with a fake-3D extrusion **by legal building height**.

The objective of this project is to give insight into the maintenance and restoration needs of
Montevideo's protected architectural heritag, which buildings are catalogued and at what
protection grade, what their legal height/setback envelope is, and (where the open data allows)
how much building-permit activity has touched that protected stock since 1997. Grade, height and
permits are the same three lenses the UI lets you switch between.

## Quick start

```bash
npm install
npm run fetch        # download the seven sources into data/raw/ (cached; --force to refresh)
npm run build:data   # reproject, join, normalize -> data/*.json
npm run dev          # http://localhost:5173
```

`npm test` runs the pipeline guards.

## Controls

Drag to pan, wheel to zoom, hover to inspect a parcel. North is always up. Below a zoom threshold
the map draws merged city blocks instead of individual parcels (I had troble rendering all at once) legible and cheap at a scale
where a single lot line stops meaning anything.

## Coverage: two tiers, for one reason

The atlas covers all 208,862 cadastral parcels in Montevideo, but only 9,016 of them — Centro —
carry a real heritage protection grade. That split isn't a design choice; it's the shape of the
data IM actually publishes:

- **Centro** has the *Inventario Patrimonial del Centro* (decreto 39.085): a real, per-building
  heritage survey at 100% coverage, grading every parcel `G0`–`G4` (or marking it Régimen General /
  Sin Catalogar). This is the one dataset in IM's entire catalog with individually-assessed
  protection grades.
- **Everywhere else**, the citywide parcel layer (`v_mdg_parcelas`, the POT — Plan de Ordenamiento
  Territorial — table) carries a legal height/FOS/setback envelope for all 208,556 of its parcels,
  but it has no protection-grade field at all, because no such survey exists for it to carry. IM's
  own patrimonio documentation describes heritage protection outside Centro and Ciudad Vieja as a
  neighborhood-level policy, not an individually-surveyed inventory — there is nothing to join.
- A separate, sparse citywide layer of **declared landmarks**
  (`v_pat_mhn_bienespatrimoniales` — Monumento Histórico Nacional / Bien de Interés Departamental
  or Municipal) flags 1,195 specific properties citywide, of which 473 match a parcel outside
  Centro. That's a landmark flag, not a grade — it says "this one building is declared," not
  "here is this neighborhood's protection level."
- Ciudad Vieja has its *own* richer per-building survey (three historical grade snapshots,
  conservation state, era) sitting on a live GeoServer WFS the pipeline hasn't wired in yet — see
  `docs/data-sources.md` and the roadmap in `docs/citywide-expansion.md`.
- Confirmed gap: Pocitos, Carrasco, Punta Gorda, Prado, Peñarol, Reus Norte and Colón have no
  bulk per-building heritage survey in open data at all, checked against IM's full CKAN package
  list and every probed SHP-generator table name.

So every parcel in the atlas has a `grado` value, but it's categorical, not a scale that degrades
gracefully outside Centro: `G0`–`G4` (Centro's heritage grades), `RG` (Régimen General are inside
Centro's inventory, not individually graded), `SC` (Sin Catalogar are surveyed, no grade assigned),
or `NA` (outside any heritage inventory, a citywide POT-only parcel, 199,846 of them). `NA` is
deliberately its own code rather than folded into `SC`: "never surveyed" and "surveyed, ungraded"
are different facts, and a recessive color still has to mean something specific.

**Height is the legal maximum, not what was built.** Uruguay does not publish per-building
measured heights, in Centro or citywide. The extrusion is the permitted envelope and the UI states this wherever height appears.

## Data sources

Every source wired into the build, what it covers, and what it's good for:

| Source | Table / resource | Coverage | Key fields | What it's for |
|---|---|---|---|---|
| Inventario Patrimonial | `inventario_patrimonial_centro.geojson` (CKAN) | Centro, 9,016 parcels, 100% | `padron_sector`, `grado_proteccion`, `altura` | The only per-building heritage-grade survey in the catalog. Centro's curated geometry and grade always win over the POT layer below for the same padrón. |
| Ámbito | `ambito_inventario_patrimonial_centro.geojson` (CKAN) | Centro boundary, 1 polygon | — | Fits the initial view; no longer used to clip other sources. |
| Parcelas POT | `v_mdg_parcelas` (SHP generator) | Citywide, 208,556 parcels | `PADRON`, `ALTURA`, `FOS`, `FIS`, `RETIRO`, `AREA_DIFER` | Legal height/FOS/setback envelope for every parcel outside Centro. No protection grade — that field doesn't exist here. `AREA_DIFER` also doubles as a zone/barrio label. |
| Bienes patrimoniales | `v_pat_mhn_bienespatrimoniales` (SHP generator) | Citywide, 1,195 records (473 matched outside Centro) | `PADRON`, `AUTORIA`, `FECHA`, `DECLARATOR`, `DIRECCION` | Sparse declared-landmark flags — the only source with architect and construction date, wherever a parcel happens to be declared. |
| Permisos de obra | `permisos_construccion.zip` (CKAN) | Citywide, 42,141 rows, 1997–2026 | `padron`, `destino`, `area`, `anio`, `tipo_obra` | Building-permit activity, joined by padrón. Measures recent churn, not construction date — no era source exists in the open data. |
| Vías | `v_sig_vias` (SHP generator) | Citywide, 33,427 segments | `NOM_CALLE`, `TIPO`, `COD_NOMBRE` | Street geometry and line weight (`v_sig_vias`, not `v_mdg_vias` — only this one carries `TIPO`). |
| Accesos | `v_mdg_accesos` (SHP generator) | Citywide, 200k+ points | `CALLE`/`NOM_CALLE`, `PUERTA`/`NRO_PUERTA`, `PADRON` | Official address points, joined by padrón. |

Two of the three documented IM access routes are live (checked 2026-07-24):

- **CKAN** (`ckan-data.montevideo.gub.uy`) — plain GET. Works.
- **SHP generator** (`intgis.montevideo.gub.uy`) — works, and is **two-step**:
  `GET generar_zip2.php?nom_tab=X&tipo=gis` to build the zip, then `GET /sit/tmp/X.zip` to collect
  it. Unknown table names return a small HTML 404, so it is safely probeable.
- **GeoServer WFS** (`geoweb.montevideo.gub.uy`) — **down**. TLS connects, then the server returns
  an empty reply. Not used. (A separate, live GeoServer at `geoserver.montevideo.gub.uy` exists and
  is where the un-wired Ciudad Vieja survey lives — see `docs/data-sources.md`.)

Because the SHP generator is the only working bulk route for several sources, `fetch.mjs` caches
every download to `data/raw/` and the build never touches the network. Full detail on every source
— including ones found but not yet wired in, and why — lives in `docs/data-sources.md`; the
history of how the citywide expansion happened is in `docs/citywide-expansion.md`.

## Every parcel has data

No parcel in the atlas is missing its attributes. What can *look* empty is real information —
each off-ramp category is a distinct fact, not a gap:

- **NA — 199,846 parcels (96%).** Outside any heritage inventory: a citywide POT-only parcel.
- **Régimen General — 3,875 parcels (Centro).** Inside the Centro inventory but not assigned a
  heritage grade; general zoning applies.
- **Sin Catalogar — 60 parcels (Centro).** Surveyed, no grade assigned.
- **Sin permisos — the large majority of parcels** in the Obras view. Permit coverage is 10.6%
  citywide (was 21% when the atlas covered Centro alone) — a true zero for the rest: no approved
  permit since 1997, not a missing record.
- **Altura especial / non-numeric height codes — 49,573 parcels citywide.** A non-numeric height
  regime (Centro's 92 "Altura especial" parcels plus the POT layer's special-regime string codes
  like `ALT.ESP.`, `9-12`, `CEP`), so these never extrude and carry their own off-ramp colour
  rather than a height. A genuine POT `"0"` (aerodromo/zona-franca service land) is kept as a real
  zero, not folded into this bucket.

The ungraded neutrals are drawn recessive so the graded ramp carries the eye, but they clear a 2:1
contrast floor against the ground.

## Hit-testing

Picking uses a hidden canvas where each parcel is drawn in a unique RGB id colour, so a hover is
one pixel read regardless of feature count. Two things make that work here:

**It covers the whole silhouette, walls included.** Hit-testing only the roof of an extruded
parcel means a pointer on the side of a building selects whatever stands behind it — and the
taller the building, the wider the dead zone.

**Reads reject antialiased pixels.** Canvas antialiases every polygon edge, and an id colour is a
bit-packed integer, so a blended boundary pixel decodes to a *third* parcel unrelated to either
neighbour. `pick()` reads a small window and trusts the centre only when its colour repeats
nearby, otherwise taking the nearest colour that does.

The picking buffer is not part of the render path — it's rebuilt lazily on the first pointer move
after the view changes, so its cost lands only when someone actually points at something.

## Architecture

```
scripts/fetch.mjs      download + cache the seven sources
scripts/build.mjs      reproject 32721 -> 3857, clip, join permits/addresses/heritage flags, emit
scripts/normalize.mjs  attribute cleaning rules (unit-tested)
scripts/blocks.mjs     merge touching parcels into city blocks for the zoomed-out LOD
src/data.js            the only thing that fetches the emitted JSON/TopoJSON, in the browser
src/render/            canvas layers: parcels/extrusion, streets, labels
src/render/spatialIndex.js  rbush index bounding per-frame work to what's on screen
src/picking.js         RGB-id picking canvas for O(1) hit-testing
src/histogram.js       brushed distribution, linked to the map
```

Geometry is pre-projected to EPSG:3857 at build time, so the browser uses `d3.geoIdentity()` with
no runtime reprojection. Attributes live in a separate file from geometry, so switching the active
attribute or restyling never re-parses topology.

**Zoomed out, the map draws merged blocks instead of parcels.** There's no official manzana
dataset to join against, so `scripts/blocks.mjs` derives blocks from cadastral adjacency (parcels
within 0.5 m of each other are one group) and dissolves them with `polygon-clipping`, run against
already-quantized topology rather than raw floats — see `docs/citywide-expansion.md` for why that
distinction took a build from ~4.5 hours and 35% union failures to ~3 minutes and zero.

### Data cleaning that matters

- `padron_sector` is `"432381 A"` — the sector suffix is stripped before joining.
- `altura` (Centro) and `ALTURA` (POT) are **strings**, and a meaningful share of each read as a
  non-numeric special-regime code. These become `null`, never `0` — coercing them would silently
  flatten real "no numeric value" categories to the bottom of a colour ramp.
- `grado_proteccion` values are full sentences; they parse to `G0`–`G4`/`RG`/`SC` for rendering,
  with the prose kept for the hover card.

## Performance

Median redraw at 1440×900, measured on Centro's original 9,016-parcel dataset from a fixed view
(the citywide dataset now runs through the spatial index and block LOD described above; see
`docs/citywide-expansion.md` for how those keep per-frame work bounded at 208k
parcels):

| | median redraw |
|---|---|
| Extruded, full city (k=1) | ~200 ms |
| Flat, full city (k=1) — what a drag shows | ~26 ms |
| Extruded, zoomed in (culled) | ~5 ms |

Extrusion of the whole visible set costs well over a frame, so an active gesture draws the flat
map and the volume returns when the gesture settles.