// Parse the construction-permits CSV and index it by padron.
//
// Shape of the source: semicolon-separated, latin1, fixed-width-padded text columns,
// header `padron;destino;area;calle;puerta;letra;anio;mes;expediente;tipo_obra`.
// 42141 rows spanning 1997-2026.
//
// Coverage caveat worth remembering when reading anything built on this: permits reach
// only ~20.5% of Centro padrones and start in 1997, so this measures recent churn — it
// is NOT a construction-date or era field. No era source exists in the open data.

import { readBySuffix } from './zip.mjs';

export function parsePermits(zipBuf) {
  const text = readBySuffix(zipBuf, '.csv').toString('latin1');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(';').map((h) => h.trim().toLowerCase());

  const col = (name) => header.indexOf(name);
  const iPadron = col('padron');
  const iDestino = col('destino');
  const iArea = col('area');
  const iAnio = col('anio');
  const iTipo = col('tipo_obra');

  const byPadron = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(';');
    const padron = Number.parseInt((cells[iPadron] || '').trim(), 10);
    if (!Number.isFinite(padron)) continue;

    const year = Number.parseInt((cells[iAnio] || '').trim(), 10);
    const area = Number.parseFloat((cells[iArea] || '').trim());

    let rec = byPadron.get(padron);
    if (!rec) {
      rec = { count: 0, lastYear: null, firstYear: null, totalArea: 0, destino: null, tipo: null };
      byPadron.set(padron, rec);
    }

    rec.count++;
    if (Number.isFinite(area)) rec.totalArea += area;
    if (Number.isFinite(year)) {
      if (rec.lastYear === null || year > rec.lastYear) {
        rec.lastYear = year;
        // Keep the destino/tipo of the most recent permit — the best available guess at
        // what the building is used for today.
        rec.destino = (cells[iDestino] || '').trim() || null;
        rec.tipo = (cells[iTipo] || '').trim() || null;
      }
      if (rec.firstYear === null || year < rec.firstYear) rec.firstYear = year;
    }
  }

  return byPadron;
}
