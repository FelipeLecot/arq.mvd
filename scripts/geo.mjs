// Geometry helpers: reprojection and clipping.
//
// Everything is pre-projected to EPSG:3857 at build time. That is what lets the browser use
// d3.geoIdentity() instead of d3.geoMercator() — no per-frame reprojection of 9000 polygons,
// which is the single biggest render win available.

import proj4 from 'proj4';

// Source CRS confirmed from the .prj shipped with the IM shapefiles and the `crs` member
// of the inventory GeoJSON: WGS 84 / UTM zone 21S.
const UTM21S = '+proj=utm +zone=21 +south +datum=WGS84 +units=m +no_defs';
const WEB_MERCATOR = '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs';

const forward = proj4(UTM21S, WEB_MERCATOR).forward;
const toWgs84 = proj4(UTM21S, proj4.WGS84).forward;

export function projectPoint(coord) {
  const [x, y] = forward(coord);
  return [x, y];
}

export function utmToLngLat(coord) {
  const [lng, lat] = toWgs84(coord);
  return [lng, lat];
}

/** Recursively map every position in a GeoJSON coordinate array. */
function mapCoords(coords, fn) {
  if (typeof coords[0] === 'number') return fn(coords);
  return coords.map((c) => mapCoords(c, fn));
}

export function projectGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return geometry;
  return {
    ...geometry,
    coordinates: mapCoords(geometry.coordinates, projectPoint),
  };
}

export function projectFeature(feature) {
  return { ...feature, geometry: projectGeometry(feature.geometry) };
}

/** Bounding box [minX, minY, maxX, maxY] of a projected geometry. */
export function bbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  mapCoords(geometry.coordinates, ([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    return [x, y];
  });
  return [minX, minY, maxX, maxY];
}

export function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Point-in-polygon over a (Multi)Polygon's outer rings, with holes subtracted.
 * Ray casting; good enough for clipping streets and address points to the ambito.
 */
export function pointInGeometry(point, geometry) {
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const rings of polys) {
    if (!ringContains(rings[0], point)) continue;
    let inHole = false;
    for (let i = 1; i < rings.length; i++) {
      if (ringContains(rings[i], point)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

function ringContains(ring, [px, py]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Rough centroid of a projected geometry — the mean of its outer-ring vertices. */
export function centroid(geometry) {
  let sx = 0, sy = 0, n = 0;
  mapCoords(geometry.coordinates, ([x, y]) => {
    sx += x; sy += y; n++;
    return [x, y];
  });
  return n ? [sx / n, sy / n] : null;
}
