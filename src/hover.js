/**
 * The title block — this atlas's hover card.
 *
 * Modelled on the ruled block in the corner of an architectural drawing: small tracked
 * field labels, mono values, and a colour bar carrying the parcel's grade. It shows the
 * fields a survey sheet carries, in the register's own vocabulary.
 */

import { GRADE_COLORS, GRADE_LABELS, ATTRIBUTES } from './scales.js';

export function createTitleBlock(root) {
  const el = {
    root,
    gradebar: root.querySelector('#tb-gradebar'),
    padron: root.querySelector('#tb-padron'),
    address: root.querySelector('#tb-address'),
    altura: root.querySelector('#tb-altura'),
    permits: root.querySelector('#tb-permits'),
    grado: root.querySelector('#tb-grado'),
    detail: root.querySelector('#tb-detail'),
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

    root.hidden = false;
  }

  return { show, hide };
}
