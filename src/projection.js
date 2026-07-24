import { geoIdentity, geoPath } from 'd3';

/**
 * Geometry arrives pre-projected to Web Mercator from the build, so the browser needs
 * no reprojection — geoIdentity just fits and flips it. reflectY compensates for canvas
 * y running downward while Mercator y runs north.
 */
export function createProjection(ambito, width, height, padding = 24) {
  const projection = geoIdentity()
    .reflectY(true)
    .fitExtent(
      [
        [padding, padding],
        [Math.max(padding + 1, width - padding), Math.max(padding + 1, height - padding)],
      ],
      ambito,
    );
  return projection;
}

export function createPath(projection, context) {
  return geoPath(projection, context);
}

/**
 * Metres to Mercator units at Montevideo's latitude. Web Mercator inflates distance by
 * 1/cos(lat) — about 1.22 here — so a height in metres has to be divided by that factor
 * before it is treated as a Mercator length.
 */
export function metresToMercator(metres, latDeg = -34.9) {
  return metres / Math.cos((latDeg * Math.PI) / 180);
}

/** Current pixels-per-Mercator-unit, including the live zoom transform. */
export function pixelScale(projection, transform) {
  return projection.scale() * (transform?.k ?? 1);
}
