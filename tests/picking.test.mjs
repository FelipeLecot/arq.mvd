import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMockContext } from './helpers/mockCanvas.mjs';
import { PickingLayer, idToColor } from '../src/picking.js';
import { drawPicking } from '../src/render/parcels.js';
import { prepareFeatures, featureBounds, screenTransform } from '../src/render/geometry.js';
import { metresToMercator } from '../src/projection.js';

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

/** Read a pixel's id the same way onPointerMove does, without a real DOM canvas. */
function pickAt(ctx, width, height, x, y) {
  const fakeLayer = { canvas: { width, height }, ctx };
  return PickingLayer.prototype.pick.call(fakeLayer, x, y);
}

/** Painter's-algorithm order, matching visibleParcelOrder in src/main.js exactly. */
function paintOrder(items) {
  return items.map((_, i) => i).sort((a, b) => items[b].cy - items[a].cy);
}

test('picking: dense edge-to-edge grid, flat (no extrusion) — every non-null pick lands on a parcel actually near the query pixel', () => {
  // Mirrors the scenario picking.js's own docstring describes: small parcels tiling
  // edge-to-edge, so most boundary pixels are antialiased blends of two ids. This sweeps
  // every pixel in the canvas, not just parcel centres, so it also covers the blended
  // fringe the "island rejection" logic exists for.
  const SIZE = 4; // px per parcel side — small enough that most pixels are near an edge
  const COLS = 6;
  const ROWS = 6;
  const W = SIZE * COLS;
  const H = SIZE * ROWS;

  const features = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      features.push(squareFeature(c * SIZE, r * SIZE, (c + 1) * SIZE, (r + 1) * SIZE));
    }
  }
  const items = prepareFeatures(features);
  const idColors = items.map((_, i) => idToColor(i));
  const order = paintOrder(items);

  const ctx = createMockContext(W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H); // picking.clear()

  drawPicking(ctx, items, T, { heights: [], idColors, order, extrude: false, width: W, height: H });

  const bounds = items.map((item) => featureBounds(item, T));
  // The pick() docstring's own contract: a 3x3 island-rejection radius, so any id it
  // returns must have a screen bbox within a few px of the query point. Anything further
  // than that is "a different, distant parcel" — the reported bug.
  const TOLERANCE = 5;

  const violations = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = pickAt(ctx, W, H, x, y);
      if (id == null) continue;
      const [minX, minY, maxX, maxY] = bounds[id];
      const dx = Math.max(minX - x, 0, x - maxX);
      const dy = Math.max(minY - y, 0, y - maxY);
      const dist = Math.hypot(dx, dy);
      if (dist > TOLERANCE) violations.push({ x, y, id, bounds: bounds[id], dist });
    }
  }

  assert.deepEqual(violations, []);
});

test('picking: a tall extruded parcel does not steal picks from a shorter neighbour standing on its own footprint', () => {
  // Two parcels side by side, same row (same cy) so painter order between them is
  // whichever the sort is stable on — but a THIRD, much shorter parcel sits just south
  // (in front, painted last) of a very tall one to its north. The tall parcel's roof
  // leans up + right (LEAN in parcels.js) by its own height; if that lean reaches into
  // the short parcel's own footprint further than the short parcel's paint order can
  // reclaim, a hover square on the short parcel's own footprint reads back the tall
  // parcel's id instead — "hovering a real spot selects a totally different parcel".
  const SIZE = 10;
  const W = 60;
  const H = 80;

  // Tall parcel: north (smaller screen y == larger cy), 30 m envelope.
  const tall = squareFeature(10, 10, 10 + SIZE, 10 + SIZE);
  // Short neighbour: immediately south-east of the tall one, sharing screen space the
  // tall parcel's lean reaches into. 3 m envelope (a short garden wall, not a building).
  const short = squareFeature(10 + SIZE, 10 + SIZE, 10 + 2 * SIZE, 10 + 2 * SIZE);

  const features = [tall, short];
  const items = prepareFeatures(features);
  const idColors = items.map((_, i) => idToColor(i));
  const heights = [30, 3];
  const order = paintOrder(items); // tall (larger cy) painted first, short painted on top

  const exaggeration = 1;
  const ctx = createMockContext(W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  drawPicking(ctx, items, T, {
    heights,
    idColors,
    order,
    extrude: true,
    exaggeration,
    width: W,
    height: H,
  });

  // Sample the short parcel's own footprint interior (not the lifted roof — the real
  // footprint, since that's "the spot a user would actually point at").
  const shortId = 1;
  const cx = Math.round((10 + SIZE + 10 + 2 * SIZE) / 2);
  const cy = Math.round((10 + SIZE + 10 + 2 * SIZE) / 2);
  const picked = pickAt(ctx, W, H, cx, cy);

  assert.equal(picked, shortId, `expected the short parcel's own footprint to pick id ${shortId}, got ${picked}`);
});
