import { feature } from 'topojson-client';

/**
 * Geometry and attributes load from separate files so that changing the active
 * attribute never re-parses topology.
 *
 * Attributes themselves are split in two (see scripts/build.mjs): attrs.core.json
 * carries the columns rendering and search need before first paint, while
 * attrs.detail.json carries everything only the hover/click panel reads. The detail
 * file is fetched lazily via loadDetail() and its columns are merged into the same
 * `attrs` object, so consumers (hover.js reads columns defensively) see one object
 * that simply grows.
 */
export async function loadAtlas() {
  const [parcelsTopo, viasTopo, attrsDoc] = await Promise.all([
    fetch('/data/centro.topo.json').then((r) => r.json()),
    fetch('/data/vias.topo.json').then((r) => r.json()),
    fetch('/data/attrs.core.json').then((r) => r.json()),
  ]);

  const parcels = feature(parcelsTopo, parcelsTopo.objects.parcels);
  const vias = feature(viasTopo, viasTopo.objects.vias);
  const ambito = feature(viasTopo, viasTopo.objects.ambito);

  // Block GEOMETRY is deliberately outside the blocking load. It is only ever drawn once
  // the visible parcel count crosses BLOCK_LOD_PARCEL_BUDGET (main.js), so a session that
  // never pans/zooms into a dense enough view would otherwise wait on it for a layer it
  // never displays. Block ATTRIBUTES do stay in the blocking load: they ride along in
  // attrs.core.json, which is fetched regardless.
  let blocksPromise = null;
  function loadBlocks() {
    if (!blocksPromise) {
      blocksPromise = fetch('/data/blocks.topo.json')
        .then((r) => r.json())
        .then((topo) => feature(topo, topo.objects.blocks).features);
    }
    return blocksPromise;
  }

  // Same deferral for the panel-only attribute columns. Idempotent; resolves with the
  // merged attrs object so callers can chain a re-render off it.
  let detailPromise = null;
  function loadDetail() {
    if (!detailPromise) {
      detailPromise = fetch('/data/attrs.detail.json')
        .then((r) => r.json())
        .then((doc) => {
          Object.assign(attrsDoc.attrs, doc.attrs);
          return attrsDoc.attrs;
        });
    }
    return detailPromise;
  }

  return {
    parcels: parcels.features,
    vias: vias.features,
    ambito,
    loadBlocks,
    loadDetail,
    attrs: attrsDoc.attrs,
    blockAttrs: attrsDoc.blockAttrs,
    meta: attrsDoc.meta,
  };
}
