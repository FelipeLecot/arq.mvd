/**
 * Parcel rendering — flat and fake-3D.
 *
 * The extrusion is a painter's algorithm: parcels are drawn back-to-front (north first,
 * since north is up on screen), each one's side walls painted from its footprint up to
 * its lifted roof, then the roof on top. Pure Canvas 2D; no WebGL.
 *
 * What is being extruded is the POT/inventory height — the legally permitted envelope,
 * not a measured building. That is stated in the UI wherever height appears.
 */

import { traceRing, featureBounds } from './geometry.js';
import { metresToMercator } from '../projection.js';

const LEAN = 0.32; // horizontal component of the lift, for a slight axonometric read

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `rgb(${r},${g},${b})`;
}

/** Cache wall shades — recomputing them per parcel per frame shows up in a profile. */
const shadeCache = new Map();
function wallShades(hex) {
  let s = shadeCache.get(hex);
  if (!s) {
    s = { front: shade(hex, 0.62), side: shade(hex, 0.4) };
    shadeCache.set(hex, s);
  }
  return s;
}

// Scratch buffer for projected ring coordinates, reused across every parcel so the
// hot loop allocates nothing.
let scratch = new Float64Array(512);

function ensureScratch(size) {
  if (scratch.length < size) scratch = new Float64Array(size * 2);
  return scratch;
}

/**
 * Draw the side walls of one ring. Only faces pointing toward the viewer are painted:
 * with a mostly-upward lift those are the south-facing edges. Drawing every wall would
 * leave the back faces sticking out above the roof.
 *
 * Walls are accumulated into two paths (front-facing and side-facing) and filled twice,
 * rather than one fill per wall. At city scale that is the difference between ~40,000
 * fill calls per frame and ~18,000.
 */
function drawWalls(ctx, ring, t, ox, oy, shades, solid = null) {
  const n = ring.length / 2;
  if (n < 3) return;

  // Project once; both the winding test and the wall loop read these.
  const pts = ensureScratch(n * 2);
  if (t.upright) {
    for (let i = 0; i < n; i++) {
      pts[i * 2] = ring[i * 2] * t.m00 + t.bx;
      pts[i * 2 + 1] = ring[i * 2 + 1] * t.m11 + t.by;
    }
  } else {
    for (let i = 0; i < n; i++) {
      pts[i * 2] = ring[i * 2] * t.m00 + ring[i * 2 + 1] * t.m01 + t.bx;
      pts[i * 2 + 1] = ring[i * 2] * t.m10 + ring[i * 2 + 1] * t.m11 + t.by;
    }
  }

  // Winding, from the shoelace sum in screen space, tells us which normal is outward.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  const wind = area2 > 0 ? 1 : -1;

  // Two passes over the edges — front-facing, then side-facing — so each shade is one
  // path and one fill, with no per-parcel Path2D allocation. The picking pass paints a
  // single flat id colour, so it collapses to one pass and skips the shading split.
  const passes = solid ? 1 : 2;
  for (let pass = 0; pass < passes; pass++) {
    let any = false;
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = pts[i * 2];
      const y1 = pts[i * 2 + 1];
      const x2 = pts[j * 2];
      const y2 = pts[j * 2 + 1];

      // Outward normal for this winding.
      const nx = wind * (y2 - y1);
      const ny = wind * -(x2 - x1);

      // Visible when the face points against the lift, i.e. toward the viewer.
      if (nx * -ox + ny * -oy <= 0) continue;

      if (!solid && Math.abs(nx) > Math.abs(ny) !== (pass === 1)) continue;

      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 + ox, y2 + oy);
      ctx.lineTo(x1 + ox, y1 + oy);
      ctx.closePath();
      any = true;
    }

    if (any) {
      ctx.fillStyle = solid ?? (pass === 1 ? shades.side : shades.front);
      ctx.fill();
    }
  }
}

/**
 * Render every parcel.
 *
 * `pickCtx` receives the same geometry in flat id-colours at the same offsets, so
 * hit-testing lines up with what is on screen — including the lifted roof.
 */
