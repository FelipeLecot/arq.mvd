/**
 * Ring extraction and the screen transform.
 *
 * Rings are pulled out of the TopoJSON features once, at load, into flat Float64Arrays
 * of Mercator coordinates. Per frame we only walk those arrays applying an affine
 * transform — no GeoJSON object traversal, no reprojection.
 */

/** A feature becomes an array of polygons; a polygon an array of rings. */
export function extractPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function ringToFlat(ring) {
  const flat = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    flat[i * 2] = ring[i][0];
    flat[i * 2 + 1] = ring[i][1];
  }
  return flat;
}

/** Mercator-space bounding box of a set of flat rings, as [minX, minY, maxX, maxY]. */
function ringsBounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i];
      const y = ring[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Precompute drawable geometry for every feature.
 * `cy` is the mean Mercator northing, used to sort back-to-front for the painter's
 * algorithm. `bounds` is a static Mercator-space bbox, used to build the spatial index
 * that keeps per-frame work proportional to what's on screen rather than the full
 * dataset — see `spatialIndex.js`.
 */
export function prepareFeatures(features) {
  return features.map((f) => {
    const polygons = extractPolygons(f.geometry).map((rings) => rings.map(ringToFlat));
    let sy = 0;
    let n = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const rings of polygons) {
      const outer = rings[0];
      for (let i = 1; i < outer.length; i += 2) {
        sy += outer[i];
        n++;
      }
      const [bx0, by0, bx1, by1] = ringsBounds(rings);
      if (bx0 < minX) minX = bx0;
      if (by0 < minY) minY = by0;
      if (bx1 > maxX) maxX = bx1;
      if (by1 > maxY) maxY = by1;
    }
    return {
      polygons,
      cy: n ? sy / n : 0,
      bounds: n ? [minX, minY, maxX, maxY] : [0, 0, 0, 0],
    };
  });
}

export function prepareLines(features) {
  return features.map((f) => {
    const g = f.geometry;
    const parts = (g.type === 'MultiLineString' ? g.coordinates : [g.coordinates]).map(ringToFlat);
    return { parts, props: f.properties, bounds: ringsBounds(parts) };
  });
}

/**
 * Collapse the geoIdentity fit and the d3.zoom transform into one affine pair so each
 * point costs two multiplies. geoIdentity().reflectY(true) maps mercator (mx,my) to
 * (mx*k + tx, -my*k + ty); the zoom transform then scales and offsets that.
 */
export function screenTransform(projection, zoom) {
  const k = projection.scale();
  const [tx, ty] = projection.translate();
  const zk = zoom?.k ?? 1;
  return {
    a: k * zk,
    bx: tx * zk + (zoom?.x ?? 0),
    by: ty * zk + (zoom?.y ?? 0),
  };
}

export const sx = (t, mx) => mx * t.a + t.bx;
export const sy = (t, my) => -my * t.a + t.by;

/** Trace a ring onto a canvas path in screen space, optionally offset. */
export function traceRing(ctx, ring, t, ox = 0, oy = 0) {
  const bx = t.bx + ox;
  const by = t.by + oy;
  ctx.moveTo(ring[0] * t.a + bx, -ring[1] * t.a + by);
  for (let i = 2; i < ring.length; i += 2) {
    ctx.lineTo(ring[i] * t.a + bx, -ring[i + 1] * t.a + by);
  }
  ctx.closePath();
}

/** Screen-space bounding box of a prepared feature, for viewport culling. */
export function featureBounds(item, t) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rings of item.polygons) {
    const r = rings[0];
    for (let i = 0; i < r.length; i += 2) {
      const x = r[i] * t.a + t.bx;
      const y = -r[i + 1] * t.a + t.by;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}
