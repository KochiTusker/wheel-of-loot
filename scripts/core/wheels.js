/**
 * Which RollTables are wheels, and what can be done to them.
 *
 * A wheel *is* a RollTable, which is the module's best decision — it inherits
 * folders, permissions, import and export, and a GM already knows where to find
 * one. The cost is that a world full of encounter tables, treasure tables and
 * name generators offers all of them as wheels, and in a busy world that list
 * is useless.
 *
 * So a wheel says it is one. The flag is set when the module creates a table
 * and when it saves one, and anything carrying results with slot ranges is
 * treated as a wheel anyway — a table built before the flag existed should not
 * have to be re-made to be recognised.
 */

import {MODULE_ID} from "./constants.js";
import {slotCount, validateTable} from "./wheel-data.js";
import {wheelOverrides} from "./settings.js";

/** Mark a table as a wheel. */
export async function markAsWheel(table) {
  return table.setFlag(MODULE_ID, "isWheel", true);
}

/**
 * Whether a table should be offered as a wheel.
 *
 * Deliberately generous. An explicit flag is definitive, but a table the module
 * has never touched still counts if its results carry slot ranges, because that
 * is what a wheel is made of — refusing to recognise one would strand every
 * table built before the flag existed.
 *
 * @param {RollTable} table
 * @returns {boolean}
 */
export function isWheel(table) {
  if (!table) return false;
  try {
    if (table.getFlag(MODULE_ID, "isWheel")) return true;
  } catch { /* a table from a pack this client cannot read */ }
  return slotCount(table) > 0;
}

/**
 * Every wheel in the world, with what a manager needs to describe it.
 *
 * Sorted by folder then name so the list matches the sidebar a GM already
 * knows, rather than inventing an order of its own.
 *
 * @returns {object[]}
 */
export function listWheels() {
  return game.tables.contents
    .filter(isWheel)
    .map(table => {
      const faults = validateTable(table);
      return {
        table,
        id: table.id,
        uuid: table.uuid,
        name: table.name,
        img: table.img,
        folder: table.folder?.name ?? "",
        slots: slotCount(table),
        wedges: table.results.size,
        faults,
        broken: faults.length > 0,
        customised: Object.keys(wheelOverrides(table)).length > 0,
        // A wheel whose every prize is claimed is finished until it is
        // restocked, and that is worth seeing before presenting it.
        exhausted: isFullyClaimed(table),
        limited: countLimited(table)
      };
    })
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
}

/** How many wedges carry a stock count at all. */
function countLimited(table) {
  let n = 0;
  for (const result of table.results) {
    const stock = result.getFlag?.(MODULE_ID, "stock");
    if (stock !== undefined && stock !== null && stock !== "") n++;
  }
  return n;
}

/**
 * True when every wedge that can run out has, and nothing else remains.
 *
 * Read off the table rather than a live session, so the manager can say it
 * about a wheel nobody has opened.
 */
export function isFullyClaimed(table) {
  if (!table.results.size) return false;
  for (const result of table.results) {
    const stock = result.getFlag?.(MODULE_ID, "stock");
    const spent = stock !== undefined && stock !== null && stock !== "" && Number(stock) <= 0;
    if (!spent) return false;
  }
  return true;
}

/**
 * Put every limited wedge back to a given count.
 *
 * The counterpart to a hoard emptying: a GM who wants to run the same wheel for
 * a second party needs one button, not a trip through every wedge.
 *
 * @param {RollTable} table
 * @param {?number} to  A count, or null to make every wedge endless again.
 */
export async function restock(table, to = null) {
  const updates = [];
  for (const result of table.results) {
    const stock = result.getFlag?.(MODULE_ID, "stock");
    // Only wedges that were limited in the first place; an endless wedge is
    // not "restocked to one", it is left alone.
    if (stock === undefined || stock === null || stock === "") continue;
    updates.push({_id: result.id, [`flags.${MODULE_ID}.stock`]: to});
  }
  if (updates.length) await table.updateEmbeddedDocuments("TableResult", updates);
  return updates.length;
}

/**
 * Copy a wheel, results and all.
 *
 * `toObject` carries the flags with it, so odds, jackpot and stock survive —
 * copying a wheel and losing its tuning would make the feature pointless.
 *
 * @param {RollTable} table
 * @returns {Promise<RollTable|null>}
 */
export async function duplicateWheel(table) {
  const data = table.toObject();
  delete data._id;
  data.name = game.i18n.format("WHEELOFLOOT.Manager.CopyName", {name: table.name});
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.isWheel`, true);
  return RollTable.create(data);
}
