import { feature } from 'topojson-client';

/**
 * Geometry and attributes load from separate files so that changing the active
 * attribute never re-parses topology.
 */
export async function loadAtlas() {
  const [parcelsTopo, viasTopo, attrsDoc] = await Promise.all([
    fetch('/data/centro.topo.json').then((r) => r.json()),
    fetch('/data/vias.topo.json').then((r) => r.json()),
    fetch('/data/attrs.json').then((r) => r.json()),
  ]);

  const parcels = feature(parcelsTopo, parcelsTopo.objects.parcels);
  const vias = feature(viasTopo, viasTopo.objects.vias);
  const ambito = feature(viasTopo, viasTopo.objects.ambito);

  // Block GEOMETRY is deliberately outside the blocking load. It is the second-largest
  // file the atlas ships and it is only ever drawn once the visible parcel count crosses
  // BLOCK_LOD_PARCEL_BUDGET (main.js), so a session that never pans/zooms into a dense
  // enough view would otherwise wait on ~13 MB — fetch, parse, decode and index — for a
  // layer it never displays. Block ATTRIBUTES do stay in the blocking load: they ride
  // along in attrs.json, which is fetched regardless.
  let blocksPromise = null;
  function loadBlocks() {
    if (!blocksPromise) {
      blocksPromise = fetch('/data/blocks.topo.json')
        .then((r) => r.json())
        .then((topo) => feature(topo, topo.objects.blocks).features);
    }
    return blocksPromise;
  }

  return {
    parcels: parcels.features,
    vias: vias.features,
    ambito,
    loadBlocks,
    attrs: attrsDoc.attrs,
    blockAttrs: attrsDoc.blockAttrs,
    meta: attrsDoc.meta,
  };
}
