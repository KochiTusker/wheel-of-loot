/**
 * Rolling a wheel rather than building one by hand.
 *
 * Everything here is pure: given a pool of candidate rows and a random source,
 * it returns what the wheel should hold. That keeps the interesting decisions —
 * how slots divide, how rarity skews a draw — testable without a browser, and
 * keeps the builder file about buttons rather than arithmetic.
 */

import {mulberry32} from "./wheel-data.js";

/**
 * Split `total` slots between `weights.length` wedges, giving every wedge at
 * least one and matching the requested proportions as closely as integers allow.
 *
 * Uses largest-remainder, so the leftover slots go to whichever wedges were
 * rounded down hardest rather than always to the first one.
 *
 * @param {number} total      Slots to hand out. Must be >= weights.length.
 * @param {number[]} weights  Relative share per wedge. Zeroes are treated as equal.
 * @returns {number[]}        Integer slot counts, each >= 1, summing to `total`.
 */
export function distributeSlots(total, weights) {
  const n = weights.length;
  if (!n) return [];
  if (total < n) throw new Error(`distributeSlots: ${total} slots cannot cover ${n} wedges`);

  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? weights : weights.map(() => 1);
  const shareSum = sum > 0 ? sum : n;

  // One slot is reserved per wedge; only the surplus is shared out, so a wedge
  // can never be rounded out of existence.
  const spare = total - n;
  const raw = shares.map(w => (w / shareSum) * spare);
  const counts = raw.map(r => Math.floor(r));

  let used = counts.reduce((a, b) => a + b, 0);
  const byRemainder = raw
    .map((r, i) => ({i, frac: r - Math.floor(r)}))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; used < spare; k++, used++) counts[byRemainder[k % n].i]++;

  return counts.map(c => c + 1);
}

/**
 * How much of the wheel a prize of this rarity deserves.
 *
 * A wheel where a legendary is as likely as a healing potion is not a loot
 * wheel, it is a raffle. Weighting by position in the system's own rarity list
 * means this works anywhere without the module knowing what the rarities are
 * called — commonest gets the highest share, rarest the lowest, and a system
 * with no rarities at all falls through to a flat wheel.
 *
 * @param {?string} rarity
 * @param {string[]} rarities  Adapter's list, least to most rare.
 * @returns {number}
 */
export function rarityWeight(rarity, rarities) {
  if (!rarities?.length) return 1;
  const index = rarities.indexOf(rarity);
  // Unknown or absent rarity sits in the middle rather than skewing the wheel.
  if (index < 0) return Math.ceil(rarities.length / 2);
  return rarities.length - index;
}

/**
 * Draw `count` distinct rows from a pool.
 *
 * Rejects by uuid rather than by name, so two printings of the same item can
 * both be drawn — that is a real choice a GM might want, and the builder warns
 * about it separately.
 *
 * @param {object[]} pool
 * @param {number} count
 * @param {() => number} rng   Returns 0-1.
 * @param {Set<string>} [exclude]  uuids already spoken for.
 * @returns {object[]}
 */
export function drawDistinct(pool, count, rng, exclude = new Set()) {
  const available = pool.filter(row => !exclude.has(row.uuid));
  const wanted = Math.min(count, available.length);
  const picked = [];
  // Partial Fisher-Yates over a copy: correct for any pool size, and cheap
  // because it only shuffles as far as it needs to.
  const bag = available.slice();
  for (let i = 0; i < wanted; i++) {
    const j = i + Math.floor(rng() * (bag.length - i));
    [bag[i], bag[j]] = [bag[j], bag[i]];
    picked.push(bag[i]);
  }
  return picked;
}

/**
 * Plan a whole wheel from a pool.
 *
 * @param {object[]} pool          Catalogue rows to draw from.
 * @param {object} options
 * @param {number} options.wedges  How many distinct prizes.
 * @param {number} options.total   Slots on the wheel.
 * @param {boolean} [options.byRarity]   Skew slot shares toward commoner prizes.
 * @param {string[]} [options.rarities]  Adapter's rarity list.
 * @param {number} [options.seed]
 * @returns {{row: object, weight: number}[]}  Empty if the pool is empty.
 */
export function planWheel(pool, {wedges, total, byRarity = false, rarities = [], seed} = {}) {
  const rng = mulberry32(seed ?? Math.floor(Math.random() * 0xFFFFFFFF));
  // Never plan more wedges than there are slots to put them in, or prizes to
  // fill them with; both would otherwise throw deep inside distributeSlots.
  const n = Math.max(1, Math.min(wedges, total, pool.length));
  const rows = drawDistinct(pool, n, rng);
  if (!rows.length) return [];

  const weights = byRarity
    ? rows.map(r => rarityWeight(r.rarity, rarities))
    : rows.map(() => 1);

  return distributeSlots(total, weights).map((weight, i) => ({row: rows[i], weight}));
}