export function drawParcels(ctx, items, t, opts) {
  const {
    colors,
    heights,
    extrude,
    exaggeration = 1,
    selected,
    hoveredId,
    width,
    height,
    idColors,
    dimAlpha = 0.22,
  } = opts;

  const order = opts.order;
  ctx.lineJoin = 'round';

  for (let oi = 0; oi < order.length; oi++) {
    const id = order[oi];
    const item = items[id];
    if (!item.polygons.length) continue;

    const [minX, minY, maxX, maxY] = featureBounds(item, t);
    // Cull generously — the extrusion lifts geometry above its footprint.
    if (maxX < -40 || minX > width + 40 || maxY < -240 || minY > height + 40) continue;

    const isSelected = !selected || selected.has(id);
    const fill = colors[id];

    let ox = 0;
    let oy = 0;
    if (extrude) {
      const metres = heights[id];
      if (metres != null) {
        const px = metresToMercator(metres) * t.a * exaggeration;
        ox = px * LEAN;
        oy = -px;
      }
    }

    ctx.globalAlpha = isSelected ? 1 : dimAlpha;

    if (extrude && oy !== 0) {
      const shades = wallShades(fill);
      for (const rings of item.polygons) drawWalls(ctx, rings[0], t, ox, oy, shades);
    }

    // Roof (or footprint when flat), with holes via even-odd.
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (const rings of item.polygons) {
      for (const ring of rings) traceRing(ctx, ring, t, ox, oy);
    }
    ctx.fill('evenodd');

    // A hairline separates neighbours in a dense block; below ~2px a parcel is smaller
    // than its own outline, so the stroke is dropped rather than smearing the fill.
    if (maxX - minX > 2.5 && isSelected) {
      ctx.strokeStyle = 'rgba(14,18,25,0.55)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    if (id === hoveredId) {
      ctx.strokeStyle = '#FFD873';
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

  }

  ctx.globalAlpha = 1;
}

/**
 * Paint the id-colour picking buffer.
 *
 * Kept separate from the visible draw so it can run lazily — only once the pointer
 * actually needs it — instead of adding its cost to every frame the map repaints.
 *
 * It covers the whole silhouette the eye sees, walls included. Hit-testing only the
 * roof means a pointer on the side of a building selects whatever stands behind it.
 */
export function drawPicking(pickCtx, items, t, opts) {
  const { heights, idColors, order, extrude, exaggeration = 1, width, height } = opts;

  for (let oi = 0; oi < order.length; oi++) {
    const id = order[oi];
    const item = items[id];
    if (!item.polygons.length) continue;

    const [minX, minY, maxX, maxY] = featureBounds(item, t);
    if (maxX < -40 || minX > width + 40 || maxY < -240 || minY > height + 40) continue;

    let ox = 0;
    let oy = 0;
    if (extrude) {
      const metres = heights[id];
      if (metres != null) {
        const px = metresToMercator(metres) * t.a * exaggeration;
        ox = px * LEAN;
        oy = -px;
      }
    }

    const idColor = idColors[id];
    if (extrude && oy !== 0) {
      for (const rings of item.polygons) {
        drawWalls(pickCtx, rings[0], t, ox, oy, null, idColor);
      }
    }
    pickCtx.fillStyle = idColor;
    pickCtx.beginPath();
    for (const rings of item.polygons) {
      for (const ring of rings) traceRing(pickCtx, ring, t, ox, oy);
    }
    pickCtx.fill('evenodd');
  }
}

/**
 * Painter order: back of the scene first.
 *
 * Depends on rotation but not on zoom or pan, which move every parcel together — so it
 * is recomputed when the view turns, not per frame. Screen y for a centroid is
 * proportional to (cx·sinθ − cy·cosθ); sorting ascending puts the far side first. At
 * θ=0 that reduces to north-first.
 */
export function paintOrder(items, rotation = 0) {
  const sin = Math.sin(rotation);
  const cos = Math.cos(rotation);
  const depth = items.map((it) => it.cx * sin - it.cy * cos);
  return Array.from(items.keys()).sort((a, b) => depth[a] - depth[b]);
}
