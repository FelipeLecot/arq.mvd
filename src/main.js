import { select, zoom as d3zoom, zoomIdentity } from 'd3';
import { loadAtlas } from './data.js';
import { createProjection, metresToMercator } from './projection.js';
import { prepareFeatures, prepareLines, screenTransform } from './render/geometry.js';
import { drawParcels, drawPicking } from './render/parcels.js';
import { drawStreets, drawAmbito } from './render/streets.js';
import { drawLabels } from './render/labels.js';
import { buildIndex, queryIds } from './render/spatialIndex.js';
import { PickingLayer, idToColor } from './picking.js';
import { ATTRIBUTES } from './scales.js';
import { renderLegend } from './legend.js';
import { createHistogram, buildBins } from './histogram.js';
import { createTitleBlock } from './hover.js';
import { buildPadronIndex, findExact, findPrefix, parseQuery } from './search.js';

// A little more than the largest legal envelope in the dataset — the query only needs to
// not under-include; the precise per-item featureBounds check downstream is the real filter.
const MAX_ENVELOPE_M = 150;
const BASE_PAD_PX = 24;

// Centro's original 9,016-parcel viewport was already cheap enough without an LOD swap,
// and the app's landing view sits well within that. A raw zoom-scale threshold doesn't
// capture this: k=1 (the landing transform) is a low zoom over a *sparse* area, but the
// same k panned into dense citywide POT territory can put far more parcels on screen. So
// this is a budget on how many parcels are actually *visible*, not on how zoomed out the
// view is — draw merged blocks once that many individual lot outlines would need drawing,
// regardless of k. 12,500 gives Centro's own full viewport (~9,016 parcels) comfortable
// margin to stay on the parcel LOD, while still swapping to blocks well before a dense
// citywide viewport at a similar zoom gets expensive. Tune by watching
// window.__atlas.perf.lastRedrawMs while panned into a dense area at different scales.
const BLOCK_LOD_PARCEL_BUDGET = 12500;

/**
 * Mercator-space viewport rectangle for the current screen transform, padded so a
 * feature whose *footprint* sits just outside it — but whose extruded roof leans into
 * view — still gets queried. The extrusion padding is independent of zoom: the vertical
 * lift is added in screen space as `metresToMercator(h) * t.a * exaggeration`, so its
 * Mercator-space equivalent (before the `t.a` multiply) is zoom-invariant.
 */
function viewportMercatorBounds(t, width, height, extrude, exaggeration) {
  const pad = BASE_PAD_PX / t.a + (extrude ? metresToMercator(MAX_ENVELOPE_M) * exaggeration : 0);
  const minX = -t.bx / t.a - pad;
  const maxX = (width - t.bx) / t.a + pad;
  const minY = (t.by - height) / t.a - pad;
  const maxY = t.by / t.a + pad;
  return [minX, minY, maxX, maxY];
}

/** Visible parcel ids, back-to-front by Mercator northing (the painter's algorithm). */
function visibleParcelOrder(t, width, height, extrude, exaggeration) {
  const [minX, minY, maxX, maxY] = viewportMercatorBounds(t, width, height, extrude, exaggeration);
  const ids = queryIds(parcelIndex, minX, minY, maxX, maxY);
  return ids.sort((a, b) => items[b].cy - items[a].cy);
}

/**
 * Count of parcel ids visible in the current viewport, for the block-LOD budget decision
 * only — unlike visibleParcelOrder, it skips the sort, since a count doesn't need
 * painter's-algorithm order. Queried without extrusion padding (matching how
 * visibleBlockOrder/visibleLines already query): the budget is about how many individual
 * lot outlines would need drawing, not about how far extrusion overdraw reaches.
 */
function visibleParcelCount(t, width, height) {
  const [minX, minY, maxX, maxY] = viewportMercatorBounds(t, width, height, false, 1);
  return queryIds(parcelIndex, minX, minY, maxX, maxY).length;
}

/** Visible street/ámbito lines — streets don't extrude, so no extra padding needed. */
function visibleLines(t, width, height) {
  const [minX, minY, maxX, maxY] = viewportMercatorBounds(t, width, height, false, 1);
  return queryIds(streetIndex, minX, minY, maxX, maxY).map((id) => lines[id]);
}

