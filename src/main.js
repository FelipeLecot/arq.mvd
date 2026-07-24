import { select, zoom as d3zoom, zoomIdentity, geoPath } from 'd3';
import { loadAtlas } from './data.js';
import { createProjection } from './projection.js';
import { prepareFeatures, prepareLines, screenTransform } from './render/geometry.js';
import { drawParcels, paintOrder } from './render/parcels.js';
import { drawStreets, drawAmbito } from './render/streets.js';
import { drawLabels } from './render/labels.js';
import { PickingLayer, idToColor } from './picking.js';
import { ATTRIBUTES } from './scales.js';
import { renderLegend } from './legend.js';
import { createHistogram, buildBins } from './histogram.js';
import { createTitleBlock } from './hover.js';

/**
 * Height exaggeration, tapered by zoom.
 *
 * Zoomed out, a 27 m envelope is a couple of pixels and the volume reads as noise, so it
 * is lifted. Zoomed in, the reader can judge height against the parcel it stands on, and
 * any exaggeration would simply be a lie — so it relaxes to true scale.
 */
function exaggerationFor(k) {
  return Math.min(2.4, Math.max(1, 2.4 / Math.pow(k, 0.38)));
}

const state = {
  attr: 'grado',
  extrude: true,
  transform: zoomIdentity,
  hoveredId: null,
  selected: null,
  interacting: false,
  needsRedraw: true,
};

const mapCanvas = document.getElementById('map');
const overlayCanvas = document.getElementById('overlay');
const mapCtx = mapCanvas.getContext('2d');
const stage = document.querySelector('.stage');
const hint = document.getElementById('hint');
const picking = new PickingLayer();
const titleBlock = createTitleBlock(document.getElementById('titleblock'));

const fmt = new Intl.NumberFormat('es-UY');

let atlas;
let items;
let lines;
let order;
let projection;
let path;
let idColors;
let colors;
let heights;
let histogram;
let dpr = 1;

function sizeCanvases() {
  const rect = stage.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (const canvas of [mapCanvas, overlayCanvas]) {
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
  }
  picking.resize(rect.width, rect.height, dpr);

  projection = createProjection(atlas.ambito, rect.width, rect.height);
  path = geoPath(projection, mapCtx);
  state.needsRedraw = true;
}

/** Recompute the per-parcel colour array. Geometry is untouched. */
function applyAttribute() {
  const spec = ATTRIBUTES[state.attr];
  const values = valuesFor(state.attr);
  colors = values.map((v) => spec.color(v));

  renderLegend(
    document.getElementById('legend-title'),
    document.getElementById('legend-items'),
    state.attr,
    values,
  );

  document.getElementById('hist-title').textContent = spec.legendTitle;
  document.getElementById('hist-note').textContent = spec.note;
  histogram.render(buildBins(state.attr, values));

  state.selected = null;
  document.getElementById('hist-clear').hidden = true;
  state.needsRedraw = true;
}

function valuesFor(attr) {
  if (attr === 'grado') return atlas.attrs.grado;
  if (attr === 'altura') return atlas.attrs.altura;
  return atlas.attrs.permits;
}

function redraw() {
  const rect = stage.getBoundingClientRect();
  const t = screenTransform(projection, state.transform);

  mapCtx.save();
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapCtx.clearRect(0, 0, rect.width, rect.height);

  // Hit-testing mid-gesture is meaningless — the pointer is dragging, not pointing — so
  // the picking canvas is left stale until the view settles. That halves the work in the
  // frames that need to be fast.
  const updatePicking = !state.interacting;
  if (updatePicking) picking.clear();

  drawStreets(mapCtx, lines, t, { zoomK: state.transform.k });
  drawAmbito(mapCtx, path, atlas.ambito);

  // Extruding all 9,016 parcels costs far more than a frame at city scale, so an
  // active pan or zoom draws the flat map and the volume returns the moment the
  // gesture settles. Zoomed in, culling makes extrusion cheap enough to keep live.
  const liveExtrude =
    state.extrude && (!state.interacting || state.transform.k > 6);

  drawParcels(mapCtx, updatePicking ? picking.ctx : null, items, t, {
    colors,
    heights,
    idColors,
    order,
    extrude: liveExtrude,
    exaggeration: exaggerationFor(state.transform.k),
    selected: state.selected,
    hoveredId: state.hoveredId,
    width: rect.width,
    height: rect.height,
  });

  drawLabels(mapCtx, lines, t, {
    zoomK: state.transform.k,
    width: rect.width,
    height: rect.height,
  });

  mapCtx.restore();
}

// Last full-redraw cost in ms, readable from the console as `__atlas.lastRedrawMs`.
// Cheap to keep, and the only way to tell a real draw cost from vsync cadence.
export const perf = { lastRedrawMs: 0 };

