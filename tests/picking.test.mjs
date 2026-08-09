import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMockContext } from './helpers/mockCanvas.mjs';
import { PickingLayer, idToColor } from '../src/picking.js';
import { drawPicking } from '../src/render/parcels.js';
import { prepareFeatures, featureBounds } from '../src/render/geometry.js';

// t = {a:1, bx:0, by:0} makes Mercator (mx,my) -> screen (mx, -my), i.e. screen (sx,sy)
// -> Mercator (sx,-sy). Test geometry is authored directly in screen pixels via this
// helper so scenes are easy to reason about; it's the same affine shape screenTransform()
// produces, just with round numbers.
const T = { a: 1, bx: 0, by: 0 };

function squareFeature(x0, y0, x1, y1) {
  const ring = [
    [x0, -y0],
    [x1, -y0],
    [x1, -y1],
    [x0, -y1],
    [x0, -y0],
  ];
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

/**
 * Read a pixel's id the same way onPointerMove does, without a real DOM canvas: `pick()`
 * only touches `canvas.{width,height}` and `ctx.getImageData`, and `setPaintedIds` (called
 * by refreshPicking in src/main.js right after drawPicking, in real use) only touches a
 * plain property — so a plain object shaped like a PickingLayer instance works for both.
 */
function makeFakeLayer(ctx, width, height, order) {
  const layer = { canvas: { width, height }, ctx };
  PickingLayer.prototype.setPaintedIds.call(layer, order);
  return layer;
}

/** Painter's-algorithm order, matching visibleParcelOrder in src/main.js exactly. */
function paintOrder(items) {
  return items.map((_, i) => i).sort((a, b) => items[b].cy - items[a].cy);
}

// Deterministic PRNG (mulberry32) so the shuffle below is reproducible across runs/CI.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build a dense edge-to-edge grid of COLS x ROWS SIZE-px parcels, with id assignment
 * shuffled relative to screen position (feature build order is shuffled before
 * prepareFeatures, so id N is not "the parcel N cells from the top-left") — this
 * decorrelation is the adversarial setup the code review that found the spacing-only
 * fix's gap used, and it matters: a non-shuffled raster-order id assignment tends to keep
 * nearby-on-screen parcels nearby-in-id too, which happens to make accidental colour
 * collisions land close to the query point even when they shouldn't be trusted, masking
 * exactly the failure mode this is testing for. Renders via the real drawPicking, and
 * sweeps every pixel (not just parcel centres) through the real PickingLayer.pick, so it
 * also covers the blended fringe the plurality-vote logic exists for. Returns every pixel
 * where a non-null pick's id has no footprint within TOLERANCE px of the query point —
 * "a different, distant parcel", the reported bug.
 */
function sweepForDistantPicks(seed, cols, rows, size, tolerance = 5) {
  const w = size * cols;
  const h = size * rows;

  const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
  const shuffledCells = shuffled(cells, mulberry32(seed));

  const features = shuffledCells.map(([r, c]) =>
    squareFeature(c * size, r * size, (c + 1) * size, (r + 1) * size),
  );
  const items = prepareFeatures(features);
  const idColors = items.map((_, i) => idToColor(i));
  const order = paintOrder(items);

  const ctx = createMockContext(w, h);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h); // picking.clear()

  drawPicking(ctx, items, T, { heights: [], idColors, order, extrude: false, width: w, height: h });
  const layer = makeFakeLayer(ctx, w, h, order);

  const bounds = items.map((item) => featureBounds(item, T));
  const violations = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = PickingLayer.prototype.pick.call(layer, x, y);
      if (id == null) continue;
      const [minX, minY, maxX, maxY] = bounds[id];
      const dx = Math.max(minX - x, 0, x - maxX);
      const dy = Math.max(minY - y, 0, y - maxY);
      const dist = Math.hypot(dx, dy);
      if (dist > tolerance) violations.push({ x, y, id, bounds: bounds[id], dist });
    }
  }
  return violations;
}