/** Visible block ids, back-to-front — blocks never extrude, so no extra padding needed. */
function visibleBlockOrder(t, width, height) {
  const [minX, minY, maxX, maxY] = viewportMercatorBounds(t, width, height, false, 1);
  const ids = queryIds(blockIndex, minX, minY, maxX, maxY);
  return ids.sort((a, b) => blockItems[b].cy - blockItems[a].cy);
}

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
  hoveredLod: null,
  selected: null,
  // Set by a successful padrón search, independent of attribute-switching's `selected` —
  // applyAttribute()/hist-clear must never reset this. It's the panel's default content;
  // hover temporarily overrides the display but doesn't clear the pin (see onPointerMove).
  searchSelectedId: null,
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
const searchForm = document.getElementById('padron-search-form');
const searchInput = document.getElementById('padron-input');
const searchClear = document.getElementById('padron-clear');
const searchResults = document.getElementById('padron-results');
const searchStatus = document.getElementById('padron-status');

const fmt = new Intl.NumberFormat('es-UY');

let atlas;
let items;
let lines;
let parcelIndex;
let streetIndex;
let projection;
let ambitoItems;
let idColors;
let colors;
let heights;
let histogram;
let dpr = 1;
let padronIndex;
let blockItems;
let blockIndex;
let blockIdColors;
let blockColors;
let blockHeights;
// Transform and extrusion mode of the last painted frame, so the picking buffer can be
// rebuilt later to match exactly what is on screen.
let lastTransform = null;
let lastExtrude = false;
let lastLod = 'parcel';

function sizeCanvases() {
  const rect = stage.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);

  for (const canvas of [mapCanvas, overlayCanvas]) {
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
  }
  picking.resize(rect.width, rect.height, dpr);

  projection = createProjection(atlas.ambito, rect.width, rect.height);
  state.needsRedraw = true;
}

