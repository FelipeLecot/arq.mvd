/**
 * Distribution of the active attribute, with a brush that highlights matching parcels
 * citywide. This is the linked view the whole thing is built around — it is what a
 * mapping library would not give you.
 */

import { select, scaleBand, scaleLinear, brushX, max } from 'd3';
import { ATTRIBUTES, ALTURA_ESPECIAL, PERMIT_BUCKETS } from './scales.js';

const MARGIN = { top: 4, right: 8, bottom: 16, left: 8 };
const BAR_GAP = 2; // the 2px surface gap between adjacent fills

/** Bin the values into drawable bars for the active attribute. */
export function buildBins(attrName, values) {
  const spec = ATTRIBUTES[attrName];

  if (spec.categorical) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return spec.order
      .filter((k) => counts.has(k))
      .map((k) => ({
        key: k,
        label: k,
        count: counts.get(k),
        color: spec.color(k),
        match: (v) => v === k,
      }));
  }

  if (attrName === 'altura') {
    const numeric = values.filter((v) => v != null);
    const distinct = [...new Set(numeric)].sort((a, b) => a - b);
    const bins = distinct.map((h) => ({
      key: h,
      label: String(h),
      count: numeric.filter((v) => v === h).length,
      color: spec.color(h),
      match: (v) => v === h,
    }));
    const especial = values.length - numeric.length;
    if (especial) {
      bins.push({
        key: 'especial',
        label: 'esp.',
        count: especial,
        color: ALTURA_ESPECIAL,
        match: (v) => v == null,
        detached: true,
      });
    }
    return bins;
  }

  // Permits: an explicit zero bar, then small integer buckets.
  return PERMIT_BUCKETS
    .map((b) => ({
      key: b.key,
      label: b.short,
      count: values.filter((v) => (v ?? 0) >= b.lo && (v ?? 0) <= b.hi).length,
      color: spec.color(b.lo),
      match: (v) => (v ?? 0) >= b.lo && (v ?? 0) <= b.hi,
    }))
    .filter((b) => b.count > 0);
}

export function createHistogram(svgEl, { onSelect }) {
  const svg = select(svgEl);
  let bins = [];
  let scaleX;

  function render(nextBins) {
    bins = nextBins;
    const rect = svgEl.getBoundingClientRect();
    const width = Math.max(120, rect.width);
    const height = Math.max(40, rect.height);
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = height - MARGIN.top - MARGIN.bottom;

    svg.attr('viewBox', `0 0 ${width} ${height}`).selectAll('*').remove();
    if (!bins.length) return;

    scaleX = scaleBand()
      .domain(bins.map((b) => b.key))
      .range([MARGIN.left, MARGIN.left + innerW])
      .paddingInner(0);

    const scaleY = scaleLinear()
      .domain([0, max(bins, (b) => b.count)])
      .nice()
      .range([MARGIN.top + innerH, MARGIN.top]);

    const g = svg.append('g');
    const bw = Math.max(1, scaleX.bandwidth() - BAR_GAP);

    g.selectAll('rect.bar')
      .data(bins)
      .join('rect')
      .attr('class', 'bar')
      .attr('x', (d) => scaleX(d.key))
      .attr('y', (d) => scaleY(d.count))
      .attr('width', bw)
      .attr('height', (d) => MARGIN.top + innerH - scaleY(d.count))
      .attr('rx', 1.5)
      .attr('fill', (d) => d.color)
      .attr('opacity', (d) => (d.detached ? 0.85 : 1));

    // Baseline
    g.append('line')
      .attr('class', 'axis-line')
      .attr('x1', MARGIN.left)
      .attr('x2', MARGIN.left + innerW)
      .attr('y1', MARGIN.top + innerH + 0.5)
      .attr('y2', MARGIN.top + innerH + 0.5);

    // Label only what fits, so the axis never becomes a smear.
    const step = Math.ceil((bins.length * 26) / innerW);
    g.selectAll('text.tick')
      .data(bins.filter((_, i) => i % step === 0))
      .join('text')
      .attr('class', 'tick')
      .attr('x', (d) => scaleX(d.key) + bw / 2)
      .attr('y', height - 4)
      .attr('text-anchor', 'middle')
      .text((d) => d.label);

    const brush = brushX()
      .extent([
        [MARGIN.left, MARGIN.top],
        [MARGIN.left + innerW, MARGIN.top + innerH],
      ])
      .on('end', ({ selection }) => {
        if (!selection) {
          onSelect(null);
          return;
        }
        const [x0, x1] = selection;
        const picked = bins.filter((b) => {
          const bx = scaleX(b.key);
          return bx + scaleX.bandwidth() > x0 && bx < x1;
        });
        onSelect(picked.length ? picked : null);
      });

    const brushG = g.append('g').attr('class', 'brush').call(brush);
    brushG.select('.selection').attr('fill', '#FFD873').attr('fill-opacity', 0.14).attr('stroke', '#FFD873').attr('stroke-opacity', 0.5);
    brushG.selectAll('.handle').attr('fill', '#FFD873').attr('fill-opacity', 0.35);
  }

  return { render, clear: () => svg.select('.brush').call(brushX().clear) };
}
