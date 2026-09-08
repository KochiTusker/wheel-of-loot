/**
 * Making sense of a world with the same item in it eleven times.
 *
 * A GM who has imported several books ends up with "Potion of Healing" from the
 * SRD, from a 2014 printing, from a 2024 reprint, and from whatever premium
 * module they bought — plus a copy they dragged into the world and edited. All
 * of those are real, and which one belongs on the wheel is a judgement only the
 * GM can make. But a browser that lists all eleven is useless.
 *
 * So this draws two different lines:
 *
 *   **Redundant** — the same printing listed twice in the same place. Nothing is
 *   lost by hiding one, so the strictest mode does exactly that and no more.
 *
 *   **Variant** — the same name from different sources. These are *not*
 *   interchangeable (a 2014 Dust of Dryness has 1 use, the SRD one has 10), so
 *   they are collapsed into one row that can be expanded, never silently
 *   dropped.
 *
 * Everything here is pure and system-agnostic: it works off the fields the
 * catalogue has already normalised through the system adapter, so a world with
 * no rarities and no source books still groups correctly on what it does have.
 */

/** How the catalogue may fold duplicates together. */
export const DEDUPE_MODES = ["all", "redundant", "name"];

/**
 * A name key that survives the small inconsistencies between printings.
 *
 * Case, surrounding whitespace, doubled spaces and the various dashes and
 * apostrophes that different books use all differ without meaning anything.
 * Anything more aggressive than this starts merging items that really are
 * different, so it stops here.
 *
 * @param {string} name
 * @returns {string}
 */
export function normaliseName(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ");
}

/**
 * What makes two rows the same *printing*.
 *
 * Source is included because it is the field that actually distinguishes a
 * reprint; rarity, price and type are included because in a system with no
 * source data they are all that is left to tell two entries apart.
 *
 * @param {object} row
 * @returns {string}
 */
export function printingSignature(row) {
  return [
    normaliseName(row.name),
    String(row.source ?? "").trim().toLowerCase(),
    row.rarity ?? "",
    row.price ?? "",
    row.itemType ?? ""
  ].join("|");
}

/**
 * What makes one row a redundant copy of another: the same printing, in the
 * same place.
 *
 * Deliberately narrower than `printingSignature`. Comparing across packs would
 * flag every SRD or reprint edition as a duplicate, which is expected content,
 * not a fault — an early version did exactly that and reported thousands of
 * false positives.
 *
 * @param {object} row
 * @returns {string}
 */
export function redundancySignature(row) {
  return `${printingSignature(row)}|${row.packId ?? ""}`;
}

/**
 * How complete a row looks, for picking which variant represents a group.
 *
 * The richest entry is the best default: an entry carrying a rarity, a price
 * and real art is almost always the properly imported one, and a bare stub is
 * almost always the accident. The GM can still expand and choose another.
 *
 * @param {object} row
 * @returns {number}
 */
export function completeness(row) {
  let score = 0;
  if (row.rarity) score += 2;
  if (row.price != null) score += 1;
  if (row.source) score += 1;
  if (row.img && !/item-bag|mystery-man|svg\/item/.test(row.img)) score += 1;
  if (row.usesMax != null) score += 1;
  return score;
}

/**
 * Annotate rows with their variant and redundancy counts.
 *
 * Runs once when the catalogue is built, so the filtering below and the badges
 * in the interface agree with each other by construction.
 *
 * @param {object[]} rows  Mutated in place, and returned.
 * @returns {object[]}
 */
export function annotateDuplicates(rows) {
  const byName = new Map();
  const bySignature = new Map();

  for (const row of rows) {
    const key = normaliseName(row.name);
    byName.set(key, (byName.get(key) ?? 0) + 1);
    const sig = redundancySignature(row);
    bySignature.set(sig, (bySignature.get(sig) ?? 0) + 1);
  }

  for (const row of rows) {
    row.nameKey = normaliseName(row.name);
    row.variants = byName.get(row.nameKey);
    row.redundant = bySignature.get(redundancySignature(row)) > 1;
    row.score = completeness(row);
  }

  return rows;
}

/**
 * Fold a list of rows according to the chosen mode.
 *
 * @param {object[]} rows   Already annotated by `annotateDuplicates`.
 * @param {string} mode     One of DEDUPE_MODES.
 * @returns {object[]}      Rows to display. In "name" mode each carries
 *                          `group` — every row it stands for, best first.
 */
export function foldDuplicates(rows, mode) {
  if (mode === "redundant") {
    // Keep the best of each identical-printing-in-the-same-pack cluster, so
    // hiding a copy never costs the more complete record.
    const best = new Map();
    for (const row of rows) {
      const sig = redundancySignature(row);
      const held = best.get(sig);
      if (!held || row.score > held.score) best.set(sig, row);
    }
    // Preserve the incoming order rather than the Map's insertion quirks.
    const keep = new Set(best.values());
    return rows.filter(row => keep.has(row));
  }

  if (mode === "name") {
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.nameKey)) groups.set(row.nameKey, []);
      groups.get(row.nameKey).push(row);
    }
    const folded = [];
    for (const [, members] of groups) {
      // Best first, so the representative is index 0 and the expansion reads
      // in a sensible order.
      const ordered = members.slice().sort((a, b) => b.score - a.score || a.uuid.localeCompare(b.uuid));
      folded.push({...ordered[0], group: ordered});
    }
    return folded.sort((a, b) => a.name.localeCompare(b.name));
  }

  return rows;
}

/**
 * A one-line summary of what the world actually contains, for the GM.
 *
 * Worth showing rather than hiding: someone with 2,000 redundant rows wants to
 * know that, and someone with none wants to know the filter is not lying to
 * them about what it is hiding.
 *
 * @param {object[]} rows  Annotated rows.
 * @returns {{total: number, distinct: number, redundant: number, multiSource: number}}
 */
export function duplicateStats(rows) {
  const names = new Set();
  const multi = new Set();
  let redundant = 0;
  for (const row of rows) {
    names.add(row.nameKey);
    if (row.variants > 1) multi.add(row.nameKey);
    if (row.redundant) redundant++;
  }
  return {
    total: rows.length,
    distinct: names.size,
    // Rows in a redundant cluster, minus the one kept from each.
    redundant: redundant ? redundant - new Set(rows.filter(r => r.redundant).map(redundancySignature)).size : 0,
    multiSource: multi.size
  };
}
