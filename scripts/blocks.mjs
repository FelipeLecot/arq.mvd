// Merge touching parcels into city-block geometry for the zoomed-out LOD.
//
// Montevideo's cadastral parcels tile edge-to-edge within a block and are separated by
// street right-of-way everywhere else, so "parcels that touch" and "parcels in the same
// city block" are the same thing — no separate manzana source dataset exists to join
// against (see docs/data-sources.md), so blocks are derived from adjacency instead.

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
