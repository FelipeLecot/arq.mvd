/**
 * Hit-testing via a hidden picking canvas: every parcel is drawn in a unique RGB id
 * colour, and a hover reads one pixel. O(1) regardless of feature count.
 *
 * The picking canvas is redrawn by the same code path as the visible map, at the same
 * transform and — critically — with the same extrusion offset applied to the roof.
 * If picking drew the flat footprint while the eye saw a lifted roof, every hover on an
 * extruded building would be wrong by the height of the building.
 */

export function idToColor(id) {
  // +1 so id 0 is not black, which is the "nothing here" background.
  const n = id + 1;
  return `rgb(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff})`;
}

export function colorToId(r, g, b) {
  const n = (r << 16) | (g << 8) | b;
  return n === 0 ? null : n - 1;
}

export class PickingLayer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  resize(width, height, dpr) {
    // Picking runs at CSS-pixel resolution: it needs positional accuracy, not sharpness,
    // and a 1x buffer is a quarter of the readback cost of a 2x one.
    this.dpr = 1;
    this.canvas.width = Math.max(1, Math.floor(width));
    this.canvas.height = Math.max(1, Math.floor(height));
  }

  clear() {
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Read the feature id under a CSS-pixel coordinate, or null.
   *
   * Canvas antialiases every polygon edge, and an id colour is a bit-packed integer, so
   * a blended boundary pixel decodes to a THIRD parcel unrelated to either neighbour.
   * At city zoom roughly 44% of foreground pixels are such blends — reading a single
   * pixel there returns the wrong padrón nearly half the time.
   *
   * A blend is a one-pixel island: the colour of a real parcel's interior repeats in the
   * neighbourhood, a blend's does not. So the centre pixel is trusted when its colour
   * repeats nearby, and otherwise the nearest colour that does repeat within a 3×3 radius
   * (squared distance ≤ 2) is accepted; beyond that, deselect rather than guess.
   */
  pick(x, y) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const { width, height } = this.canvas;
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return null;

    const R = 3;
    const x0 = Math.max(0, cx - R);
    const y0 = Math.max(0, cy - R);
    const x1 = Math.min(width - 1, cx + R);
    const y1 = Math.min(height - 1, cy + R);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    const data = this.ctx.getImageData(x0, y0, w, h).data;
    const at = (ix, iy) => {
      const i = (iy * w + ix) * 4;
      return (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    };

    const counts = new Map();
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const c = at(ix, iy);
        if (c !== 0) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }

    const centre = at(cx - x0, cy - y0);
    // Genuine background — a street or the edge of the ámbito — selects nothing.
    if (centre === 0) return null;
    if ((counts.get(centre) ?? 0) >= 2) {
      return colorToId(centre >> 16, (centre >> 8) & 0xff, centre & 0xff);
    }

    // Centre is an antialias island — take the nearest colour that is actually solid,
    // but only within a 3×3 neighbourhood (squared distance ≤ 2) to avoid snapping to
    // unrelated neighbouring parcels.
    let best = 0;
    let bestDist = Infinity;
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const c = at(ix, iy);
        if (c === 0 || (counts.get(c) ?? 0) < 2) continue;
        const dx = ix - (cx - x0);
        const dy = iy - (cy - y0);
        const d = dx * dx + dy * dy;
        if (d <= 2 && d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
    }
    if (best === 0) return null;
    return colorToId(best >> 16, (best >> 8) & 0xff, best & 0xff);
  }
}
