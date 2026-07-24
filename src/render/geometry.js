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
 * `cx`/`cy` are the mean Mercator centre, used to sort back-to-front for the painter's
 * algorithm — both are needed because once the view rotates, "back" is no longer north.
 */
export function prepareFeatures(features) {
  return features.map((f) => {
    const polygons = extractPolygons(f.geometry).map((rings) => rings.map(ringToFlat));
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const rings of polygons) {
      const outer = rings[0];
      for (let i = 0; i < outer.length; i += 2) {
        sx += outer[i];
        sy += outer[i + 1];
        n++;
      }
    }
    return { polygons, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
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
 * Collapse the geoIdentity fit, the d3.zoom transform, and the view rotation into a
 * single 2x2 matrix plus offset, so each point costs four multiplies.
 *
 * Without rotation this reduces to the original mapping: geoIdentity().reflectY(true)
 * sends mercator (mx,my) to (mx*a + bx, -my*a + by). Rotation spins that result about
 * the viewport centre, which is folded into the same matrix rather than applied as a
 * canvas transform — the extrusion offset has to stay in screen space so buildings keep
 * rising toward the top of the screen however the plan is turned.
 */
export function screenTransform(projection, zoom, rotation = 0, centre = [0, 0]) {
  const k = projection.scale();
  const [tx, ty] = projection.translate();
  const zk = zoom?.k ?? 1;
  const a = k * zk;

  const bx0 = tx * zk + (zoom?.x ?? 0);
  const by0 = ty * zk + (zoom?.y ?? 0);

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const [cx, cy] = centre;

  return {
    m00: a * cos,
    m01: a * sin,
    m10: a * sin,
    m11: -a * cos,
    bx: cx + cos * (bx0 - cx) - sin * (by0 - cy),
    by: cy + sin * (bx0 - cx) + cos * (by0 - cy),
    a,
    // North-up is the common case and skips two multiplies and two adds per point.
    // Callers branch on this once per ring, never per vertex.
    upright: sin === 0,
  };
}

export const px = (t, mx, my) => mx * t.m00 + my * t.m01 + t.bx;
export const py = (t, mx, my) => mx * t.m10 + my * t.m11 + t.by;

/** Trace a ring onto a canvas path in screen space, optionally offset. */
export function traceRing(ctx, ring, t, ox = 0, oy = 0) {
  const bx = t.bx + ox;
  const by = t.by + oy;

  if (t.upright) {
    ctx.moveTo(ring[0] * t.m00 + bx, ring[1] * t.m11 + by);
    for (let i = 2; i < ring.length; i += 2) {
      ctx.lineTo(ring[i] * t.m00 + bx, ring[i + 1] * t.m11 + by);
    }
  } else {
    ctx.moveTo(ring[0] * t.m00 + ring[1] * t.m01 + bx, ring[0] * t.m10 + ring[1] * t.m11 + by);
    for (let i = 2; i < ring.length; i += 2) {
      ctx.lineTo(
        ring[i] * t.m00 + ring[i + 1] * t.m01 + bx,
        ring[i] * t.m10 + ring[i + 1] * t.m11 + by,
      );
    }
  }
  ctx.closePath();
}

/** Screen-space bounding box of a prepared feature, for viewport culling. */
export function featureBounds(item, t) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const upright = t.upright;

  for (const rings of item.polygons) {
    const r = rings[0];
    for (let i = 0; i < r.length; i += 2) {
      const x = upright ? r[i] * t.m00 + t.bx : r[i] * t.m00 + r[i + 1] * t.m01 + t.bx;
      const y = upright ? r[i + 1] * t.m11 + t.by : r[i] * t.m10 + r[i + 1] * t.m11 + t.by;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}
