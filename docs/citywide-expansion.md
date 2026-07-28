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
  confirm CDN gzip on the larger JSON payloads; decide whether `FOS`/`RETIRO`/`barrio` (parsed and
  stored but not yet visualized) get their own map attribute.
