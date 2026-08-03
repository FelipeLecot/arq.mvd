# Citywide expansion

Implemented 2026-07-28. This atlas originally covered only Centro (~4% of Montevideo, 9,016
parcels) because the original research concluded no citywide legal-height data existed in IM's
open data, and no per-building heritage data existed outside Centro. Re-checking by actually
downloading and inspecting data (not just descriptions) found both conclusions were wrong — see
`data-sources.md` for the sources themselves. This doc covers what changed and why.

## The two-tier coverage model

Centro keeps its own curated inventory (`inventario_patrimonial_centro.geojson`) as the
authoritative source wherever it applies: 100%-coverage heritage grade, curated geometry, all of
it unchanged from before this expansion. Every parcel outside Centro comes from a second,
independent source (`v_mdg_parcelas`) with a real legal-height/FOS/setback envelope but **no**
heritage grade — that survey simply doesn't exist for those parcels in open data.

This is why `grado` has a fourth "off-ramp" code, `NA` (`scripts/normalize.mjs`,
`src/scales.js`), alongside Centro's existing `RG` (Régimen General — inside the inventory, not
individually graded) and `SC` (Sin Catalogar — surveyed, no grade assigned). `NA` means something
different from both: *never surveyed at all*. Folding it into `SC` would have been a smaller diff
but a dishonest one — this project's own stated ethos (see the README's "Every parcel has data"
section) is that a recessive color must still mean something specific, not "missing data
papered over." Same reasoning applies to the `altura` field: some `v_mdg_parcelas` records
carry a genuine `"0"` (aerodromo/zona-franca service land with literally no building envelope),
which is a real value and must stay `0`, while special-regime string codes (`ALT.ESP.`, `9-12`,
`CEP`, ...) must stay `null` — same discipline as the pre-existing `parseAltura`, just applied to
a much larger, messier source table.

## What changed in the pipeline

`scripts/build.mjs` now builds parcels in two passes:

1. Centro's own inventory, exactly as before (curated geometry, real grade, `id`s `0..9015`).
2. Every `v_mdg_parcelas` feature whose padrón **isn't** already covered by pass 1 — Centro's
   curated version always wins over the generic POT geometry for the same building.

