/**
 * Turns a RollTable into the slices the wheel draws.
 *
 * The table stays the source of truth: a result's weight is how many slots it
 * owns. But Foundry gives each result one *contiguous* range, and a wheel where
 * three copies of an item sit side by side reads as one fat wedge. So the wheel
 * keeps its own layout — every slot the same size, each item's slots spaced
 * evenly around the rim — while the odds stay exactly what the weights say.
 *
 * The layout is built once by the GM and broadcast, so every client draws the
 * same wheel and lands on the same slice.
 *
 * Nothing here reads `system.*`. Anything system-shaped goes through the
 * adapter, so this file is the same in dnd5e as it is anywhere else.
 */

import {systemAdapter} from "../systems/adapter.js";
import {DEFAULT_ODDS, clampOdds} from "./odds.js";
import {MODULE_ID} from "./constants.js";

/** Wheel sizes offered in the builder. Any number in range is allowed. */
export const SLOT_PRESETS = [12, 16, 20, 24, 32, 48, 64, 96];
export const MIN_SLOTS = 2;
/** Past this, wedges are thinner than the text that has to fit in them. */
export const MAX_SLOTS = 120;

/** Classic fairground alternation, used for the slice backgrounds. */
export const WHEEL_PALETTE = ["#C1272D", "#F4EAD2", "#1F3A93", "#E8B31F"];

/** Coin wedges are not items and have no rarity, so they get their own ink. */
export const COIN_COLOUR = "#7a5c00";

/** Neutral ink for a system with no rarity concept at all. */
export const NEUTRAL_COLOUR = "#3f3f46";

export function clampSlots(n) {
  const value = Math.round(Number(n) || 0);
  return Math.min(MAX_SLOTS, Math.max(MIN_SLOTS, value || MIN_SLOTS));
}

/* -------------------------------------------- */
/*  Utilities                                   */
/* -------------------------------------------- */

