import { legendRows, ATTRIBUTES } from './scales.js';

const fmt = new Intl.NumberFormat('es-UY');

export function renderLegend(titleEl, listEl, attrName, values) {
  const spec = ATTRIBUTES[attrName];
  titleEl.textContent = spec.legendTitle;

  const rows = legendRows(attrName, values);
  listEl.replaceChildren(
    ...rows.map((row) => {
      const li = document.createElement('li');

      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = row.color;

      const label = document.createElement('span');
      label.className = 'legend__label';
      label.textContent = row.label;
      if (row.title) label.title = row.title;

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = fmt.format(row.count);

      li.append(swatch, label, count);
      return li;
    }),
  );
}
