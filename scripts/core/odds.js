/**
 * Decoupling how big a wedge looks from how likely it is.
 *
 * By default the two are the same thing: a wedge with three of sixty-four slots
 * comes up three times in sixty-four. That is honest, and it is what a wheel
 * looks like it is doing.
 *
 * But a grand prize wants to be *seen*. A jackpot squeezed into one hair-thin
 * slice is invisible, and invisible prizes generate no anticipation — the whole
 * point of putting it on the wheel is that the players spend the spin hoping
 * for it. So a wedge can be given presence without being given the odds to
 * match: three slices wide, but weighted down to a fraction of the chance.
 *
 * `odds` is a per-wedge multiplier in percent, where **100 means "exactly as
 * likely as its size suggests"**. 25 makes it a quarter as likely; 400 makes it
 * four times as likely. Everything is integer arithmetic so the roll stays
 * auditable in Foundry's own dice log, and so a wheel where every wedge is left
 * at 100 rolls *identically* to one with no weighting at all.
 *
 * The builder shows the resulting true chance next to every wedge, because a GM
 * setting these needs to see what they have actually done rather than trust a
 * multiplier.
 */

/** "As likely as it looks." */
export const DEFAULT_ODDS = 100;

/** Below 1% of normal a wedge is decorative; above 20x it swamps the wheel. */
export const MIN_ODDS = 1;
export const MAX_ODDS = 2000;

export function clampOdds(value) {
  // Unset means "honest", not "impossible" — and an absent flag arrives here as
  // null, which Number() would helpfully turn into a zero and then a floor of 1.
  if (value === null || value === undefined || value === "") return DEFAULT_ODDS;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_ODDS;
  return Math.min(MAX_ODDS, Math.max(MIN_ODDS, n));
}

/**
 * How much of the roll each entry actually owns.
 *
 * Slots carry the visual weight, odds bend it. Multiplying keeps both meanings
 * intact: widening a wedge still makes it more likely, and weighting it down
 * still makes it rarer, and the two compose the way a GM would expect.
 *
 * @param {{count: number, odds?: number}[]} entries
 * @returns {number[]}
 */
export function effectiveWeights(entries) {
  return entries.map(e => {
    // A wedge whose stock has run out keeps its place on the rim — the hoard
    // visibly emptying is the point — but it can no longer be landed on.
    if (e.depleted) return 0;
    return Math.max(0, e.count ?? 0) * clampOdds(e.odds ?? DEFAULT_ODDS);
  });
}

/**
 * True when nothing on the wheel can still be won.
 *
 * Distinct from "the wheel is broken": every wedge may be perfectly valid and
 * simply claimed. The caller closes the wheel rather than reporting a fault.
 *
 * @param {object[]} entries
 * @returns {boolean}
 */
export function isExhausted(entries) {
  return entries.length > 0 && totalWeight(entries) <= 0;
}

/** Sum of the effective weights; the number of faces the spin rolls over. */
export function totalWeight(entries) {
  return effectiveWeights(entries).reduce((a, b) => a + b, 0);
}

/**
 * The real probability of each entry, 0-1.
 *
 * This is what the builder puts on screen. A wedge that looks like 3/64 but is
 * weighted to a quarter reports 1.2%, not 4.7%, and the GM can see the gap
 * between what the players will infer and what is true.
 *
 * @param {{count: number, odds?: number}[]} entries
 * @returns {number[]}
 */
export function trueChances(entries) {
  const weights = effectiveWeights(entries);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return weights.map(() => 0);
  return weights.map(w => w / total);
}

/**
 * Walk the cumulative weights to find which entry a roll landed on.
 *
 * @param {number[]} weights  From effectiveWeights.
 * @param {number} roll       1-based, in [1, sum(weights)].
 * @returns {number}          Entry index, or -1 if the roll is out of range.
 */
export function pickEntry(weights, roll) {
  // A roll below the first face is as much a fault as one above the last; both
  // must report rather than quietly resolving to an end of the table.
  if (!Number.isFinite(roll) || roll < 1) return -1;
  let cursor = 0;
  for (let i = 0; i < weights.length; i++) {
    cursor += weights[i];
    if (roll <= cursor) return i;
  }
  // Only reachable with an out-of-range roll; the caller treats it as a fault
  // rather than quietly handing out the last prize on the list.
  return -1;
}

