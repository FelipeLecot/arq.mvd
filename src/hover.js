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

    root.hidden = false;
  }

  return { show, showBlock, hide };
}
