import { scaleLinear, scaleThreshold } from 'd3';

// Three single-hue ramps, each validated against the #0E1219 ground for monotone
// lightness, adjacent-step separation, and light-end contrast.
//
// The grade ramp is ordinal and carries the register's own value judgement: dim umber
// at Grado 0 ("sustitución deseable") to bright gold at Grado 4 ("protección
// integral"). Régimen General and Sin Catalogar sit deliberately OFF the ramp in
// neutral slate — they are not a low grade, they are unassessed.

export const GRADE_COLORS = {
  G0: '#5F5241',
  G1: '#7E6746',
  G2: '#9F7F42',
  G3: '#CB9E42',
  G4: '#FFD873',
  // Off-ramp neutrals. These are NOT a low grade — they are parcels the inventory did
  // not grade — so they stay neutral while the graded ramp carries the warmth. They sit
  // above a 2:1 contrast floor against the ground: at 1.58:1 the old Régimen General
  // read as missing data, which it is not (it is 43% of Centro).
  RG: '#414E61',
  SC: '#4A4750',
  // Outside any heritage inventory boundary (citywide parcels sourced only from the POT
  // envelope). Distinct from SC — that means "surveyed, no grade"; this means "never
  // surveyed" — so it gets its own neutral rather than being folded into SC's.
  NA: '#4D473F',
};

export const GRADE_ORDER = ['G0', 'G1', 'G2', 'G3', 'G4', 'RG', 'SC', 'NA'];

export const GRADE_LABELS = {
  G0: 'Grado 0 · Sustitución deseable',
  G1: 'Grado 1 · Sustitución posible',
  G2: 'Grado 2 · Protección ambiental',
  G3: 'Grado 3 · Protección estructural',
  G4: 'Grado 4 · Protección integral',
  RG: 'Régimen general',
  SC: 'Sin catalogar',
  NA: 'Fuera del inventario patrimonial',
};

/** Short forms for the legend, where a wrapped row would push rows out of the rail. */
export const GRADE_LABELS_SHORT = {
  G0: 'G0 · Sustitución deseable',
  G1: 'G1 · Sustitución posible',
  G2: 'G2 · Protección ambiental',
  G3: 'G3 · Protección estructural',
  G4: 'G4 · Protección integral',
  RG: 'Régimen general',
  SC: 'Sin catalogar',
  NA: 'Fuera del inventario',
};

const ALTURA_STEPS = ['#33506B', '#4A7194', '#6E9CBE', '#A3C6DE', '#DCE9F2'];
// Domain cuts follow the actual distribution: 9, 11, 16.5, 27 and 36 m dominate.
const alturaScale = scaleThreshold().domain([12, 18, 25, 31]).range(ALTURA_STEPS);

/** "Altura especial" — 92 parcels with no numeric envelope. Deliberately off-ramp. */
export const ALTURA_ESPECIAL = '#8A6E9E';

const PERMIT_STEPS = ['#2F5D52', '#417F6F', '#63A692', '#98CBB9', '#D3EAE0'];
const permitScale = scaleThreshold().domain([1, 2, 4, 8]).range(PERMIT_STEPS);

/** One bucket definition, shared by the legend and the histogram so they never diverge. */
export const PERMIT_BUCKETS = [
  { key: '0', label: 'sin permisos', short: '0', lo: 0, hi: 0 },
  { key: '1', label: '1 permiso', short: '1', lo: 1, hi: 1 },
  { key: '2-3', label: '2–3 permisos', short: '2–3', lo: 2, hi: 3 },
  { key: '4-7', label: '4–7 permisos', short: '4–7', lo: 4, hi: 7 },
  { key: '8+', label: '8 o más', short: '8+', lo: 8, hi: Infinity },
];

/**
 * Parcels with no permit at all: the 79% majority. Recessive, so the rebuilt city reads
 * against it, but light enough that the urban fabric is still legible — this is a true
 * zero ("no permit since 1997"), not missing data.
 */
export const NO_PERMIT = '#333D49';

export const ATTRIBUTES = {
  grado: {
    label: 'Protección',
    legendTitle: 'Grado de protección',
    color: (v) => GRADE_COLORS[v] ?? GRADE_COLORS.SC,
    categorical: true,
    order: GRADE_ORDER,
    labelOf: (v) => GRADE_LABELS[v] ?? v,
    note: 'Decreto 39.085 — Inventario Patrimonial del Centro.',
  },
  altura: {
    label: 'Altura',
    legendTitle: 'Altura normativa',
    color: (v) => (v == null ? ALTURA_ESPECIAL : alturaScale(v)),
    categorical: false,
    steps: ALTURA_STEPS,
    thresholds: [12, 18, 25, 31],
    format: (v) => (v == null ? 'Altura especial' : `${v} m`),
    // The honest caveat, stated wherever height is shown.
    note: 'Máximo legal edificable, no altura construida.',
  },
  permits: {
    label: 'Obras',
    legendTitle: 'Permisos desde 1997',
    color: (v) => (v > 0 ? permitScale(v) : NO_PERMIT),
    categorical: false,
    steps: PERMIT_STEPS,
    thresholds: [1, 2, 4, 8],
    format: (v) => (v === 1 ? '1 permiso' : `${v} permisos`),
    note: 'Permisos aprobados 1997–2026; no es fecha de construcción.',
  },
};

/** Legend rows for the active attribute, with counts drawn from the data. */
export function legendRows(attrName, values) {
  const spec = ATTRIBUTES[attrName];

  if (spec.categorical) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return spec.order
      .filter((k) => counts.has(k))
      .map((k) => ({
        color: spec.color(k),
        label: GRADE_LABELS_SHORT[k] ?? spec.labelOf(k),
        title: spec.labelOf(k),
        count: counts.get(k),
      }));
  }

  if (attrName === 'permits') {
    return PERMIT_BUCKETS.map((b) => ({
      color: spec.color(b.lo),
      label: b.label,
      count: values.filter((v) => (v ?? 0) >= b.lo && (v ?? 0) <= b.hi).length,
    })).filter((r) => r.count > 0);
  }

  const { thresholds, steps } = spec;
  const rows = steps.map((color, i) => {
    const lo = i === 0 ? null : thresholds[i - 1];
    const hi = thresholds[i] ?? null;
    const label =
      lo == null ? `menos de ${hi} m` : hi == null ? `${lo} m o más` : `${lo}–${hi} m`;
    return { color, label, count: 0 };
  });

  for (const v of values) {
    if (v == null) continue;
    const color = spec.color(v);
    const row = rows.find((r) => r.color === color);
    if (row) row.count++;
  }

  const especial = values.filter((v) => v == null).length;
  if (especial) rows.push({ color: ALTURA_ESPECIAL, label: 'altura especial', count: especial });

  return rows.filter((r) => r.count > 0);
}

export { scaleLinear };
