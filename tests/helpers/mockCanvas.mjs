// A software rasterizer standing in for CanvasRenderingContext2D, scoped to exactly the
// surface src/render/parcels.js and src/picking.js use: path building (moveTo/lineTo/
// closePath), fill('nonzero'|'evenodd'), stroke() with lineWidth, fillRect, getImageData.
//
// Antialiasing is computed for real via subpixel supersampling rather than faked, because
// the picking bug under investigation is specifically about how PickingLayer.pick()
// responds to real antialiased edge pixels — a mock that just wrote solid colours with no
// blended boundary pixels couldn't exercise that code path at all.

const SS = 4; // supersamples per axis -> 16 samples/pixel, plenty for a few-px-wide scene

function parseColor(style) {
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(style);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  if (style === '#000' || style === '#000000') return [0, 0, 0];
  throw new Error(`mockCanvas: unsupported color "${style}"`);
}

/** Ray-cast a subsample point against a set of pre-closed subpaths (nonzero or evenodd). */
function pointInSubpaths(px, py, subpaths, evenodd) {
  let winding = 0;
  let crossings = 0;
  for (const sp of subpaths) {
    for (let i = 0; i < sp.length - 1; i++) {
      const [x1, y1] = sp[i];
      const [x2, y2] = sp[i + 1];
      if ((y1 <= py) !== (y2 <= py)) {
        const xCross = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1);
        if (xCross > px) {
          crossings++;
          winding += y2 > y1 ? 1 : -1;
        }
      }
    }
  }
  return evenodd ? crossings % 2 !== 0 : winding !== 0;
}

function distSqToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

export function createMockContext(width, height) {
  const buf = new Uint8ClampedArray(width * height * 4); // starts fully transparent

  let paths = [];
  let current = null;

  function closeSubpath(sp) {
    const [x0, y0] = sp[0];
    const [xl, yl] = sp[sp.length - 1];
    if (x0 !== xl || y0 !== yl) sp.push([x0, y0]);
  }

  // Standard "paint an opaque-coverage sample over whatever's there" compositing — every
  // real frame clears to opaque black first (picking.clear()), so dest alpha is always 1
  // by the time fill/stroke run; this still behaves correctly if it isn't.
  function setPixel(x, y, rgb, coverage) {
    if (x < 0 || y < 0 || x >= width || y >= height || coverage <= 0) return;
    const i = (y * width + x) * 4;
    const destA = buf[i + 3] / 255;
    const outA = coverage + destA * (1 - coverage);
    if (outA === 0) return;
    for (let c = 0; c < 3; c++) {
      buf[i + c] = Math.round(
        (rgb[c] * coverage + buf[i + c] * destA * (1 - coverage)) / outA,
      );
    }
    buf[i + 3] = Math.round(outA * 255);
  }

  function bboxOf(points, pad) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      x0: Math.max(0, Math.floor(minX - pad)),
      y0: Math.max(0, Math.floor(minY - pad)),
      x1: Math.min(width - 1, Math.ceil(maxX + pad)),
      y1: Math.min(height - 1, Math.ceil(maxY + pad)),
    };
  }

  const ctx = {
    canvas: { width, height },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'round',

    beginPath() {
      paths = [];
      current = null;
    },
    moveTo(x, y) {
      current = [[x, y]];
      paths.push(current);
    },
    lineTo(x, y) {
      if (!current) {
        current = [[x, y]];
        paths.push(current);
      } else {
        current.push([x, y]);
      }
    },
    closePath() {
      if (current && current.length > 1) closeSubpath(current);
    },

    fillRect(x, y, w, h) {
      const rgb = parseColor(ctx.fillStyle);
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) setPixel(xx, yy, rgb, 1);
    },

    fill(rule) {
      const evenodd = rule === 'evenodd';
      const closed = paths.filter((sp) => sp.length > 2).map((sp) => {
        const c = sp.slice();
        closeSubpath(c);
        return c;
      });
      if (!closed.length) return;
      const rgb = parseColor(ctx.fillStyle);
      const all = closed.flat();
      const { x0, y0, x1, y1 } = bboxOf(all, 1);
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          let hits = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const qx = px + (sx + 0.5) / SS;
              const qy = py + (sy + 0.5) / SS;
              if (pointInSubpaths(qx, qy, closed, evenodd)) hits++;
            }
          }
          if (hits > 0) setPixel(px, py, rgb, hits / (SS * SS));
        }
      }
    },

    stroke() {
      const segs = [];
      for (const sp of paths) {
        for (let i = 0; i < sp.length - 1; i++) segs.push([sp[i], sp[i + 1]]);
      }
      if (!segs.length) return;
      const rgb = parseColor(ctx.strokeStyle);
      const half = ctx.lineWidth / 2;
      const all = segs.flat();
      const { x0, y0, x1, y1 } = bboxOf(all, half + 1);
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          let hits = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const qx = px + (sx + 0.5) / SS;
              const qy = py + (sy + 0.5) / SS;
              let inside = false;
              for (const [[x1s, y1s], [x2s, y2s]] of segs) {
                if (distSqToSeg(qx, qy, x1s, y1s, x2s, y2s) <= half * half) {
                  inside = true;
                  break;
                }
              }
              if (inside) hits++;
            }
          }
          if (hits > 0) setPixel(px, py, rgb, hits / (SS * SS));
        }
      }
    },

    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const sxp = x + xx;
          const syp = y + yy;
          if (sxp < 0 || syp < 0 || sxp >= width || syp >= height) continue;
          const si = (syp * width + sxp) * 4;
          const di = (yy * w + xx) * 4;
          data[di] = buf[si];
          data[di + 1] = buf[si + 1];
          data[di + 2] = buf[si + 2];
          data[di + 3] = buf[si + 3];
        }
      }
      return { data };
    },
  };

  return ctx;
}