test('picking: dense edge-to-edge grid with ids shuffled relative to screen position — every non-null pick lands on a parcel actually near the query pixel', () => {
  assert.deepEqual(sweepForDistantPicks(20260808, 20, 20, 4), []);
});

test('picking: the same sweep holds across several independent shuffles and grid densities', () => {
  // Reproduces the multi-seed stress check from the code review that found the
  // spacing-only fix's gap (task-3-report.md): before the plurality-vote defence
  // (PickingLayer.pick's local "most repeats wins" logic), a single 20x20 shuffled sweep
  // already found real collisions — a handful, not the ~36%-of-blends pre-fix rate, but
  // real. Running several independent shuffles plus one denser/smaller-parcel grid is
  // what establishes "actually fixed" rather than "fixed for this one seed".
  for (const [seed, cols, rows, size] of [
    [1, 20, 20, 4],
    [2, 20, 20, 4],
    [3, 20, 20, 4],
    [4, 20, 20, 4],
    [5, 20, 20, 4],
    [42, 20, 20, 4],
    [999999, 20, 20, 4],
    [12345, 30, 30, 3], // denser: smaller parcels, more shared edges per unit area
  ]) {
    const violations = sweepForDistantPicks(seed, cols, rows, size);
    assert.deepEqual(violations, [], `seed=${seed} grid=${cols}x${rows}@${size}px`);
  }
});

test('picking: a taller parcel correctly wins picks where its leaned silhouette actually covers a shorter neighbour, and only there', () => {
  // SHORT sits immediately north of TALL (sharing the edge at y=20); TALL is much taller,
  // so its silhouette (footprint swept up + right by LEAN in src/render/parcels.js, per
  // metresToMercator(30m) at exaggeration 1) leans up over most — but not all — of SHORT's
  // own footprint. Rendered and inspected directly (see task-3-report.md) to confirm real,
  // substantial overlap exists here, unlike the previous version of this test where the
  // two parcels were placed such that the lean pointed away from the short one and the
  // silhouettes never touched at all — a test that couldn't fail no matter how painter
  // order or wall-visibility logic broke.
  const short = squareFeature(10, 0, 30, 20);
  const tall = squareFeature(10, 20, 30, 40);
  const items = prepareFeatures([short, tall]); // id0 = short, id1 = tall
  const idColors = items.map((_, i) => idToColor(i));
  const heights = [3, 30]; // short: a garden wall; tall: a real building
  const order = paintOrder(items); // tall has the smaller cy (further south) -> painted last, on top

  const W = 70;
  const H = 60;
  const ctx = createMockContext(W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawPicking(ctx, items, T, {
    heights,
    idColors,
    order,
    extrude: true,
    exaggeration: 1,
    width: W,
    height: H,
  });
  const layer = makeFakeLayer(ctx, W, H, order);

  // Inside SHORT's own footprint (x:[10,30], y:[0,20]), but also inside TALL's leaned
  // silhouette (verified by direct pixel inspection) — per CLAUDE.md, "It covers the whole
  // silhouette, including walls" is correct *by design*, so this must resolve to TALL, not
  // to whichever parcel's ground is literally underneath.
  assert.equal(
    PickingLayer.prototype.pick.call(layer, 20, 5),
    1,
    'a point under the tall parcel\'s leaned silhouette should pick the tall parcel',
  );

  // Also inside SHORT's own footprint, but in the sliver TALL's silhouette never reaches
  // (near SHORT's own north-west corner, far from the shared edge the lean sweeps across).
  // If painter order or wall-visibility broke such that TALL's colour leaked everywhere
  // (e.g. order reversed, or the whole silhouette drawn over the entire canvas), this
  // point would wrongly turn up as TALL too — this is the assertion Finding 2 was about.
  assert.equal(
    PickingLayer.prototype.pick.call(layer, 11, 1),
    0,
    'a point outside the tall parcel\'s silhouette must still pick its true owner, not the taller neighbour',
  );
});