/**
 * True when no wedge has been weighted, so the wheel is a plain one.
 *
 * Worth knowing: an unweighted wheel can take the simple flat roll, which keeps
 * the dice log readable and makes the common case provably unchanged.
 *
 * @param {{odds?: number}[]} entries
 * @returns {boolean}
 */
export function isUnweighted(entries) {
  return entries.every(e => clampOdds(e.odds ?? DEFAULT_ODDS) === DEFAULT_ODDS);
}

/**
 * True when the plain `1d<slices>` roll is not just simpler but *correct*.
 *
 * Two conditions, and both matter. Nobody may have bent the odds — that is what
 * `isUnweighted` says. And nothing may have been claimed: a spent wedge keeps
 * its slices on the rim so the hoard can be seen emptying, and a flat roll over
 * the slices would happily land on one, offering a prize that has already been
 * given away. The weighted walk is the only path that knows a wedge weighs
 * nothing.
 *
 * A wheel with no stock limits can never fail the second condition, so every
 * wheel built before remove-on-win existed still takes the flat roll it always
 * did, and its dice log is unchanged.
 *
 * @param {{odds?: number, depleted?: boolean}[]} entries
 * @returns {boolean}
 */
export function canRollFlat(entries) {
  return isUnweighted(entries) && !entries.some(e => e.depleted);
}

/**
 * Every slice index belonging to an entry.
 *
 * The layout scatters an entry's slices around the rim, so once the roll has
 * chosen *what* was won there is still a choice of *where* to stop. Any of them
 * is correct; the caller picks one so the wheel does not always halt on the
 * same slice for a repeat win.
 *
 * @param {number[]} layout  Slice -> entry index.
 * @param {number} entryIndex
 * @returns {number[]}
 */
export function slicesOf(layout, entryIndex) {
  const slices = [];
  for (let i = 0; i < layout.length; i++) if (layout[i] === entryIndex) slices.push(i);
  return slices;
}

/* -------------------------------------------- */
/*  Choosing                                    */
/* -------------------------------------------- */

/**
 * Choose the winning slice.
 *
 * Two paths, deliberately. A wheel where nobody has touched the odds and
 * nothing has been claimed takes a plain `1d<slices>` — the same roll the
 * module has always made, so a plain wheel is provably unchanged and its dice
 * log stays readable. See `canRollFlat` for why claimed wedges disqualify it.
 *
 * A weighted wheel rolls over the summed effective weights instead, walks the
 * cumulative total to find the entry, and then picks one of that entry's slices
 * to stop on. Picking among them matters: the layout scatters an entry's slices
 * around the rim, so always taking the first would make a repeat win visibly
 * land in the same place.
 *
 * Lives here rather than beside the session because the builder's dry run needs
 * it too, and a rehearsal that chose its winner by different arithmetic than the
 * real spin would be worth nothing. `Roll` is the one Foundry global this file
 * touches, and only on this path.
 *
 * @param {object[]} entries  From buildEntries: count, odds, depleted.
 * @param {number[]} layout   Slice -> entry index.
 * @returns {Promise<number|null>}  Slice index, or null if the roll fell outside
 *                                  the table — which should be impossible, and
 *                                  is reported rather than silently patched.
 */
export async function rollSlice(entries, layout) {
  if (canRollFlat(entries)) {
    const roll = await new Roll(`1d${layout.length}`).evaluate();
    return roll.total - 1;
  }

  const weights = effectiveWeights(entries);
  const total = totalWeight(entries);
  if (total <= 0) {
    console.error("Wheel of Loot | every wedge weighs nothing; cannot roll");
    return null;
  }

  const roll = await new Roll(`1d${total}`).evaluate();
  const entryIndex = pickEntry(weights, roll.total);
  if (entryIndex < 0) {
    console.error(`Wheel of Loot | roll ${roll.total} fell outside the weighted table of ${total}`);
    return null;
  }

  const slices = slicesOf(layout, entryIndex);
  if (!slices.length) {
    console.error(`Wheel of Loot | entry ${entryIndex} owns no slices`);
    return null;
  }
  return slices[Math.floor(Math.random() * slices.length)];
}
