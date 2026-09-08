/**
 * Every Item the world can see, in one flat list.
 *
 * The builder needs to browse candidates beside the wheel it is filling, which
 * means an index of *everything* classified as an Item: each Item-type
 * compendium, plus the world's own Items directory, which is where homebrew and
 * anything a GM has dragged out of a pack actually lives. Leaving world items
 * out was the single most confusing gap in the first version — a GM would make
 * a custom prize, then fail to find it.
 *
 * Building this touches every pack, so it is cached on first use and only
 * rebuilt when something asks it to be.
 *
 * Duplicate handling lives in `dedupe.js`; this file's job is to normalise
 * every source into the same row shape so that logic has something consistent
 * to work on, whatever system is running.
 */

import {annotateDuplicates} from "./dedupe.js";
import {systemAdapter} from "../systems/adapter.js";

/** Pack id used for the world's own Items directory, which has no collection. */
export const WORLD_PACK_ID = "__world__";

/** @type {object[]|null} */
let cache = null;

/**
 * @typedef {object} CatalogueRow
 * @property {string}  uuid
 * @property {string}  name
 * @property {string}  nameKey     Normalised name, for duplicate grouping.
 * @property {string}  img
 * @property {string}  itemType    The document's `type`.
 * @property {?string} rarity      Adapter-resolved; null in systems without rarity.
 * @property {string}  source      Book or publication, adapter-resolved.
 * @property {string}  profile     "single" | "charges" | "recharge"
 * @property {string}  packId
 * @property {string}  packLabel
 * @property {number}  variants    How many rows share this name.
 * @property {boolean} redundant   Same printing, same pack, listed more than once.
 * @property {number}  score       Completeness, for choosing a representative.
 */

/** Drop the cached index so the next build re-reads everything. */
export function invalidateCatalogue() {
  cache = null;
}

export function cachedCatalogue() {
  return cache ?? [];
}

/**
 * Turn one document or index row into a catalogue row.
 *
 * @param {object} entry      Index entry or Item document.
 * @param {string} uuid
 * @param {string} packId
 * @param {string} packLabel
 */
function toRow(entry, uuid, packId, packLabel) {
  const adapter = systemAdapter();
  const book = adapter.sourceOf(entry);
  return {
    uuid,
    name: entry.name,
    img: entry.img,
    itemType: entry.type,
    sub: foundry.utils.getProperty(entry, "system.type.value") ?? null,
    rarity: adapter.rarityOf(entry),
    // Fall back to the pack's own name so a system that records no book at all
    // still separates one compendium's copy from another's.
    source: book || packLabel,
    book,
    price: foundry.utils.getProperty(entry, "system.price.value") ?? null,
    usesMax: foundry.utils.getProperty(entry, "system.uses.max") ?? null,
    profile: adapter.useProfile(entry),
    packId,
    packLabel
  };
}

/**
 * Build (once) a flat list of every Item available to this world.
 *
 * @param {object} [options]
 * @param {boolean} [options.force]  Rebuild even if cached.
 * @returns {Promise<CatalogueRow[]>}
 */
export async function buildCatalogue({force = false} = {}) {
  if (cache && !force) return cache;
  const fields = systemAdapter().indexFields;
  const rows = [];

  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    let index;
    try {
      index = await pack.getIndex({fields});
    } catch (err) {
      // One unreadable pack must not cost the GM the whole catalogue.
      console.warn(`Wheel of Loot | could not index ${pack.collection}`, err);
      continue;
    }
    for (const entry of index) {
      rows.push(toRow(entry, `Compendium.${pack.collection}.Item.${entry._id}`, pack.collection, pack.metadata.label));
    }
  }

  // World items are already in memory, so no index call is needed; they are
  // full documents and answer every field directly.
  const worldLabel = game.i18n.localize("WHEELOFLOOT.Catalogue.WorldItems");
  for (const item of game.items) {
    rows.push(toRow(item, item.uuid, WORLD_PACK_ID, worldLabel));
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  annotateDuplicates(rows);

  cache = rows;
  return rows;
}

/** Look one row up by uuid, without forcing a rebuild. */
export function catalogueRow(uuid) {
  return cachedCatalogue().find(c => c.uuid === uuid) ?? null;
}

/** Every distinct item type present, for the builder's filter. */
export function catalogueTypes() {
  return [...new Set(cachedCatalogue().map(c => c.itemType))].sort();
}

/** Every pack present, for the builder's filter. World items sort first. */
export function cataloguePacks() {
  const seen = new Map();
  for (const row of cachedCatalogue()) {
    if (!seen.has(row.packId)) seen.set(row.packId, row.packLabel);
  }
  return [...seen.entries()]
    .map(([id, label]) => ({id, label}))
    .sort((a, b) => {
      if (a.id === WORLD_PACK_ID) return -1;
      if (b.id === WORLD_PACK_ID) return 1;
      return a.label.localeCompare(b.label);
    });
}

/** Every distinct source book present, for the builder's filter. */
export function catalogueSources() {
  const seen = new Set();
  for (const row of cachedCatalogue()) if (row.book) seen.add(row.book);
  return [...seen].sort((a, b) => a.localeCompare(b));
}