/** Small deterministic PRNG so every client reproduces the same layout. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strip markup and squeeze whitespace out of a description. */
export function plainText(html, limit = 420) {
  if (!html) return "";
  const el = document.createElement("div");
  el.innerHTML = html;
  // Foundry secret blocks are GM-only prose; never surface them to players.
  el.querySelectorAll("section.secret").forEach(n => n.remove());
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/**
 * Description text with Foundry's inline syntax resolved.
 *
 * Rules text is littered with enrichers — `[[/save con 13 format=long]]`,
 * `[[/damage 1d6 type=necrotic]]` — which read as noise if the markup is simply
 * stripped. Enriching first turns them into the sentences a player expects.
 *
 * @param {string} html
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export async function richText(html, limit = 420) {
  if (!html) return "";
  let enriched = html;
  try {
    const editor = CONFIG.ux?.TextEditor ?? foundry.applications.ux.TextEditor.implementation;
    enriched = await editor.enrichHTML(html, {secrets: false});
  } catch (err) {
    console.warn("Wheel of Loot | could not enrich description, falling back to raw text", err);
  }
  return plainText(enriched, limit);
}

/* -------------------------------------------- */
/*  Slice colouring                             */
/* -------------------------------------------- */

/**
 * How many palette colours to cycle through for a wheel of this size.
 *
 * A four-colour cycle only looks right when the slice count divides by four;
 * at 18 slices the wrap puts two reds side by side. Dropping to the largest
 * divisor that fits keeps the alternation clean for most sizes.
 *
 * @param {number} total
 * @param {number} [paletteLength]
 * @returns {number}
 */
export function paletteCycle(total, paletteLength = WHEEL_PALETTE.length) {
  for (let k = paletteLength; k >= 2; k--) if (total % k === 0) return k;
  return paletteLength;
}

/**
 * Background colour per slice, never repeating across a boundary — including
 * the wrap from the last slice back to the first.
 *
 * A prime slice count has no clean cycle, so the seam is repaired directly:
 * the final wedge takes any colour its two neighbours are not using.
 *
 * @param {number} total
 * @param {string[]} [palette]
 * @returns {string[]}
 */
export function sliceColours(total, palette = WHEEL_PALETTE) {
  const k = paletteCycle(total, palette.length);
  const colours = Array.from({length: total}, (_, i) => palette[i % k]);
  if (total > 2 && colours[total - 1] === colours[0]) {
    const forbidden = new Set([colours[0], colours[total - 2]]);
    colours[total - 1] = palette.find(c => !forbidden.has(c)) ?? colours[total - 1];
  }
  return colours;
}

/**
 * How many characters of a name will fit on one wedge.
 *
 * At 64 slices a wedge is 5.6° wide and the name has to be cut short; at 12 it
 * has room to breathe. Scaling the budget with the sweep means a small wheel
 * stops truncating names that would have fitted easily.
 *
 * The floor of 34 is measured: truncating at 26 rendered "Potion of Healing
 * (Supreme)" and "(Superior)" almost identically, so the jackpot read as an
 * ordinary rare.
 *
 * @param {number} total
 * @returns {number}
 */
export function labelBudget(total) {
  if (total <= 16) return 64;
  if (total <= 32) return 48;
  return 34;
}

/** Wedge text has to shrink as the wheel gets busier, or the labels collide. */
export function labelFontSize(total) {
  if (total <= 16) return 26;
  if (total <= 24) return 22;
  if (total <= 40) return 18;
  // 15px is the size the original 64-slot wheel was tuned at, and a 34-character
  // label at that size was measured to just clear the hub. Anything larger here
  // starts overflowing a wheel that used to fit.
  if (total <= 72) return 15;
  return 13;
}

/**
 * A wedge's remaining stock, or null for an endless one.
 *
 * Zero is meaningful and must survive: it is a wedge that has been claimed, not
 * one with no limit, so the check is for null rather than for falsiness.
 *
 * @param {TableResult} result
 * @returns {?number}
 */
export function readStock(result) {
  const raw = result.getFlag?.(MODULE_ID, "stock");
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/* -------------------------------------------- */
/*  Reading the table                           */
/* -------------------------------------------- */

/**
 * The highest slot number the table's results cover.
 *
 * Read from the ranges rather than by parsing `formula`, because the ranges are
 * what actually partition the slots.
 *
 * @param {RollTable} table
 * @returns {number}
 */
export function slotCount(table) {
  let max = 0;
  for (const result of table.results) {
    const hi = result.range?.[1] ?? 0;
    if (hi > max) max = hi;
  }
  return max;
}

/**
 * Resolve every result into a wheel entry, pulling name, art, rarity and rules
 * text off the real document so the reveal can describe what was won.
 *
 * Takes results rather than the table they belong to, because it never needed
 * anything else — and because the builder's dry run has results that are not on
 * a table yet. A rehearsal assembled by lookalike code would be worth nothing;
 * this way the rehearsal and the real wheel are built by the same function.
 *
 * @param {Iterable<TableResult|object>} results
 * @returns {Promise<{entries: object[], slots: number, missing: string[]}>}
 */
export async function buildEntries(results) {
  const adapter = systemAdapter();
  const entries = [];
  const missing = [];

  const ordered = [...results].sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0));
  for (const result of ordered) {
    const lo = result.range?.[0] ?? 0;
    const hi = result.range?.[1] ?? 0;
    const count = lo && hi ? (hi - lo) + 1 : 0;
    if (!count) continue;

    const isDocument = result.type === CONST.TABLE_RESULT_TYPES.DOCUMENT;
    let doc = null;
    if (isDocument) {
      try {
        doc = result.documentUuid ? await fromUuid(result.documentUuid) : null;
      } catch {
        doc = null;
      }
      // A wedge pointing at a deleted item would spin, land, and grant nothing.
      if (!doc) missing.push(result.name || result.documentUuid || "(unnamed)");
    }

    const coin = !isDocument ? adapter.parseCurrency(result.name) : null;
    // A custom prize has no document to ask, so it carries its own rarity on a
    // flag. Without it a homebrew artifact would take the same neutral grey as a
    // torch, which is the one thing a rarity colour exists to prevent.
    const rarity = doc ? adapter.rarityOf(doc) : (result.getFlag?.(MODULE_ID, "rarity") || null);
    const description = doc ? adapter.descriptionOf(doc) : result.description;

    entries.push({
      uuid: doc ? result.documentUuid : null,
      name: doc?.name || result.name || game.i18n.localize("WHEELOFLOOT.Unknown"),
      img: doc?.img || result.img || "icons/svg/item-bag.svg",
      description: await richText(description),
      rarity,
      isCoin: !!coin,
      count,
      depleted: readStock(result) === 0,
      // How likely this wedge really is, independent of how wide it looks.
      odds: clampOdds(result.getFlag?.(MODULE_ID, "odds") ?? DEFAULT_ODDS),
      // The one wedge the table is really hoping for, if the GM named one.
      jackpot: result.getFlag?.(MODULE_ID, "jackpot") === true,
      // How many are left to give out. Null means an endless supply, which is
      // what every wedge was before this existed.
      stock: readStock(result),
      // Needed to write a decremented stock back to the right result.
      resultId: result.id ?? null,
      ink: coin ? COIN_COLOUR : (rarity ? adapter.rarityColour(rarity) : NEUTRAL_COLOUR)
    });
  }

  return {entries, slots: entries.reduce((a, e) => a + e.count, 0), missing};
}

