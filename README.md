# Atlas del Centro

A client-side architectural atlas of central Montevideo, drawn entirely from Intendencia
de Montevideo vector data. 9,016 parcels of the Inventario Patrimonial del Centro,
coloured by heritage protection grade, legal height envelope, or building-permit activity,
extruded in fake-3D on Canvas 2D. No basemap tiles, no mapping library — the city is drawn
from IM's own geometry.

## Quick start

```bash
npm install
npm run fetch        # download the five sources into data/raw/ (cached)
npm run build:data   # reproject, join, emit TopoJSON + attribute columns
npm run dev          # http://localhost:5173
```

`npm test` runs the pipeline guards.

## Controls

| Action | Control |
|---|---|
| Rotate the plan | Left-drag |
| Pan | Space + drag, or middle-button drag |
| Zoom | Wheel |
| Back to north | `R` |
| Inspect a parcel | Hover |

Buildings always rise toward the top of the screen, however the plan is turned — the
extrusion offset stays in screen space while the footprints rotate beneath it. Depth
ordering is rebuilt when the view turns, since "back" stops meaning "north".

## Every parcel has data

No parcel in the atlas is missing its attributes — `padron`, `grado` and `altura` are
100% populated, and only 44 of 9,016 lack a street address. What can *look* empty is
real information:

- **Régimen General — 3,875 parcels (43%).** Inside the inventory but not assigned a
  heritage grade; general zoning applies. A real regime, not a gap.
- **Sin Catalogar — 60 parcels (0.7%).** Surveyed, no grade assigned.
- **Sin permisos — 7,122 parcels (79%)** in the Obras view. A true zero: no approved
  permit since 1997.
- **Altura especial — 92 parcels.** A non-numeric height regime, so these never extrude
  and carry their own off-ramp colour rather than a height.

The ungraded neutrals are drawn recessive so the graded ramp carries the eye, but they
clear a 2:1 contrast floor against the ground. An earlier build had Régimen General at
1.58:1, which read as missing data for 43% of the map — that was a bug, not a design.

## What this covers — and what it doesn't

**This is Centro, not Montevideo.** About 4% of the city's parcels.

That is a data constraint, not a design choice. The original intent was a citywide atlas
extruded by POT regulatory height, but the POT attribute layer is not published:

- `parcelas-catastrales` is 208,556 polygons carrying exactly two fields, `GID` and
  `PADRON`. CKAN's own description: *"único dato: número de padrón"*.
- No FOS, no FIS, no retiros, and no citywide `altura` exist anywhere in CKAN's 155
  packages or under any probed table name on the SHP generator.
- `construcciones notables` is 140 records — named landmarks, not a footprint layer.
- `pat_especial_consideracion` carries only audit metadata (FCREA/UCREA), no protection
  attributes.

The Inventario Patrimonial del Centro (decreto 39.085) is the one published layer with
real architectural attributes at 100% coverage, so the atlas is scoped to it.

Within Centro:

| Attribute | Coverage | Source |
|---|---|---|
| Grado de protección | 100% | Inventario Patrimonial |
| Altura normativa | 100% (92 are "Altura especial", non-numeric) | Inventario Patrimonial |
| Dirección | 99.5% | `v_mdg_accesos`, joined by padrón |
| Obras (permits) | 21% | `permisos_construccion`, joined by padrón |

**Height is the legal maximum, not what was built.** Uruguay does not publish per-building
measured heights. The extrusion is the permitted envelope — the legal city, not the real
one. The UI states this wherever height appears.

**Permits are not an era field.** They start in 1997 and reach 21% of Centro padrones, so
they measure recent churn. No construction-date source exists in the open data, so
"colour by era" is not possible at all.

## Data sources

Two of the three documented access routes are live (checked 2026-07-24):

- **CKAN** (`ckan.montevideo.gub.uy`) — plain GET. Works.
- **SHP generator** (`intgis.montevideo.gub.uy`) — works, and is **two-step**:
  `GET generar_zip2.php?nom_tab=X&tipo=gis` to build the zip, then `GET /sit/tmp/X.zip`
  to collect it. Unknown table names return a small HTML 404, so it is safely probeable.
- **GeoServer WFS** (`geoweb.montevideo.gub.uy`) — **down**. TLS connects, then the server
  returns an empty reply, for WFS 1.1.0 and 2.0.0, forced HTTP/1.1, forced TLS 1.2; port 80
  redirects back to the dead HTTPS endpoint. Not used.

Because `intgis` is the only working bulk route, `fetch.mjs` caches every download to
`data/raw/` and the build never touches the network.

Use `v_sig_vias`, not `v_mdg_vias` — only the former carries the `TIPO` field that drives
street line weight.

## Architecture

```
scripts/fetch.mjs      download + cache the five sources
scripts/build.mjs      reproject 32721 -> 3857, clip, join permits, emit
scripts/normalize.mjs  attribute cleaning rules (unit-tested)
src/render/            canvas layers: parcels/extrusion, streets, labels
src/picking.js         RGB-id picking canvas for O(1) hit-testing
src/histogram.js       brushed distribution, linked to the map
```

Geometry is pre-projected to EPSG:3857 at build time, so the browser uses
`d3.geoIdentity()` with no runtime reprojection. Attributes live in a separate file from
geometry, so restyling never re-parses topology.

### Data cleaning that matters

- `padron_sector` is `"432381 A"` — the sector suffix is stripped before joining.
- `altura` is a **string**, and 92 parcels read `"Altura especial"`. These become `null`,
  never `0` — coercing them would silently flatten 92 buildings and drag the colour ramp.
- `grado_proteccion` values are full sentences; they parse to `G0`–`G4`/`RG`/`SC` for
  rendering, with the prose kept for the hover card.

### Performance

Measured at 1440×900, all 9,016 parcels:

| | median redraw |
|---|---|
| During pan/zoom (flat) | ~19 ms |
| Settled, extruded, full city | ~132 ms |
| Extruded, zoomed in (culled) | ~4 ms |

Extrusion of the whole city costs more than a frame, so an active gesture draws the flat
map and the volume returns when the gesture settles.

The picking buffer is **not** drawn on the render path. It is rebuilt lazily, on the first
pointer move after the view changes, so its cost lands only when someone actually points
at something rather than on every repaint.

## Colour

Three single-hue ramps, each validated for monotone lightness, adjacent-step separation,
and contrast against the `#0E1219` ground. The grade ramp runs dim umber to bright gold —
the register's own ranking of architectural value made literal, so the 57 Grado 4 buildings
glow against a recessive mass of un-catalogued stock. Régimen General and Sin Catalogar sit
deliberately off the ramp in neutral slate: they are not a low grade, they are unassessed.
