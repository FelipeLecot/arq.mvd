/**
 * Street labels with greedy collision rejection.
 *
 * Candidates are ranked by street importance and segment length, then accepted only if
 * their bounding box clears every label already placed. Simple, and at this feature
 * count indistinguishable from anything cleverer.
 */

import { streetWeight } from './streets.js';

const MIN_SEGMENT_PX = 46;

/** Zoom thresholds at which each class of street earns a label. */
function minZoomFor(tipo) {
  const w = streetWeight(tipo);
  if (w >= 2) return 0; // avenidas and bulevares always
  if (w >= 1) return 2.2; // calles once the reader is in
  return 5; // pasajes only when close
}

function longestSegment(part) {
  let best = -1;
  let bx1 = 0, by1 = 0, bx2 = 0, by2 = 0;
  for (let i = 0; i + 3 < part.length; i += 2) {
    const dx = part[i + 2] - part[i];
    const dy = part[i + 3] - part[i + 1];
    const d2 = dx * dx + dy * dy;
    if (d2 > best) {
      best = d2;
      bx1 = part[i]; by1 = part[i + 1];
      bx2 = part[i + 2]; by2 = part[i + 3];
    }
  }
  return best < 0 ? null : { x1: bx1, y1: by1, x2: bx2, y2: by2, len2: best };
}

export function drawLabels(ctx, lines, t, { zoomK = 1, width, height }) {
  ctx.save();
  ctx.font = "500 10px 'Century Gothic', Futura, system-ui, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const candidates = [];

  for (const line of lines) {
    const name = line.props.name;
    if (!name || zoomK < minZoomFor(line.props.tipo)) continue;

    for (const part of line.parts) {
      const seg = longestSegment(part);
      if (!seg) continue;

      const x1 = seg.x1 * t.m00 + seg.y1 * t.m01 + t.bx;
      const y1 = seg.x1 * t.m10 + seg.y1 * t.m11 + t.by;
      const x2 = seg.x2 * t.m00 + seg.y2 * t.m01 + t.bx;
      const y2 = seg.x2 * t.m10 + seg.y2 * t.m11 + t.by;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < MIN_SEGMENT_PX) continue;

      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      if (cx < 0 || cx > width || cy < 0 || cy > height) continue;

      candidates.push({
        name, cx, cy, len,
        angle: Math.atan2(dy, dx),
        weight: streetWeight(line.props.tipo),
      });
    }
  }

  // Heavier streets first, then longer runs — the labels a reader most needs.
  candidates.sort((a, b) => b.weight - a.weight || b.len - a.len);

  const placed = [];
  const seen = new Set();

  for (const c of candidates) {
    // One label per street name per frame keeps a long avenida from repeating.
    if (seen.has(c.name)) continue;

    const label = c.name.length > 22 ? `${c.name.slice(0, 21)}…` : c.name;
    const w = ctx.measureText(label).width;
    if (w + 8 > c.len) continue;

    // Axis-aligned box around the rotated label: adequate, and cheap.
    const abs = Math.abs(Math.cos(c.angle));
    const halfW = (w / 2) * abs + 7 * (1 - abs);
    const halfH = 6 * abs + (w / 2) * (1 - abs);
    const box = [c.cx - halfW, c.cy - halfH, c.cx + halfW, c.cy + halfH];

    if (placed.some((p) => !(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3]))) {
      continue;
    }

    placed.push(box);
    seen.add(c.name);

    // Keep text upright rather than letting it read upside down.
    let angle = c.angle;
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;

    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.rotate(angle);
    ctx.strokeStyle = 'rgba(14,18,25,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = 'rgba(233,227,213,0.72)';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