/** Recompute the per-parcel and per-block colour arrays. Geometry is untouched. */
function applyAttribute() {
  const spec = ATTRIBUTES[state.attr];
  const values = valuesFor(state.attr);
  colors = values.map((v) => spec.color(v));

  const blockVals = blockValuesFor(state.attr);
  blockColors = blockVals.map((v) => spec.color(v));

  // Legend and histogram deliberately stay parcel-level regardless of the active LOD —
  // they describe "the dataset," and switching their source per zoom would make the same
  // colour mean a different statistic depending on how far zoomed out you are.
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

function blockValuesFor(attr) {
  if (attr === 'grado') return atlas.blockAttrs.grado;
  if (attr === 'altura') return atlas.blockAttrs.altura;
  return atlas.blockAttrs.permits;
}

function redraw() {
  const rect = stage.getBoundingClientRect();
  const t = screenTransform(projection, state.transform);
  // blockItems is undefined until the deferred block-geometry fetch resolves (see
  // loadBlocks in data.js). Until then the parcel LOD is drawn regardless of how many
  // parcels are visible — slower zoomed out, but correct and complete, which is the right
  // way to degrade. Once blocks are available, the swap is driven by how many parcels are
  // actually on screen right now (see BLOCK_LOD_PARCEL_BUDGET), not by zoom level.
  const lod =
    blockItems && visibleParcelCount(t, rect.width, rect.height) > BLOCK_LOD_PARCEL_BUDGET
      ? 'block'
      : 'parcel';

  mapCtx.save();
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapCtx.clearRect(0, 0, rect.width, rect.height);

  // Both queries turn "scan the whole dataset" into "scan what's on screen" — see
  // spatialIndex.js. At Centro's original scale this was unnecessary; at the citywide
  // scale it's the difference between a redraw costing hundreds of ms and a few.
  const visLines = visibleLines(t, rect.width, rect.height);

  drawStreets(mapCtx, visLines, t, { zoomK: state.transform.k });
  drawAmbito(mapCtx, ambitoItems, t);

  const exaggeration = exaggerationFor(state.transform.k);

  if (lod === 'block') {
    // Blocks always render flat: an averaged height smeared across many different real
    // buildings and drawn as one solid volume would misrepresent the data the same way
    // un-exaggerated height would when zoomed in.
    const order = visibleBlockOrder(t, rect.width, rect.height);
    drawParcels(mapCtx, blockItems, t, {
      colors: blockColors,
      heights: blockHeights,
      idColors: blockIdColors,
      order,
      extrude: false,
      exaggeration,
      selected: null,
      hoveredId: state.hoveredLod === 'block' ? state.hoveredId : null,
      width: rect.width,
      height: rect.height,
    });
  } else {
    // Extruding all parcels costs far more than a frame at city scale, so an
    // active pan or zoom draws the flat map and the volume returns the moment the
    // gesture settles. Zoomed in, culling makes extrusion cheap enough to keep live.
    const liveExtrude = state.extrude && (!state.interacting || state.transform.k > 6);
    const order = visibleParcelOrder(t, rect.width, rect.height, liveExtrude, exaggeration);
    drawParcels(mapCtx, items, t, {
      colors,
      heights,
      idColors,
      order,
      extrude: liveExtrude,
      exaggeration,
      selected: state.selected,
      hoveredId: state.hoveredLod === 'parcel' ? state.hoveredId : null,
      pinnedId: state.searchSelectedId,
      width: rect.width,
      height: rect.height,
    });
    lastExtrude = liveExtrude;
  }

  drawLabels(mapCtx, visLines, t, {
    zoomK: state.transform.k,
    width: rect.width,
    height: rect.height,
  });

  mapCtx.restore();

  // The picking buffer now disagrees with the screen. It is rebuilt on demand rather
  // than here, so the cost lands only when someone actually points at something.
  lastTransform = t;
  lastLod = lod;
  state.pickDirty = true;
}

/** Rebuild the picking buffer to match the last painted frame. */
function refreshPicking() {
  const rect = stage.getBoundingClientRect();
  const exaggeration = exaggerationFor(state.transform.k);
  picking.clear();

  if (lastLod === 'block') {
    const order = visibleBlockOrder(lastTransform, rect.width, rect.height);
    drawPicking(picking.ctx, blockItems, lastTransform, {
      heights: blockHeights,
      idColors: blockIdColors,
      order,
      extrude: false,
      exaggeration,
      width: rect.width,
      height: rect.height,
    });
  } else {
    const order = visibleParcelOrder(lastTransform, rect.width, rect.height, lastExtrude, exaggeration);
    drawPicking(picking.ctx, items, lastTransform, {
      heights,
      idColors,
      order,
      extrude: lastExtrude,
      exaggeration,
      width: rect.width,
      height: rect.height,
    });
  }

  state.pickDirty = false;
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
  // Mid-gesture the pointer is dragging, not pointing, so hit-testing is skipped
  // entirely and the buffer stays stale until the view settles.
  if (state.interacting || !lastTransform) return;
  if (state.pickDirty) refreshPicking();

  const rect = mapCanvas.getBoundingClientRect();
  const id = picking.pick(event.clientX - rect.left, event.clientY - rect.top);

  if (id === state.hoveredId && state.hoveredLod === lastLod) return;
  state.hoveredId = id;
  state.hoveredLod = lastLod;
  state.needsRedraw = true;

  if (id == null) {
    // Falls back to the pinned search result rather than blanking the panel — the pin
    // is the default content, hover is only a temporary override.
    if (state.searchSelectedId != null) {
      titleBlock.show(state.searchSelectedId, atlas.attrs);
      hint.style.opacity = '0';
    } else {
      titleBlock.hide();
      hint.style.opacity = '1';
    }
  } else if (lastLod === 'block') {
    titleBlock.showBlock(id, atlas.blockAttrs);
    hint.style.opacity = '0';
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
  history.replaceState(
    null,
    '',
    `#${state.attr}/${k.toFixed(2)}/${x.toFixed(0)}/${y.toFixed(0)}`,
  );
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
  padronIndex = buildPadronIndex(atlas.attrs.padron);
  lines = prepareLines(atlas.vias);
  ambitoItems = prepareFeatures(atlas.ambito.features);
  parcelIndex = buildIndex(items);
  streetIndex = buildIndex(lines);
  idColors = items.map((_, i) => idToColor(i));
  heights = atlas.attrs.altura;

  // Block attributes ride along in attrs.json, so they are available immediately — only
  // the block geometry is deferred (see loadBlocks below).
  blockHeights = atlas.blockAttrs.altura;

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

  // Coverage, stated plainly: two tiers, citywide POT parcels and Centro's heritage subset.
  const { meta } = atlas;
  document.getElementById('coverage').innerHTML =
    `<strong>${fmt.format(meta.counts.parcels)} padrones</strong> de toda la ciudad (POT — Plan de ` +
    `Ordenamiento Territorial), de los cuales ${fmt.format(meta.coverage.centroParcels)} (Centro) ` +
    `tienen grado de protección patrimonial real (decreto 39.085, 100% de cobertura allí). Altura ` +
    `normativa cubre el 100% de la ciudad; obras, el ${meta.coverage.permitPct}%. ` +
    `${fmt.format(meta.coverage.alturaEspecial)} padrones tienen altura especial, sin valor numérico ` +
    `(${fmt.format(meta.coverage.centroAlturaEspecial)} de ellos dentro del Centro).`;

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

  /**
   * Centre and zoom to a feature's Mercator bounds. The `k` floor of 8 keeps the
   * resulting viewport small — small enough that its visible parcel count stays well
   * under BLOCK_LOD_PARCEL_BUDGET — so every search result forces the parcel LOD, even
   * when the map was zoomed out into blocks beforehand; the ceiling matches the zoom
   * behavior's own scaleExtent. Skips the transition (jumps instantly) under
   * prefers-reduced-motion, mirroring the reduced-motion rule in style.css.
   */
  function flyTo(id) {
    const rect = stage.getBoundingClientRect();
    const [minX, minY, maxX, maxY] = items[id].bounds;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);

    const projScale = projection.scale();
    const [projTx, projTy] = projection.translate();

    // Frame the parcel with context around it rather than filling the viewport edge to
    // edge; the floor/ceiling below can still override this fit.
    const pad = 140;
    const naturalK = Math.min(
      (rect.width - 2 * pad) / (spanX * projScale),
      (rect.height - 2 * pad) / (spanY * projScale),
    );
    const k = Math.min(60, Math.max(8, naturalK));

    const a = projScale * k;
    const x = rect.width / 2 - cx * a - projTx * k;
    const y = rect.height / 2 + cy * a - projTy * k;
    const target = zoomIdentity.translate(x, y).scale(k);

    const selection = select(mapCanvas);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      selection.call(zoomBehavior.transform, target);
    } else {
      selection.transition().duration(600).call(zoomBehavior.transform, target);
    }
  }

  /** Empty the disambiguation/suggestion list and hide the status message. */
  function hideSearchFeedback() {
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    searchStatus.hidden = true;
  }

  /** Pin a feature as the search result: default panel content, flies the map to it. */
  function selectSearchResult(id) {
    state.searchSelectedId = id;
    titleBlock.show(id, atlas.attrs);
    hint.style.opacity = '0';
    flyTo(id);
    state.needsRedraw = true;
    hideSearchFeedback();
    searchClear.hidden = false;
  }

  /** Disambiguation list for a padrón with sector-variant duplicates — one row per id. */
  function renderDisambiguation(ids) {
    searchResults.innerHTML = '';
    for (const id of ids) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const sector = atlas.attrs.sector[id];
      const padron = atlas.attrs.padron[id];
      const address = atlas.attrs.address[id] ?? 'Sin dirección registrada';
      btn.textContent = sector ? `${padron} ${sector} — ${address}` : `${padron} — ${address}`;
      btn.addEventListener('click', () => selectSearchResult(id));
      li.appendChild(btn);
      searchResults.appendChild(li);
    }
    searchStatus.hidden = true;
    searchResults.hidden = ids.length === 0;
  }

  /** Live suggestions for a partial numeric query, shown while typing. */
  function renderSuggestions(padrones) {
    searchResults.innerHTML = '';
    for (const padron of padrones) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(padron);
      btn.addEventListener('click', () => {
        searchInput.value = String(padron);
        runSearch(padron);
      });
      li.appendChild(btn);
      searchResults.appendChild(li);
    }
    searchStatus.hidden = true;
    searchResults.hidden = padrones.length === 0;
  }

  /** Exact search for a padrón number — zero, one, or many (sector duplicates) results. */
  function runSearch(padron) {
    const ids = findExact(padronIndex, padron);
    if (ids.length === 0) {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
      searchStatus.hidden = false;
      searchStatus.textContent = 'Sin resultados';
      return;
    }
    if (ids.length === 1) {
      selectSearchResult(ids[0]);
      return;
    }
    renderDisambiguation(ids);
  }

  searchInput.addEventListener('input', () => {
    // Same leading-digit-run rule as parseQuery (used on submit), so a query that shows
    // suggestions here is guaranteed not to be rejected as invalid on Enter.
    const padron = parseQuery(searchInput.value);
    const digits = padron == null ? '' : String(padron);
    if (digits.length < 2) {
      hideSearchFeedback();
      return;
    }
    renderSuggestions(findPrefix(padronIndex, digits, 8));
  });

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const padron = parseQuery(searchInput.value);
    if (padron == null) {
      searchResults.hidden = true;
      searchResults.innerHTML = '';
      searchStatus.hidden = false;
      searchStatus.textContent = 'Ingresá un número de padrón';
      return;
    }
    runSearch(padron);
  });

  searchClear.addEventListener('click', () => {
    state.searchSelectedId = null;
    searchInput.value = '';
    searchClear.hidden = true;
    hideSearchFeedback();
    if (state.hoveredId == null) {
      titleBlock.hide();
      hint.style.opacity = '1';
    }
    state.needsRedraw = true;
  });

  // The suggestions/disambiguation dropdown otherwise only closes on submit, on explicit
  // clear, or when typing drops below the minimum length — so a user who types a partial
  // query and then clicks the map instead is left with it parked over the canvas,
  // intercepting pointer events there. `pointerdown` (not `blur`) so a click on a
  // suggestion button still registers: blur fires before that button's own click.
  document.addEventListener('pointerdown', (e) => {
    if (!searchForm.contains(e.target)) hideSearchFeedback();
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideSearchFeedback();
  });

  const restored = readHash();
  if (restored) {
    setAttribute(restored.attr);
    select(mapCanvas).call(zoomBehavior.transform, restored.transform);
  }

  mapCanvas.addEventListener('pointermove', onPointerMove);
  mapCanvas.addEventListener('pointerleave', () => {
    state.hoveredId = null;
    if (state.searchSelectedId != null) {
      titleBlock.show(state.searchSelectedId, atlas.attrs);
      hint.style.opacity = '0';
    } else {
      titleBlock.hide();
      hint.style.opacity = '1';
    }
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

  window.__atlas = {
    perf,
    state,
    picking,
    refreshPicking,
    parcelCount: items.length,
    colorAt: (id) => colors[id],
  };

  requestAnimationFrame(frame);

  // Only now, with the parcel LOD already painting, pull the block geometry down. It is
  // the layer the initial view never shows, so it must not sit in front of first paint —
  // fetching, parsing, decoding and indexing it costs more than everything above.
  // Until this resolves, redraw() keeps drawing parcels at every zoom (see the lod guard).
  atlas
    .loadBlocks()
    .then((blocks) => {
      blockItems = prepareFeatures(blocks);
      blockIndex = buildIndex(blockItems);
      blockIdColors = blockItems.map((_, i) => idToColor(i));
      // redraw()'s own LOD logic decides parcel vs. block from here on (see
      // BLOCK_LOD_PARCEL_BUDGET) — an unconditional redraw is cheap, and a restored hash
      // can already be panned somewhere dense enough that blocks should show immediately.
      state.needsRedraw = true;
    })
    .catch((err) => {
      // The parcel LOD is fully functional without this, so a failure here degrades the
      // zoomed-out view's performance rather than breaking the atlas.
      console.error('block layer unavailable, staying on the parcel LOD', err);
    });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('coverage').textContent = `No se pudieron cargar los datos: ${err.message}`;
});
