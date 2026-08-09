/**
 * The title block — this atlas's hover card.
 *
 * Modelled on the ruled block in the corner of an architectural drawing: small tracked
 * field labels, mono values, and a colour bar carrying the parcel's grade. It shows the
 * fields a survey sheet carries, in the register's own vocabulary.
 *
 * Below the block-merge LOD threshold (src/main.js), hovering shows a manzana's
 * aggregate stats instead of one padrón's — showBlock() reuses the same DOM by
 * relabeling the padrón/dirección rows rather than adding new markup.
 */

import { GRADE_COLORS, GRADE_LABELS, ATTRIBUTES } from './scales.js';

/** Safe positional read: null if the array itself is missing (e.g. an older attrs.json
 * that predates this field), not just if the value at this id is null. */
function at(arr, id) {
  return arr ? arr[id] ?? null : null;
}

/** One <dl> of label/value rows, skipping null values; null if nothing survives. */
function buildRows(pairs) {
  const present = pairs.filter(([, value]) => value != null);
  if (!present.length) return null;
  const dl = document.createElement('dl');
  for (const [label, value] of present) {
    const row = document.createElement('div');
    row.className = 'tb-row';
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    row.append(dt, dd);
    dl.appendChild(row);
  }
  return dl;
}

/** A titled group of rows, or null if every field in `pairs` is null for this parcel. */
function buildGroup(title, pairs) {
  const dl = buildRows(pairs);
  if (!dl) return null;
  const group = document.createElement('div');
  group.className = 'tb-extra-group';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  group.append(h3, dl);
  return group;
}

/** "G0"..."G4" for a valid grade index, otherwise the raw number as a fallback. */
function gradeCode(n) {
  const code = `G${n}`;
  return GRADE_LABELS[code] ? code : String(n);
}

/**
 * Ciudad Vieja's own building name + grade-history line (1983 → 2000 → 2010), reusing the
 * shared grade-code vocabulary rather than showing raw integers. -1 in the 1983/2000
 * snapshots means "not classified that year" (docs/superpowers/specs/
 * 2026-08-07-heritage-data-expansion-design.md §3) and is treated the same as null.
 */
function buildCvGroup(id, attrs) {
  const nameAct = at(attrs.cvBuildingName, id);
  const nameOri = at(attrs.cvBuildingNameOrig, id);
  const isCv = at(attrs.gradoSource, id) === 'ciudad-vieja';
  if (nameAct == null && nameOri == null && !isCv) return null;

  const pairs = [];
  if (nameAct != null && nameOri != null && nameAct !== nameOri) {
    pairs.push(['Nombre actual', nameAct], ['Nombre original', nameOri]);
  } else if (nameAct != null || nameOri != null) {
    pairs.push(['Nombre del edificio', nameAct ?? nameOri]);
  }

  const history = [];
  const g1983 = at(attrs.cvGrado1983, id);
  const g2000 = at(attrs.cvGrado2000, id);
  if (g1983 != null && g1983 >= 0) history.push(`1983 ${gradeCode(g1983)}`);
  if (g2000 != null && g2000 >= 0) history.push(`2000 ${gradeCode(g2000)}`);
  if (isCv) history.push(`2010 ${attrs.grado[id]} (actual)`);
  if (history.length) pairs.push(['Grado histórico', history.join(' · ')]);

  return buildGroup('Ciudad Vieja — relevamiento', pairs);
}

export function createTitleBlock(root) {
  const el = {
    root,
    gradebar: root.querySelector('#tb-gradebar'),
    padronLabel: root.querySelector('#tb-padron-label'),
    padron: root.querySelector('#tb-padron'),
    addressLabel: root.querySelector('#tb-address-label'),
    address: root.querySelector('#tb-address'),
    altura: root.querySelector('#tb-altura'),
    permits: root.querySelector('#tb-permits'),
    grado: root.querySelector('#tb-grado'),
    detail: root.querySelector('#tb-detail'),
    extra: root.querySelector('#tb-extra'),
  };

  function hide() {
    root.hidden = true;
  }

  function show(id, attrs) {
    const grade = attrs.grado[id];
    const altura = attrs.altura[id];
    const permits = attrs.permits[id];
    const sector = attrs.sector[id];
    const lastYear = attrs.lastPermitYear[id];

    el.padronLabel.textContent = 'Padrón';
    el.addressLabel.textContent = 'Dirección';

    el.gradebar.style.background = GRADE_COLORS[grade] ?? GRADE_COLORS.SC;
    el.padron.textContent = sector ? `${attrs.padron[id]} ${sector}` : String(attrs.padron[id]);
    el.address.textContent = attrs.address[id] ?? 'Sin dirección registrada';

    // "Altura especial" is a real regime, not missing data — name it as such.
    el.altura.textContent = altura == null ? 'Especial' : `${altura} m`;
    el.altura.title = altura == null ? '' : ATTRIBUTES.altura.note;

    el.permits.textContent = permits
      ? `${permits}${lastYear ? ` · última ${lastYear}` : ''}`
      : 'Ninguna';

    el.grado.textContent = GRADE_LABELS[grade] ?? grade;
    el.detail.textContent = attrs.gradoDetail[id] ?? '';

    const groups = [];
    const heritageGroup = buildGroup('Declaratoria patrimonial', [
      ['Nombre', at(attrs.heritageName, id)],
      ['Arquitecto', at(attrs.architect, id)],
      ['Año', at(attrs.builtDate, id)],
      ['Declaratoria', at(attrs.heritageDeclaration, id)],
      ['Tipo de protección', at(attrs.protectionType, id)],
      ['Decreto', at(attrs.decreto, id)],
    ]);
    if (heritageGroup) groups.push(heritageGroup);

    const cvGroup = buildCvGroup(id, attrs);
    if (cvGroup) groups.push(cvGroup);

    el.extra.replaceChildren(...groups);

    root.hidden = false;
  }

  function showBlock(id, blockAttrs) {
    const grade = blockAttrs.grado[id];
    const sharePct = blockAttrs.gradoSharePct[id];
    const altura = blockAttrs.altura[id];
    const permits = blockAttrs.permits[id];
    const parcelCount = blockAttrs.parcelCount[id];

    el.padronLabel.textContent = 'Manzana';
    el.addressLabel.textContent = 'Grado predominante';

    el.gradebar.style.background = GRADE_COLORS[grade] ?? GRADE_COLORS.SC;
    el.padron.textContent = `${parcelCount} padrones`;
    el.address.textContent = `${GRADE_LABELS[grade] ?? grade} · ${sharePct}%`;

    el.altura.textContent = altura == null ? 'Especial' : `${altura.toFixed(1)} m prom.`;
    el.altura.title = altura == null ? '' : ATTRIBUTES.altura.note;

    el.permits.textContent = `${permits.toFixed(1)} prom.`;

    el.grado.textContent = 'Vista de manzana — acercate para ver cada padrón';
    el.detail.textContent = '';
    el.extra.replaceChildren();

    root.hidden = false;
  }

  return { show, showBlock, hide };
}
