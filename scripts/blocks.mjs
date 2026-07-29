// Merge touching parcels into city-block geometry for the zoomed-out LOD.
//
// Montevideo's cadastral parcels tile edge-to-edge within a block and are separated by
// street right-of-way everywhere else, so "parcels that touch" and "parcels in the same
// city block" are the same thing — no separate manzana source dataset exists to join
// against (see docs/data-sources.md), so blocks are derived from adjacency instead.

import RBush from 'rbush';
import { bbox } from './geo.mjs';
import polygonClipping from 'polygon-clipping';

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonArea(geometry) {
  if (!geometry) return 0;
  const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let area = 0;
  for (const rings of polys) {
    area += ringArea(rings[0]);
    for (let i = 1; i < rings.length; i++) area -= ringArea(rings[i]);
  }
  return area;
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Same "never coerce missing to 0" rule as parseAltura/parsePotNumeric in normalize.mjs:
 * a block where every member's height is unknown must stay null, not average to 0 and
 * read as a real (very short) building.
 */
export function meanOrNull(values) {
  const nums = values.filter((v) => v != null);
  return nums.length ? mean(nums) : null;
}

// On an equal-area tie, the more protective grade wins rather than whichever code the
// aggregation happens to visit first.
const TIE_BREAK_ORDER = ['G4', 'G3', 'G2', 'G1', 'G0', 'RG', 'SC', 'NA'];

export function dominantGrado(entries) {
  const areaByCode = new Map();
  for (const { code, area } of entries) {
    areaByCode.set(code, (areaByCode.get(code) ?? 0) + area);
  }
  let bestCode = null;
  let bestArea = -Infinity;
  for (const code of TIE_BREAK_ORDER) {
    const area = areaByCode.get(code);
    if (area == null) continue;
    if (area > bestArea) {
      bestArea = area;
      bestCode = code;
    }
  }
  const totalArea = [...areaByCode.values()].reduce((a, b) => a + b, 0);
  return { code: bestCode, sharePct: totalArea ? Math.round((bestArea / totalArea) * 100) : 0 };
}

function distSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function pointSegDistSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = abLenSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  return distSq(px, py, ax + t * abx, ay + t * aby);
}

function cross(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum distance between two line segments, 0 if they cross. */
function segmentDistance(a1, a2, b1, b2) {
  if (segmentsIntersect(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1], b2[0], b2[1])) return 0;
  return Math.sqrt(
    Math.min(
      pointSegDistSq(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]),
      pointSegDistSq(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]),
      pointSegDistSq(b1[0], b1[1], a1[0], a1[1], a2[0], a2[1]),
      pointSegDistSq(b2[0], b2[1], a1[0], a1[1], a2[0], a2[1]),
    ),
  );
}

function polygonRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function ringsTouch(geomA, geomB, tolerance) {
  const ringsA = polygonRings(geomA);
  const ringsB = polygonRings(geomB);
  for (const ringA of ringsA) {
    for (let i = 0; i < ringA.length; i++) {
      const a1 = ringA[i];
      const a2 = ringA[(i + 1) % ringA.length];
      for (const ringB of ringsB) {
        for (let j = 0; j < ringB.length; j++) {
          const b1 = ringB[j];
          const b2 = ringB[(j + 1) % ringB.length];
          if (segmentDistance(a1, a2, b1, b2) <= tolerance) return true;
        }
      }
    }
  }
  return false;
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

/**
 * tolerance (Mercator metres) absorbs small digitizing mismatches between Centro's
 * curated geometry and the separately-sourced POT parcels, while staying far short of
 * any real street width — so it can't accidentally bridge two parcels across a street.
 */
export function findAdjacentGroups(features, tolerance = 0.5) {
  const n = features.length;
  const uf = new UnionFind(n);
  const boxes = features.map((f) => bbox(f.geometry));

  const tree = new RBush();
  tree.load(
    boxes.map(([minX, minY, maxX, maxY], id) => ({
      minX: minX - tolerance,
      minY: minY - tolerance,
      maxX: maxX + tolerance,
      maxY: maxY + tolerance,
      id,
    })),
  );

  for (let id = 0; id < n; id++) {
    const [minX, minY, maxX, maxY] = boxes[id];
    const candidates = tree.search({
      minX: minX - tolerance,
      minY: minY - tolerance,
      maxX: maxX + tolerance,
      maxY: maxY + tolerance,
    });
    for (const c of candidates) {
      if (c.id <= id) continue;
      if (uf.find(id) === uf.find(c.id)) continue;
      if (ringsTouch(features[id].geometry, features[c.id].geometry, tolerance)) {
        uf.union(id, c.id);
      }
    }
  }

  const groups = new Map();
  for (let id = 0; id < n; id++) {
    const root = uf.find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()];
}

function toClipGeom(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return null;
}

/**
 * polygon-clipping's union always returns a MultiPolygon-shaped coordinate array (an
 * array of polygons, even when there's only one) — collapse that to a plain Polygon when
 * possible so downstream code isn't forced through the MultiPolygon branch unnecessarily.
 */
export function unionGroup(geometries) {
  if (geometries.length === 1) return geometries[0];

  const clipGeoms = geometries.map(toClipGeom);
  if (clipGeoms.some((g) => g === null)) return null;

  try {
    const result = polygonClipping.union(clipGeoms[0], ...clipGeoms.slice(1));
    if (!result || result.length === 0) return null;
    return result.length === 1
      ? { type: 'Polygon', coordinates: result[0] }
      : { type: 'MultiPolygon', coordinates: result };
  } catch {
    return null;
  }
}