/* -------------------------------------------- */
/*  Layout                                      */
/* -------------------------------------------- */

/**
 * Lay the entries out around the wheel so repeats are spread rather than
 * clumped.
 *
 * A plain shuffle leaves duplicates adjacent surprisingly often — with eight
 * copies of one potion in 64 slots you get visible runs. Instead each entry is
 * dealt onto evenly spaced ideal positions (stride = total / count) from a
 * random offset, then nudged to the nearest free slot. Heaviest entries are
 * placed first, so the crowded ones get the cleanest spacing and the singles
 * fill in around them.
 *
 * @param {object[]} entries  From buildEntries.
 * @param {number} total      Slot count.
 * @param {number} seed       Shared seed so all clients agree.
 * @returns {number[]}        For each slot, the index of its entry.
 */
export function disperseSlots(entries, total, seed) {
  const rng = mulberry32(seed);
  const layout = new Array(total).fill(-1);

  const order = entries
    .map((entry, index) => ({index, count: entry.count}))
    .sort((a, b) => b.count - a.count || a.index - b.index);

  for (const {index, count} of order) {
    const stride = total / count;
    const offset = rng() * stride;
    for (let i = 0; i < count; i++) {
      const ideal = Math.floor(offset + (i * stride)) % total;
      let placed = false;
      // Spiral outward from the ideal position to the nearest unclaimed slot.
      for (let d = 0; d < total && !placed; d++) {
        const forward = (ideal + d) % total;
        if (layout[forward] === -1) { layout[forward] = index; placed = true; break; }
        const back = ((ideal - d) % total + total) % total;
        if (layout[back] === -1) { layout[back] = index; placed = true; break; }
      }
      if (!placed) throw new Error("disperseSlots: ran out of slots");
    }
  }

  return layout;
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Problems worth blocking on before a wheel is shown to the whole table.
 *
 * Returns structured faults rather than sentences so the same check can run
 * under a test harness with no `game.i18n`; `describeFault` turns one into
 * prose at the point of display.
 *
 * @param {RollTable} table
 * @returns {{code: string, data: object}[]}  Empty means good to present.
 */
export function validateTable(table) {
  const faults = [];
  if (!table.results.size) return [{code: "Empty", data: {}}];

  const slots = slotCount(table);
  if (!slots) return [{code: "NoRanges", data: {}}];

  // Gaps land on nothing; overlaps make two entries claim the same slot.
  const covered = new Array(slots + 1).fill(0);
  for (const result of table.results) {
    const [lo, hi] = result.range ?? [];
    if (!lo || !hi) continue;
    for (let i = lo; i <= hi; i++) covered[i]++;
  }

  const gaps = [];
  const overlaps = [];
  for (let i = 1; i <= slots; i++) {
    if (covered[i] === 0) gaps.push(i);
    else if (covered[i] > 1) overlaps.push(i);
  }

  if (gaps.length) faults.push({code: "Gaps", data: {count: gaps.length, first: gaps[0]}});
  if (overlaps.length) faults.push({code: "Overlaps", data: {count: overlaps.length, first: overlaps[0]}});

  // A formula that can roll outside the ranges would land on nothing.
  const die = /^\s*1?d(\d+)\s*$/i.exec(table.formula ?? "");
  if (die) {
    const faces = Number(die[1]);
    if (faces > slots) faults.push({code: "FormulaHigh", data: {faces, slots}});
    else if (faces < slots) faults.push({code: "FormulaLow", data: {faces, slots, from: faces + 1}});
  }

  return faults;
}

/** Turn a structured fault into a sentence for the GM. */
export function describeFault(fault) {
  return game.i18n.format(`WHEELOFLOOT.Fault.${fault.code}`, fault.data);
}

/**
 * Confirm every non-coin wedge still points at something that exists.
 *
 * Items get deleted and compendiums get rebuilt; a stale UUID spins, lands, and
 * hands over nothing. Async because it has to actually resolve them.
 *
 * @param {RollTable} table
 * @returns {Promise<{missing: string[], text: string[]}>}
 */
export async function auditTable(table) {
  const adapter = systemAdapter();
  const missing = [];
  const text = [];
  for (const result of table.results) {
    if (result.type === CONST.TABLE_RESULT_TYPES.DOCUMENT) {
      let doc = null;
      try {
        doc = result.documentUuid ? await fromUuid(result.documentUuid) : null;
      } catch { doc = null; }
      if (!doc) missing.push(result.name || result.documentUuid || "(unnamed)");
    } else if (!adapter.parseCurrency(result.name)) {
      // Plain text that is not coin cannot be granted automatically.
      text.push(result.name);
    }
  }
  return {missing, text};
}
