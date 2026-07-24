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

  /** Read the feature id under a CSS-pixel coordinate, or null. */
  pick(x, y) {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return null;
    const [r, g, b] = this.ctx.getImageData(px, py, 1, 1).data;
    return colorToId(r, g, b);
  }
}
