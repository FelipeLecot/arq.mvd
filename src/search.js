/**
 * Padrón search — pure functions, no DOM/canvas dependency.
 *
 * The index maps a padrón number to every feature id that carries it. Most padrones are
 * unique, but 253 (of 208,532) are duplicated across Centro/POT sector variants — see
 * `attrs.sector` — a real disambiguation case the caller has to handle, not a hypothetical
 * one. Building it is a single O(n) pass over the flat `attrs.padron` array (parallel to
 * `atlas.parcels`, see src/data.js), done once in main() right after `items` is prepared.
 */

/** Build a `Map<padron, id[]>` from a single pass over the padrón array. */
export function buildPadronIndex(padronArr) {
  const index = new Map();
  for (let id = 0; id < padronArr.length; id++) {
    const padron = padronArr[id];
    if (padron == null) continue;
    let ids = index.get(padron);
    if (!ids) {
      ids = [];
      index.set(padron, ids);
    }
    ids.push(id);
  }
  return index;
}

/** Feature ids carrying an exact padrón number, or an empty array if there's no match. */
export function findExact(index, padron) {
  return index.get(padron) ?? [];
}

/**
 * Padrón numbers whose decimal representation starts with `prefix`, for incremental-typing
 * suggestions. A capped linear scan over the index rather than a trie — simple enough for
 * a one-off feature, and the cap keeps a short, common prefix (e.g. "1") from building a
 * huge result on every keystroke.
 */
export function findPrefix(index, prefix, limit = 8) {
  const results = [];
  if (!prefix) return results;
  for (const padron of index.keys()) {
    if (String(padron).startsWith(prefix)) {
      results.push(padron);
      if (results.length >= limit) break;
    }
  }
  return results;
}

/**
 * Parse free-typed search input into a padrón number. Tolerates surrounding whitespace,
 * leading zeros, and a trailing sector letter typed along with the number (e.g. "432381 A")
 * by reading only the leading digit run. Returns null for input with no leading digits.
 */
export function parseQuery(raw) {
  if (raw == null) return null;
  const digits = String(raw).trim().match(/^\d+/);
  return digits ? Number(digits[0]) : null;
}
