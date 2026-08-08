/**
 * Hit-testing via a hidden picking canvas: every parcel is drawn in a unique RGB id
 * colour, and a hover reads one pixel. O(1) regardless of feature count.
 *
 * The picking canvas is redrawn by the same code path as the visible map, at the same
 * transform and — critically — with the same extrusion offset applied to the roof.
 * If picking drew the flat footprint while the eye saw a lifted roof, every hover on an
 * extruded building would be wrong by the height of the building.
 */

// Packed ids are spaced apart by this factor rather than assigned consecutive integers.
// Canvas antialiases every path edge, and a fill/stroke pair drawn over an already-opaque
// neighbour blends the two RGB colours at whatever fractional coverage the rasterizer
// computed — round(idA*coverage + idB*(1-coverage)) is, in general, some THIRD integer.
// With ids packed as consecutive integers (spacing 1), every integer in range belongs to
// some real feature, so that blended integer is *always* another real, arbitrary id — every
// antialiased edge pixel decodes to a parcel unrelated to either of its true neighbours,
// silently. Spacing ids apart means only 1 in SPACING possible rounded outcomes lands back
// on a real id; the other (SPACING-1)/SPACING blends round to a value nobody owns, which
// colorToId now reports as invalid rather than as a fabricated pick. See pick() for how
// that plays into rejecting contaminated pixels. 32 keeps the packed value comfortably
// inside 24 bits (16,777,215) up to roughly 500k features — the citywide dataset is ~209k.
const ID_SPACING = 32;

export function idToColor(id) {
  // +1 so id 0 is not black, which is the "nothing here" background.
  const n = (id + 1) * ID_SPACING;
  return `rgb(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff})`;
}

/**
 * Decode a packed colour back to a feature id, or null if it isn't a genuine one.
 *
 * Only exact multiples of ID_SPACING were ever assigned to a real feature — anything else
 * is background (n === 0) or the product of antialiasing blending two real ids together
 * (see ID_SPACING above). Both cases mean "nothing trustworthy was read here", so both
 * return null; the caller decides whether to treat that as "nothing" or search nearby.
 */
export function colorToId(r, g, b) {
  const n = (r << 16) | (g << 8) | b;
  return n === 0 || n % ID_SPACING !== 0 ? null : n / ID_SPACING - 1;
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
   * Canvas antialiases every polygon edge, and (before ID_SPACING, see picking.js's top)
   * an id colour was a bit-packed integer with no gaps, so a blended boundary pixel always
   * decoded to a THIRD parcel unrelated to either neighbour. At city zoom roughly 44% of
   * foreground pixels are such blends.
   *
   * Two independent defences, not one: `decode()` throws out any pixel whose colour isn't
   * an exact multiple of ID_SPACING — most blends land off-grid and are caught here, cheaply,
   * before locality even comes into it. What's left is a *rare* blend that still happens to
   * land back on some other real id's exact colour. For that residual case a blend is
   * usually a thin antialiased band (a stroke's own ~1.5px-wide edge, or a fill boundary),
   * not a wide one — a real parcel's *interior*, away from any edge, has its colour
   * repeated all through the neighbourhood, so the centre is trusted only when its colour
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
    // Background (0) or off-grid (not a multiple of ID_SPACING) both mean "not a real,
    // uncontaminated id colour" — see ID_SPACING's docstring. Neither is ever a candidate
    // answer, and neither counts toward another colour's "repeats nearby" tally.
    const isRealId = (c) => c !== 0 && c % ID_SPACING === 0;

    const counts = new Map();
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const c = at(ix, iy);
        if (isRealId(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }

    const centre = at(cx - x0, cy - y0);
    // Genuine background — a street or the edge of the ámbito — selects nothing.
    if (centre === 0) return null;
    if (isRealId(centre) && (counts.get(centre) ?? 0) >= 2) {
      return colorToId(centre >> 16, (centre >> 8) & 0xff, centre & 0xff);
    }

    // Centre is off-grid or an antialias island — take the nearest colour that is both a
    // real id and actually solid, but only within a 3×3 neighbourhood (squared distance
    // ≤ 2) to avoid snapping to unrelated neighbouring parcels.
    let best = 0;
    let bestDist = Infinity;
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const c = at(ix, iy);
        if (!isRealId(c) || (counts.get(c) ?? 0) < 2) continue;
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
