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
import {
  buildPadronIndex, findExact, findPrefix, parseQuery,
  buildAddressIndex, findAddress, detectQueryKind,
} from './search.js';

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

/**
 * Visible parcel ids, back-to-front by Mercator northing (the painter's algorithm).
 *
 * The ordering is precomputed once per dataset (`parcelDrawOrder` — `cy` never changes),
 * so a frame only marks which of the queried ids are visible and walks the static order,
 * instead of re-sorting up to the full viewport budget every frame.
 */
function visibleParcelOrder(t, width, height, extrude, exaggeration) {
  const [minX, minY, maxX, maxY] = viewportMercatorBounds(t, width, height, extrude, exaggeration);
  const ids = queryIds(parcelIndex, minX, minY, maxX, maxY);
  for (const id of ids) parcelMark[id] = 1;
  const out = [];
  for (const id of parcelDrawOrder) if (parcelMark[id]) out.push(id);
  for (const id of ids) parcelMark[id] = 0;
  return out;
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

/** Visible block ids, back-to-front — same precomputed-order scheme as parcels above. */
function visibleBlockOrder(t, width, height) {
  const [minX, minY, maxX, maxY] = viewportMercatorBounds(t, width, height, false, 1);
  const ids = queryIds(blockIndex, minX, minY, maxX, maxY);
  for (const id of ids) blockMark[id] = 1;
  const out = [];
  for (const id of blockDrawOrder) if (blockMark[id]) out.push(id);
  for (const id of ids) blockMark[id] = 0;
  return out;
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
  showUntracked: false,
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
let addressIndex;
let blockItems;
let blockIndex;
let blockIdColors;
let blockColors;
let blockHeights;
// Painter's-algorithm order, precomputed once per dataset (ids sorted back-to-front by
// Mercator northing), plus a reusable 0/1 mark array the per-frame visible-id filter
// flips on and off — see visibleParcelOrder/visibleBlockOrder.
let parcelDrawOrder = [];
let parcelMark = new Uint8Array(0);
let blockDrawOrder = [];
let blockMark = new Uint8Array(0);
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
  document.getElementById('untracked-toggle-wrap').hidden = state.attr !== 'grado';

  const legendVals = legendValues();
  renderLegend(
    document.getElementById('legend-title'),
    document.getElementById('legend-items'),
    state.attr,
    legendVals,
  );

  document.getElementById('hist-title').textContent = spec.legendTitle;
  document.getElementById('hist-note').textContent = spec.note;
  histogram.render(buildBins(state.attr, legendVals));

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

/**
 * Values feeding the legend/histogram summary widgets — unlike valuesFor(), this drops
 * the NA category by default (per the toggle) since it dwarfs the graded categories:
 * ~198K NA vs. a few thousand graded parcels makes the bar chart unreadable and the
 * legend counts uninformative. Map rendering itself is untouched — colors always come
 * from the unfiltered valuesFor().
 */
function legendValues() {
  const values = valuesFor(state.attr);
  if (state.attr === 'grado' && !state.showUntracked) {
    return values.filter((v) => v !== 'NA');
  }
  return values;
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
      interacting: state.interacting,
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
      interacting: state.interacting,
    });
    lastExtrude = liveExtrude;
  }

  // Labels re-run collision resolution against every visible street each frame; that is
  // work a moving map can't afford and the eye can't read anyway. They return the moment
  // the gesture settles.
  if (!state.interacting) {
    drawLabels(mapCtx, visLines, t, {
      zoomK: state.transform.k,
      width: rect.width,
      height: rect.height,
    });
  }

  mapCtx.restore();

  // The picking buffer now disagrees with the screen. It is rebuilt on demand rather
  // than here, so the cost lands only when someone actually points at something.
  lastTransform = t;
  lastLod = lod;
  state.pickDirty = true;
  queuePickRefresh();
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
    // Tells pick() exactly which ids' colours are genuine this frame — see PACK_MULT's
    // docstring in picking.js for why arithmetic alone can't carry that guarantee.
    picking.setPaintedIds(order);
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
    picking.setPaintedIds(order);
  }

  state.pickDirty = false;
}

// One idle-callback in flight at a time; redraw() re-queues after every frame that leaves
// the buffer stale, so the flag is what keeps a long interaction from stacking callbacks.
let pickRefreshQueued = false;

/**
 * Rebuild the picking buffer when the browser has nothing better to do, so the cost
 * usually never lands inside a pointermove at all — onPointerMove still rebuilds
 * synchronously if the pointer arrives before the idle callback ran. Skipped mid-gesture:
 * the buffer would be stale again by the next frame anyway (see onPointerMove's guard),
 * and 'end' triggers a redraw whose queue call takes over once the gesture settles.
 */
function queuePickRefresh() {
  if (pickRefreshQueued || !state.pickDirty) return;
  pickRefreshQueued = true;
  const run = () => {
    pickRefreshQueued = false;
    if (state.pickDirty && !state.interacting && lastTransform) refreshPicking();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 250 });
  else setTimeout(run, 150);
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