function frame() {
  if (state.needsRedraw) {
    state.needsRedraw = false;
    const t0 = performance.now();
    redraw();
    perf.lastRedrawMs = performance.now() - t0;
  }
  requestAnimationFrame(frame);
}

function onPointerMove(event) {
  const rect = mapCanvas.getBoundingClientRect();
  const id = picking.pick(event.clientX - rect.left, event.clientY - rect.top);

  if (id === state.hoveredId) return;
  state.hoveredId = id;
  state.needsRedraw = true;

  if (id == null) {
    titleBlock.hide();
    hint.style.opacity = '1';
  } else {
    titleBlock.show(id, atlas.attrs);
    hint.style.opacity = '0';
  }
}

function setAttribute(attr) {
  state.attr = attr;
  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.classList.toggle('is-active', btn.dataset.attr === attr);
  }
  applyAttribute();
  writeHash();
}

/** Deep-linkable state: #attr/z/x/y */
function writeHash() {
  const { k, x, y } = state.transform;
  const hash = `#${state.attr}/${k.toFixed(2)}/${x.toFixed(0)}/${y.toFixed(0)}`;
  history.replaceState(null, '', hash);
}

function readHash() {
  const parts = location.hash.slice(1).split('/');
  if (parts.length < 4) return null;
  const [attr, k, x, y] = parts;
  if (!ATTRIBUTES[attr]) return null;
  const nk = Number(k);
  const nx = Number(x);
  const ny = Number(y);
  if (![nk, nx, ny].every(Number.isFinite)) return null;
  return { attr, transform: zoomIdentity.translate(nx, ny).scale(nk) };
}

async function main() {
  atlas = await loadAtlas();

  items = prepareFeatures(atlas.parcels);
  lines = prepareLines(atlas.vias);
  order = paintOrder(items);
  idColors = items.map((_, i) => idToColor(i));
  heights = atlas.attrs.altura;

  histogram = createHistogram(document.getElementById('hist'), {
    onSelect(bins) {
      if (!bins) {
        state.selected = null;
        document.getElementById('hist-clear').hidden = true;
      } else {
        const values = valuesFor(state.attr);
        const set = new Set();
        for (let i = 0; i < values.length; i++) {
          if (bins.some((b) => b.match(values[i]))) set.add(i);
        }
        state.selected = set;
        document.getElementById('hist-clear').hidden = false;
      }
      state.needsRedraw = true;
    },
  });

  sizeCanvases();
  applyAttribute();

  // Coverage, stated plainly: this atlas covers Centro, not Montevideo.
  const { meta } = atlas;
  document.getElementById('coverage').innerHTML =
    `<strong>${fmt.format(meta.counts.parcels)} padrones</strong> del Inventario Patrimonial del Centro ` +
    `(decreto 39.085) — no toda la ciudad. Altura y grado cubren el 100%; ` +
    `obras, el ${meta.coverage.permitPct}%. ` +
    `${meta.coverage.alturaEspecial} padrones tienen altura especial, sin valor numérico.`;

  const zoomBehavior = d3zoom()
    .scaleExtent([0.6, 60])
    .on('start', () => {
      state.interacting = true;
    })
    .on('zoom', (event) => {
      state.transform = event.transform;
      state.needsRedraw = true;
      writeHash();
    })
    .on('end', () => {
      state.interacting = false;
      state.needsRedraw = true;
    });

  select(mapCanvas).call(zoomBehavior);

  const restored = readHash();
  if (restored) {
    setAttribute(restored.attr);
    select(mapCanvas).call(zoomBehavior.transform, restored.transform);
  }

  mapCanvas.addEventListener('pointermove', onPointerMove);
  mapCanvas.addEventListener('pointerleave', () => {
    state.hoveredId = null;
    titleBlock.hide();
    hint.style.opacity = '1';
    state.needsRedraw = true;
  });

  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.addEventListener('click', () => setAttribute(btn.dataset.attr));
  }

  document.getElementById('extrude-toggle').addEventListener('change', (e) => {
    state.extrude = e.target.checked;
    state.needsRedraw = true;
  });

  document.getElementById('hist-clear').addEventListener('click', () => {
    histogram.render(buildBins(state.attr, valuesFor(state.attr)));
    state.selected = null;
    document.getElementById('hist-clear').hidden = true;
    state.needsRedraw = true;
  });

  window.addEventListener('resize', () => {
    sizeCanvases();
    histogram.render(buildBins(state.attr, valuesFor(state.attr)));
  });

  window.__atlas = { perf, state };

  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.getElementById('coverage').textContent = `No se pudieron cargar los datos: ${err.message}`;
});
