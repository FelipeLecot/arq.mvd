/**
 * Street centrelines from v_sig_vias, weighted by TIPO.
 *
 * Weights follow the hierarchy the nomenclator itself encodes: an avenida is drawn
 * heavier than a calle, a pasaje lighter, so the street grid carries the same
 * information a reader would get from a printed plan.
 */

const WEIGHTS = {
  AVENIDA: 2.1,
  BULEVAR: 2.1,
  CALLE: 1.1,
  'PASAJE VEHICULAR': 0.7,
  'PASAJE PEATONAL': 0.55,
  PEATONAL: 0.55,
};

const DEFAULT_WEIGHT = 1;

export function streetWeight(tipo) {
  return WEIGHTS[tipo] ?? DEFAULT_WEIGHT;
}

/** Streets sit under the buildings as a ground plane, so they stay quiet. */
export function drawStreets(ctx, lines, t, { zoomK = 1, color = 'rgba(120,132,152,0.34)' } = {}) {
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;

  // Group by weight so the canvas state changes a handful of times, not 900.
  const byWeight = new Map();
  for (const line of lines) {
    const w = streetWeight(line.props.tipo);
    let bucket = byWeight.get(w);
    if (!bucket) byWeight.set(w, (bucket = []));
    bucket.push(line);
  }

  for (const [weight, bucket] of byWeight) {
    // Grow sub-linearly with zoom: at high zoom true-scaled lines would swamp the map.
    ctx.lineWidth = weight * Math.max(0.6, Math.pow(zoomK, 0.45));
    ctx.beginPath();
    for (const line of bucket) {
      for (const part of line.parts) {
        ctx.moveTo(part[0] * t.a + t.bx, -part[1] * t.a + t.by);
        for (let i = 2; i < part.length; i += 2) {
          ctx.lineTo(part[i] * t.a + t.bx, -part[i + 1] * t.a + t.by);
        }
      }
    }
    ctx.stroke();
  }
}

/** The ámbito outline — the edge of what this atlas actually covers. */
export function drawAmbito(ctx, path, ambito) {
  ctx.save();
  ctx.strokeStyle = 'rgba(233,227,213,0.22)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  path(ambito);
  ctx.stroke();
  ctx.restore();
}
