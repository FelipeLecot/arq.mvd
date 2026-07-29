import { feature } from 'topojson-client';

/**
 * Geometry and attributes load from separate files so that changing the active
 * attribute never re-parses topology.
 */
export async function loadAtlas() {
  const [parcelsTopo, viasTopo, blocksTopo, attrsDoc] = await Promise.all([
    fetch('/data/centro.topo.json').then((r) => r.json()),
    fetch('/data/vias.topo.json').then((r) => r.json()),
    fetch('/data/blocks.topo.json').then((r) => r.json()),
    fetch('/data/attrs.json').then((r) => r.json()),
  ]);

  const parcels = feature(parcelsTopo, parcelsTopo.objects.parcels);
  const vias = feature(viasTopo, viasTopo.objects.vias);
  const ambito = feature(viasTopo, viasTopo.objects.ambito);
  const blocks = feature(blocksTopo, blocksTopo.objects.blocks);

  return {
    parcels: parcels.features,
    vias: vias.features,
    ambito,
    blocks: blocks.features,
    attrs: attrsDoc.attrs,
    blockAttrs: attrsDoc.blockAttrs,
    meta: attrsDoc.meta,
  };
}