/**
 * Show a parcel's title block, pulling attrs.detail.json in on first use. The core
 * columns render immediately; once the detail fetch resolves, whatever the panel is
 * showing *right now* is re-rendered so its detail rows appear (a later hover re-renders
 * anyway, but a pinned parcel sitting under a still cursor would otherwise never refresh).
 * A block-LOD hover is left alone — blocks have no parcel-detail rows to gain.
 */
function showParcel(id) {
  titleBlock.show(id, atlas.attrs);
  atlas
    .loadDetail()
    .then(() => {
      if (state.hoveredLod === 'parcel' && state.hoveredId != null) {
        titleBlock.show(state.hoveredId, atlas.attrs);
      } else if (!(state.hoveredLod === 'block' && state.hoveredId != null) && state.searchSelectedId != null) {
        titleBlock.show(state.searchSelectedId, atlas.attrs);
      }
    })
    .catch(() => {});
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
      showParcel(state.searchSelectedId);
      hint.style.opacity = '0';
    } else {
      titleBlock.hide();
      hint.style.opacity = '1';
    }
  } else if (lastLod === 'block') {
    titleBlock.showBlock(id, atlas.blockAttrs);
    hint.style.opacity = '0';
  } else {
    showParcel(id);
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
  addressIndex = buildAddressIndex(atlas.attrs.address);
  lines = prepareLines(atlas.vias);
  ambitoItems = prepareFeatures(atlas.ambito.features);
  parcelIndex = buildIndex(items);
  streetIndex = buildIndex(lines);
  idColors = items.map((_, i) => idToColor(i));
  heights = atlas.attrs.altura;
  parcelDrawOrder = items.map((_, i) => i).sort((a, b) => items[b].cy - items[a].cy);
  parcelMark = new Uint8Array(items.length);

  // Block attributes ride along in attrs.core.json, so they are available immediately —
  // only the block geometry is deferred (see loadBlocks below).
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

  // Sticky touchpad classifier: trackpads emit pixel-mode wheel events with fractional
  // deltas, which mouse wheels virtually never produce, so the first fractional event
  // flips the device guess for the rest of the session. After that, two-finger scrolls
  // pan the map instead of zooming it; pinch gestures (ctrlKey wheel) always zoom.
  let inputDevice = 'mouse';
  const isTouchpadScroll = (event) => {
    if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return false;
    if (!Number.isInteger(event.deltaX) || !Number.isInteger(event.deltaY)) inputDevice = 'touchpad';
    return inputDevice === 'touchpad';
  };

  const zoomBehavior = d3zoom()
    .scaleExtent([0.6, 60])
    .filter((event) => {
      // Mouse-wheel zoom, trackpad pinch-to-zoom (ctrlKey wheel), touch/pen panning
      // (touchstart) and double-click-zoom (dblclick) are all unaffected by the
      // button restriction below — d3-zoom only ever calls this filter for these four
      // event types, checked against the installed d3-zoom v3 source
      // (node_modules/d3-zoom/src/zoom.js). Non-pinch trackpad scrolls are rejected here
      // and handled as panning by the dedicated wheel listener below.
      if (event.type === 'wheel') return event.ctrlKey || !isTouchpadScroll(event);
      if (event.type === 'touchstart' || event.type === 'dblclick') return true;
      // Left- or middle-button drag pans the map; the left button doubles as
      // click-to-select, disambiguated by pointer travel in the click handler below.
      return event.button === 0 || event.button === 1;
    })
    .on('start', () => {
      state.interacting = true;
      mapCanvas.classList.add('is-panning');
    })
    .on('zoom', (event) => {
      state.transform = event.transform;
      state.needsRedraw = true;
      writeHash();
    })
    .on('end', () => {
      state.interacting = false;
      mapCanvas.classList.remove('is-panning');
      state.needsRedraw = true;
    });

  select(mapCanvas).call(zoomBehavior);

  // Two-finger trackpad scrolls pan the map (the filter above routes them away from
  // d3-zoom); mouse wheels and pinches fall through to d3-zoom's own wheel handling.
  // Page-scroll semantics: swipe down reveals content further down, like any document.
  mapCanvas.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || !isTouchpadScroll(event)) return;
      event.preventDefault();
      const { k } = state.transform;
      select(mapCanvas).call(zoomBehavior.translateBy, -event.deltaX / k, -event.deltaY / k);
    },
    { passive: false },
  );

  // Windows/Linux browsers otherwise enter native autoscroll mode on a middle-button press
  // over a non-scrolling element, which fights with d3-zoom's own drag handling.
  mapCanvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });

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

  /**
   * Pin a feature as the search result / map selection: default panel content that
   * persists through hover (see onPointerMove's fallback), however it was selected. Syncs
   * the padrón input so there's one consistent way to see/clear whatever is pinned.
   */
  function pinFeature(id, { fly }) {
    state.searchSelectedId = id;
    showParcel(id);
    hint.style.opacity = '0';
    const sector = atlas.attrs.sector[id];
    const padron = atlas.attrs.padron[id];
    searchInput.value = sector ? `${padron} ${sector}` : String(padron);
    searchClear.hidden = false;
    hideSearchFeedback();
    if (fly) flyTo(id);
    state.needsRedraw = true;
  }

  /** Clear the current pin, whether it came from search or a map click. */
  function clearSelection() {
    state.searchSelectedId = null;
    searchInput.value = '';
    searchClear.hidden = true;
    hideSearchFeedback();
    if (state.hoveredId == null) {
      titleBlock.hide();
      hint.style.opacity = '1';
    }
    state.needsRedraw = true;
  }

  /** A search result always flies the map to frame it. */
  function selectSearchResult(id) {
    pinFeature(id, { fly: true });
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
    const raw = searchInput.value;
    if (detectQueryKind(raw) === 'padron') {
      // Same leading-digit-run rule as parseQuery (used on submit), so a query that shows
      // suggestions here is guaranteed not to be rejected as invalid on Enter.
      const padron = parseQuery(raw);
      const digits = padron == null ? '' : String(padron);
      if (digits.length < 2) {
        hideSearchFeedback();
        return;
      }
      renderSuggestions(findPrefix(padronIndex, digits, 8));
      return;
    }

    const q = raw.trim();
    if (q.length < 3) {
      hideSearchFeedback();
      return;
    }
    renderDisambiguation(findAddress(addressIndex, q, 8));
  });

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = searchInput.value;

    if (detectQueryKind(raw) === 'padron') {
      const padron = parseQuery(raw);
      if (padron == null) {
        searchResults.hidden = true;
        searchResults.innerHTML = '';
        searchStatus.hidden = false;
        searchStatus.textContent = 'Ingresá un número de padrón';
        return;
      }
      runSearch(padron);
      return;
    }

    const ids = findAddress(addressIndex, raw, 8);
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
  });

  searchClear.addEventListener('click', clearSelection);

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
      showParcel(state.searchSelectedId);
      hint.style.opacity = '0';
    } else {
      titleBlock.hide();
      hint.style.opacity = '1';
    }
    state.needsRedraw = true;
  });

  // Where the left button went down, so the click handler can tell a selection click
  // from the click event every left-drag pan ends with.
  let downAt = null;
  mapCanvas.addEventListener('pointerdown', (event) => {
    downAt = event.button === 0 ? [event.clientX, event.clientY] : null;
  });

  mapCanvas.addEventListener('click', (event) => {
    // Mid-gesture there's nothing meaningful to pick, matching onPointerMove's own guard.
    if (state.interacting || !lastTransform) return;

    // A dragged pointer also fires a click on release — only near-stationary pointers
    // count as selection clicks (4px of slop absorbs hand tremor).
    if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 4) return;

    // At block LOD, picking returns block-space ids, not parcel-space ones — and blocks
    // aren't a selectable/pinnable entity anywhere else in the app (no "pinned block"
    // concept; block hover only shows transient info via titleBlock.showBlock). Treat a
    // click here as a no-op for selection state rather than corrupting
    // state.searchSelectedId with a block id that drawParcels/onPointerMove/pointerleave
    // all assume is parcel-space.
    if (lastLod === 'block') return;

    if (state.pickDirty) refreshPicking();

    const rect = mapCanvas.getBoundingClientRect();
    const id = picking.pick(event.clientX - rect.left, event.clientY - rect.top);

    if (id == null) {
      // A click on a street or outside the ámbito deselects — mirrors the ✕ button.
      clearSelection();
    } else {
      // Selected in place: you already clicked what's on screen, so the view shouldn't move.
      pinFeature(id, { fly: false });
    }
  });

  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.addEventListener('click', () => setAttribute(btn.dataset.attr));
  }

  document.getElementById('extrude-toggle').addEventListener('change', (e) => {
    state.extrude = e.target.checked;
    state.needsRedraw = true;
  });

  document.getElementById('untracked-toggle').addEventListener('change', (e) => {
    state.showUntracked = e.target.checked;
    applyAttribute();
  });

  document.getElementById('hist-clear').addEventListener('click', () => {
    histogram.render(buildBins(state.attr, legendValues()));
    state.selected = null;
    document.getElementById('hist-clear').hidden = true;
    state.needsRedraw = true;
  });

  window.addEventListener('resize', () => {
    sizeCanvases();
    histogram.render(buildBins(state.attr, legendValues()));
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
      blockDrawOrder = blockItems.map((_, i) => i).sort((a, b) => blockItems[b].cy - blockItems[a].cy);
      blockMark = new Uint8Array(blockItems.length);
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
  hint.textContent = `No se pudieron cargar los datos: ${err.message}`;
  hint.style.opacity = '1';
});
