/**
 * Hit-testing via a hidden picking canvas: every parcel is drawn in a unique RGB id
 * colour, and a hover reads one pixel. O(1) regardless of feature count.
 *
 * The picking canvas is redrawn by the same code path as the visible map, at the same
 * transform and — critically — with the same extrusion offset applied to the roof.
 * If picking drew the flat footprint while the eye saw a lifted roof, every hover on an
 * extruded building would be wrong by the height of the building.
 */

const CHANNEL_BITS = 24; // 3 x 8-bit RGB channels
const SPACE = 1 << CHANNEL_BITS; // 16,777,216 packed values, 0 reserved for background

/**
 * Ids are NOT packed as consecutive integers (`id + 1`). Canvas antialiases every path
 * edge, and a fill/stroke pair drawn over an already-opaque neighbour blends the two RGB
 * colours at whatever fractional coverage the rasterizer computed —
 * round(colourA*coverage + colourB*(1-coverage)) is, in general, some THIRD packed value.
 * With consecutive packing every value in range belongs to some real feature, so that
 * blended value was *always* another real, arbitrary id: every antialiased edge pixel
 * decoded to a parcel unrelated to either true neighbour, silently, 100% of the time a
 * blend occurred (and at city zoom ~44% of foreground pixels are blends).
 *
 * An earlier version of this fix multiplied the packed value by a constant spacing factor
 * and rejected non-multiples. That doesn't work: `r<<16` and `g<<8` are themselves
 * multiples of 256, and 256 is a multiple of any modest spacing factor, so "is this a
 * multiple of SPACING" collapses to a check on the low byte alone — worth far less than
 * the spacing implied (measured 9.9% of blended picks still wrong, not ~3%), because
 * antialiasing blends each RGB channel independently and two channels' worth of garbage
 * passed straight through unexamined.
 *
 * PACK_MULT below is an odd 24-bit constant, so multiplying by it mod 2^24 is a bijection
 * (gcd(odd, 2^24) = 1) that scrambles an id's bits across R, G and B roughly uniformly —
 * there is no single cheap channel or bitmask a blend can coincidentally satisfy. But a
 * scrambled *arithmetic* code alone still only pushes the collision odds down to "how many
 * real ids exist, out of how many packed values" — measurably better (dropped the
 * adversarial 20x20-shuffled-grid failure rate in tests/picking.test.mjs from ~36% of
 * blended picks pre-fix to a small handful of real collisions per run — down from 9.9%
 * under an earlier, flawed version of this spacing idea that turned out to only examine
 * one colour channel, see below) but not zero, and not verifiable from the arithmetic
 * alone. So `PickingLayer` also tracks the *exact* set of ids actually painted into the
 * buffer this frame (`setPaintedIds`, called from src/main.js's refreshPicking right after
 * drawPicking) and `pick()` requires both that membership *and* a local plurality vote
 * (see its own docstring) before trusting a colour — together, verified at 0 violations
 * across 9 adversarial shuffles/densities (see task-3-report.md).
 */
const PACK_MULT = 0x9e3779b1 & (SPACE - 1); // Knuth's multiplicative hash constant, masked to 24 bits (still odd)

function packId(id) {
  // +1 so id 0 never packs to 0, which is the "nothing here" background sentinel.
  return ((id + 1) * PACK_MULT) % SPACE;
}

// Modular inverse of PACK_MULT mod SPACE (extended Euclidean algorithm; SPACE is a power
// of two so this always terminates in a handful of steps). Lets colorToId() do a pure,
// context-free decode — used by tests and diagnostics; PickingLayer.pick() itself relies
// on the stronger per-frame membership check above, not on this alone.
function modInverse(a, m) {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}
const PACK_MULT_INV = modInverse(PACK_MULT, SPACE);

export function idToColor(id) {
  const n = packId(id);
  return `rgb(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff})`;
}

/**
 * Pure decode of a packed colour back to a feature id, or null for the background
 * sentinel (0). Context-free: unlike PickingLayer.pick(), this has no notion of which ids
 * are actually on screen this frame, so a value that arose from blending two real colours
 * together will still decode to *some* id here — this is a diagnostic/test utility, not
 * the thing that makes hit-testing correct. See PICK_MULT's docstring above.
 */
