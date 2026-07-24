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

/**
 * Precompute drawable geometry for every feature.
 * Returns [{ polygons: [[Float64Array outer, ...holes]], cy }] where cy is the mean
 * Mercator y, used to sort back-to-front for the painter's algorithm.
 */
export function prepareFeatures(features) {
  return features.map((f) => {
    const polygons = extractPolygons(f.geometry).map((rings) => rings.map(ringToFlat));
    let sy = 0;
    let n = 0;
    for (const rings of polygons) {
      const outer = rings[0];
      for (let i = 1; i < outer.length; i += 2) {
        sy += outer[i];
        n++;
      }
    }
    return { polygons, cy: n ? sy / n : 0 };
  });
}

export function prepareLines(features) {
  return features.map((f) => {
    const g = f.geometry;
    const parts = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
    return { parts: parts.map(ringToFlat), props: f.properties };
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
  const zx = zoom?.x ?? 0;
  const zy = zoom?.y ?? 0;
  return {
    a: k * zk,
    bx: tx * zk + zx,
    by: ty * zk + zy,
    k: k * zk,
  };
}

export const sx = (t, mx) => mx * t.a + t.bx;
export const sy = (t, my) => -my * t.a + t.by;

/** Trace a ring onto a canvas path in screen space, optionally offset. */
export function traceRing(ctx, ring, t, ox = 0, oy = 0) {
  ctx.moveTo(ring[0] * t.a + t.bx + ox, -ring[1] * t.a + t.by + oy);
  for (let i = 2; i < ring.length; i += 2) {
    ctx.lineTo(ring[i] * t.a + t.bx + ox, -ring[i + 1] * t.a + t.by + oy);
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