Both passes share the same enrichment joins: permits (by padrón, unchanged), addresses (by
padrón, no longer clipped to Centro's bounding box — see below), and the new sparse heritage-flag
join (architect/date/declaration from `v_pat_mhn_bienespatrimoniales`, by padrón, wherever a
parcel happens to be a declared landmark). A parcel also picks up `barrio` from `v_mdg_parcelas`'s
`AREA_DIFER`, including Centro parcels themselves (a free enrichment, since `v_mdg_parcelas`
covers Centro too even though its own grade/geometry isn't used there).

Streets, addresses and permits were previously clipped to Centro's ámbito boundary — a bounding
box + point-in-polygon filter — purely as a size optimization ("so we aren't carrying 200k+
citywide points through the join", per the original comment). Since the whole point now is
citywide coverage, that clip is gone; all three are indexed/included in full. The ámbito polygon
itself is still emitted (for the overlay outline and to fit the initial view)
but no longer filters anything.

## Measured results (this build)

```
Centro parcels:        9,016 (unchanged)
Citywide (NA) parcels: 199,846
Total parcels:         208,862
Streets:                33,407 (was ~905, Centro-clipped)
Addresses joined:       207,529
Heritage-flag matches:      473 parcels (architect/date/declaration)
Grade distribution:  G0 316, G1 1743, G2 2375, G3 590, G4 57, RG 3875, SC 60, NA 199,846
Coverage:  permits 10.6% (citywide; was 21% Centro-only), address 99.5%, heritage-detail 0.2%
Altura:    49,573 null citywide (special-regime codes + a few genuine "no envelope" zeros)
```

The permit/address coverage percentages in `meta.coverage` dropped from the old Centro-only
figures because they now average over a much larger, sparser population — that's a real
reflection of the data, not a regression. `tests/build-output.test.mjs` encodes these measured
figures the same way it encoded the original Centro-only ones; a large deviation on a future
rebuild means the upstream data moved or a normalization rule regressed.

Output file sizes roughly grew 10–20x (`data/attrs.json` ~22 MB, `data/centro.topo.json` ~38 MB,
`data/vias.topo.json` ~6 MB, uncompressed). Confirm the CDN gzips JSON before this ships — it
wasn't a concern worth solving in the pipeline itself since compression is a serving-layer
concern, not a data one.

## The merged block layer (added 2026-07-29, corrected 2026-08-02)

208,862 parcels is more than the zoomed-out view can usefully draw *or* usefully show, so
`scripts/blocks.mjs` merges touching parcels into city blocks for a second, coarser LOD.
No manzana dataset exists to join against (`data-sources.md`), so blocks are derived
from cadastral adjacency at a 0.5 m tolerance. Measured on the 2026-08-02 rebuild:

```
Blocks:                  8,360   (a 25x reduction from 208,862 parcels)
Multi-parcel groups:     7,797   single-parcel blocks: 563
Largest block:             491 parcels
Union failures:              0   (0.0% — blocks that fell back to unmerged member geometry)
Fully dissolved outlines: 8,274 of 8,360 (99.0%; the other 86 are genuinely disjoint groups)
```

**These numbers replace an earlier, much worse set**, and the difference is worth recording
because the cause was invisible in the output. `buildBlocks` originally ran against the parcel
geometry as projected — full-precision floats — where neighbouring parcels' shared edges disagree
by sub-tolerance amounts. `polygon-clipping.union` threw or degenerated on **2,942 of 8,360 blocks
(35.2%)**, and the safe fallback (keep every member's own geometry as a `MultiPolygon`) meant
nothing crashed and nothing rendered *wrong* — it just quietly shipped a "merged" layer in which
only 959 blocks (11%) were actually merged. Running the same union against the geometry
`topology()` has already snapped to the `QUANTIZATION = 1e5` grid (~0.44 m × 0.31 m citywide)
makes each shared edge bit-identical on both sides and takes the failure count to zero. Grouping
itself was unaffected — still exactly 8,360 blocks — because the grid is finer than the 0.5 m
adjacency tolerance.

The knock-on effects were much larger than the fix:

| | raw-float union | quantized union |
| --- | --- | --- |
| `blocks.topo.json`, unsimplified | 17,686,178 B | 4,494,603 B |
| `blocks.topo.json`, simplified + re-quantized (shipped) | 12,993,970 B | **1,391,507 B** |
| arc points, shipped | 707,553 | 75,202 |
| saving from the simplification pass alone | 26.5% | 69.0% |
| `npm run build:data`, wall clock | ~4.5 h | ~3 min |

The simplification pass (`presimplify` → `simplify(minWeight=100)` → `quantize`, in that order —
quantization must be last) saves far more now because it is finally simplifying
block outlines rather than thousands of internal parcel seams it can't remove. The build time is
the same story: the hours were `polygon-clipping` thrashing on degenerate near-coincident edges
before failing, not adjacency detection. `buildBlocks` over all 208,862 parcels now measures 40.5 s.

Two known, accepted properties of the shipped layer: six single-parcel blocks (30–175 m²
footprints) simplify away to zero area, which is `minWeight=100` behaving as specified for a layer
only ever drawn at ~10 m/pixel; and `blockAttrs.parcelIds` ships ~1.4 MB the client never reads,
kept deliberately so a block can be traced back to its members.

## Verified, live, in a browser

Screenshots and a Playwright pass (2026-07-28) confirmed: no console errors, the new `NA` parcels
render in their own recessive neutral color (not mistaken for `SC`), Centro's own rendering is
pixel-for-pixel the same as before, and the app is responsive panning into the newly-covered
areas. One thing this surfaced that's *not* fixed as part of this expansion: `src/main.js`'s
`scaleExtent([0.6, 60])` still caps how far the user can zoom out, and `createProjection()` still
fits the initial view to Centro's ámbito — so today there's no way to actually see the whole city
at once, only to pan into it. That's a front-end change, deliberately left out of this pass.

## Roadmap: not yet done

- **Ciudad Vieja deep enrichment.** `imm:pm_bienes_patrimoniales` on the live WFS (see
  `data-sources.md`) is a full per-building heritage survey for Ciudad Vieja, richer than Centro's
  own — three grade snapshots (1983/2000/2010), conservation state, era, floor-by-floor use codes.
  Not wired in yet: needs (a) a new WFS source `kind` in `sources.mjs`/`fetch.mjs` (a single
  `GetFeature&outputFormat=application/json` GET, much simpler than the SHP generator's two-step
  zip dance), and (b) a code legend for `grado_prot_*`/`uso_*`/`epoca_ori`/`categoria`/`tipo_prop`/
  `reg_prop`, which are numeric codes with no legend fetched yet.
- **Other barrios.** Pocitos, Carrasco, Punta Gorda, Prado, Peñarol, Reus Norte, Colón have no
  bulk per-building heritage survey in open data (confirmed gap, see `data-sources.md`) — they'll
  stay on the `NA`/legal-height treatment unless IM's Unidad de Protección del Patrimonio turns
  out to have an unpublished survey (worth asking directly; their neighborhood-level heritage
  designation implies *some* survey was done even if it never reached the open-data catalog).
  `AREA_DIFER` is ready to use as the barrio filter whenever a barrio-scoped view is needed.
- **Front-end**: loosen `scaleExtent`/the initial fit so a full-city view is actually reachable;
  confirm CDN gzip on the larger JSON payloads; decide whether `barrio` (parsed and stored as
  `attrs.barrio` but not yet visualized) gets its own map attribute. `FOS`/`FIS`/`RETIRO` exist on
  `v_mdg_parcelas` (see `data-sources.md`) but aren't parsed at all yet — `scripts/build.mjs` only
  reads `ALTURA` and `AREA_DIFER` off that source today.