export function colorToId(r, g, b) {
  const n = (r << 16) | (g << 8) | b;
  if (n === 0) return null;
  return ((n * PACK_MULT_INV) % SPACE) - 1;
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
   * Record exactly which ids were painted into the buffer this frame (src/main.js's
   * `order` — the same array passed to drawPicking), so pick() can validate a decoded
   * colour against reality instead of trusting arithmetic alone. See PACK_MULT's docstring
   * at the top of this file for why arithmetic alone isn't enough.
   */
  setPaintedIds(ids) {
    const byColor = new Map();
    for (const id of ids) byColor.set(packId(id), id);
    this.paintedColorToId = byColor;
  }

  /**
   * Read the feature id under a CSS-pixel coordinate, or null.
   *
   * Canvas antialiases every polygon edge, so a boundary pixel's colour is a blend of
   * whatever was drawn there — at city zoom roughly 44% of foreground pixels are such
   * blends. Two independent defences, not one:
   *
   * 1. `this.paintedColorToId` (see setPaintedIds) only recognises the *exact* colours of
   *    ids actually drawn this frame — see PACK_MULT's docstring for why a blend needs a
   *    real coincidence, not just an off-grid arithmetic slip, to pass this.
   * 2. Even a colour that does pass #1 might be a genuine blend that happens to reproduce
   *    another real, currently-visible id's exact colour — rare, but with hundreds of ids
   *    painted in one frame, "rare" still shows up in practice: the adversarial 20x20
   *    dense-grid test in tests/picking.test.mjs hit several such collisions per run before
   *    this second defence existed (traced one by hand — a solid 1x3-pixel block, 60+px
   *    from the id it decoded to, on a shared edge between two *different* real ids).
   *    That kind of collision is a thin antialiased band at best (a stroke's own ~1.5px
   *    edge, or a fill boundary) — a real parcel's *interior*, away from any edge, dominates
   *    its own neighbourhood far more than any accidental blend can. So this doesn't just
   *    check "does this colour repeat at least twice nearby" (that's satisfiable by a
   *    1-3px accidental band) — it takes the colour with the MOST repeats within a
   *    3×3-ish neighbourhood (squared distance ≤ 2, ties broken by distance), which a
   *    coincidental collision essentially never wins against the true owner's much larger
   *    real interior. Verified empirically: 0 violations across a full-canvas sweep of
   *    that adversarial grid, repeated over 9 different shuffles/densities (see the test
   *    and task-3-report.md).
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
    const painted = this.paintedColorToId;
    // Background (0) or a colour nobody was assigned this frame both mean "not a real,
    // uncontaminated id here" — see setPaintedIds. Neither is ever a candidate answer, and
    // neither counts toward another colour's tally.
    const isReal = (c) => c !== 0 && painted != null && painted.has(c);

    // Genuine background — a street or the edge of the ámbito — selects nothing.
    if (at(cx - x0, cy - y0) === 0) return null;

    const counts = new Map();
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const c = at(ix, iy);
        if (isReal(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }

    // Plurality vote within a 3×3-ish neighbourhood (squared distance ≤ 2, matching the
    // old "don't snap to unrelated neighbouring parcels" radius): the colour with the most
    // repeats wins, ties broken by nearest to the query point. Requiring ≥2 repeats still
    // rejects one-pixel antialias islands outright, same as before.
    const ccx = cx - x0;
    const ccy = cy - y0;
    let best = null;
    let bestCount = 0;
    let bestDist = Infinity;
    for (let iy = 0; iy < h; iy++) {
      for (let ix = 0; ix < w; ix++) {
        const c = at(ix, iy);
        const count = counts.get(c) ?? 0;
        if (!isReal(c) || count < 2) continue;
        const dx = ix - ccx;
        const dy = iy - ccy;
        const d = dx * dx + dy * dy;
        if (d > 2) continue;
        if (count > bestCount || (count === bestCount && d < bestDist)) {
          bestCount = count;
          bestDist = d;
          best = c;
        }
      }
    }
    return best == null ? null : painted.get(best);
  }
}
