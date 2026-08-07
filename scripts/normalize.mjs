// Attribute cleaning for the heritage inventory.
//
// Every rule here exists because the source data has a shape that breaks a naive read.
// These are pure functions so the build can be checked without touching the network.

/**
 * padron_sector arrives as "432381 A" — a padron plus an optional sector letter.
 * The permits CSV keys on the bare numeric padron, so the suffix has to come off
 * before any join. Returns null for anything without leading digits.
 */
export function parsePadron(padronSector) {
  if (padronSector == null) return null;
  const digits = String(padronSector).trim().match(/^\d+/);
  return digits ? Number(digits[0]) : null;
}

/**
 * The sector letter, kept separately so a padron split across sectors stays distinguishable.
 * Slices past the leading digits rather than matching them: a regex like /^\d+\s*(.+)$/
 * backtracks on a bare "432381", surrendering the final digit so the capture group can
 * match, and reports a sector of "1".
 */
export function parseSector(padronSector) {
  if (padronSector == null) return null;
  const text = String(padronSector).trim();
  const digits = text.match(/^\d+/);
  if (!digits) return null;
  return text.slice(digits[0].length).trim() || null;
}

/**
 * altura is a STRING, and 92 of the 9016 features carry "Altura especial" rather than a
 * number. Coercing that with Number() yields NaN, and coercing it with parseFloat()||0
 * yields 0 — which would silently flatten those buildings to the ground in the extrusion
 * and drag the low end of the colour ramp. They must stay null and be rendered as their
 * own category.
 */
export function parseAltura(altura) {
  if (altura == null) return null;
  const value = Number(String(altura).trim().replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

// grado_proteccion values are full sentences, e.g.
//   "Grado 3 - Protección Estructural. Edificio que debe ser conservado mejorando..."
// The renderer wants a short stable key; the hover card wants the prose. Parse to both.
const GRADE_PATTERN = /^Grado\s+(\d)/i;

export function parseGrado(grado) {
  if (grado == null) return { code: 'SC', label: 'Sin Catalogar', detail: null };

  const text = String(grado).trim();
  const m = text.match(GRADE_PATTERN);

  if (m) {
    const [head, ...rest] = text.split(/\s+-\s+/);
    const detail = rest.join(' - ').trim() || null;
    // "Grado 3 - Protección Estructural. Edificio que..." -> label "Protección Estructural"
    const shortLabel = detail ? detail.split('.')[0].trim() : head.trim();
    return { code: `G${m[1]}`, label: shortLabel, detail };
  }

  if (/^R[ée]gimen General/i.test(text)) {
    return { code: 'RG', label: 'Régimen General', detail: null };
  }
  return { code: 'SC', label: 'Sin Catalogar', detail: null };
}

/** Ordered for legends and the histogram: least to most protected, then the non-graded classes. */
export const GRADE_ORDER = ['G0', 'G1', 'G2', 'G3', 'G4', 'RG', 'SC', 'NA'];

export const GRADE_NAMES = {
  G0: 'Grado 0 — Sustitución deseable',
  G1: 'Grado 1 — Sustitución posible',
  G2: 'Grado 2 — Protección Ambiental',
  G3: 'Grado 3 — Protección Estructural',
  G4: 'Grado 4 — Protección Integral',
  RG: 'Régimen General',
  SC: 'Sin Catalogar',
  // Outside any heritage inventory boundary — distinct from SC, which means "surveyed,
  // no grade assigned". NA parcels were never surveyed at all.
  NA: 'Fuera del inventario patrimonial',
};

/**
 * POT regulatory fields (ALTURA/FOS/FIS/RETIRO on v_mdg_parcelas) carry the same
 * "string with special-case markers" shape as the Centro inventory's altura — codes like
 * "ALT.ESP.", "9-12", "CEP", "PAU9" mean a variable or special regime, not a number, and
 * must stay null rather than become 0 (same trap as parseAltura, different source table).
 */
export function parsePotNumeric(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const num = Number(text.replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

/**
 * Trim a raw string field to null-or-content. `-` shows up as an explicit "no value"
 * placeholder on some sources (e.g. v_pat_mhn_bienespatrimoniales's AUTORIA/FECHA) but is a
 * real value on others (v_mdg_parcelas's GALIBO uses "-" as one of its 3 actual codes) — so
 * callers pass which placeholder strings apply to their specific field, rather than this
 * guessing a placeholder that isn't confirmed for every source.
 */
export function cleanText(value, placeholders = []) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || placeholders.includes(text)) return null;
  return text;
}

/**
 * Ciudad Vieja's independent per-building survey (pm_bienes_patrimoniales) grades on the same
 * 0-4 scale as Centro's grado_proteccion — confirmed identical against IM's own "Criterios de
 * valoración" legend, so this maps straight onto the existing G0-G4 codes instead of a parallel
 * scale. grado_prot_2010 is the survey's most current snapshot (populated on 1890 of 1891
 * records). Unlike parseGrado there's no sentence to parse — the source is already a plain
 * integer — so this is a lookup, not a regex.
 */
export function parseCvGrado(gradoProt2010) {
  if (gradoProt2010 == null || gradoProt2010 < 0) return { code: 'SC' };
  return { code: `G${gradoProt2010}` };
}
