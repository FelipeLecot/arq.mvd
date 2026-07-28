/**
 * Spatial index over static Mercator-space bounding boxes (see `prepareFeatures`/
 * `prepareLines` in geometry.js), so per-frame work is proportional to what's on screen
 * rather than the size of the dataset. At Centro's original 9,016 parcels a full per-frame
 * scan was cheap; at the citywide 208,862 it dominated the frame budget even though the
 * viewport itself — capped by `scaleExtent` — never shows more than a similar handful of
 * features at once.
 */

import RBush from 'rbush';

/** Build an index over any array of entries carrying a static `bounds` [minX,minY,maxX,maxY]. */
export function buildIndex(entries) {
  const tree = new RBush();
  tree.load(
    entries.map((entry, id) => {
      const [minX, minY, maxX, maxY] = entry.bounds;
      return { minX, minY, maxX, maxY, id };
    }),
  );
  return tree;
}

/** Ids of every entry whose bbox intersects the given Mercator-space rectangle. */
export function queryIds(tree, minX, minY, maxX, maxY) {
  return tree.search({ minX, minY, maxX, maxY }).map((node) => node.id);
}
