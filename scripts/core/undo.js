/**
 * Taking back the last thing the wheel gave away.
 *
 * Wheels go wrong in ways nothing else does: the wrong player clicks, the GM
 * meant to present a different table, a prize turns out to break the encounter
 * that was about to happen. Without a way back, the only options are editing an
 * actor by hand or letting it stand — and a GM who has been burned once starts
 * hesitating before presenting a wheel at all, which costs far more than the
 * feature does.
 *
 * Three rules make this safe to offer:
 *
 *   - **It only ever reverses something this module did.** The item is matched
 *     by id *and* by the `wonFrom` flag the grant stamped on it. Anything that
 *     does not match is left alone and reported, rather than deleted on trust.
 *   - **It is one deep.** Only the most recent grant is reversible. A general
 *     undo stack over live game state is a much larger promise than this needs
 *     to make, and a stale one would be worse than none.
 *   - **The spin comes back.** Reversing the prize without refunding the credit
 *     would quietly cost the player their turn.
 */

import {MODULE_ID, t} from "./constants.js";
import {getCredits, writeCredits} from "./ledger.js";
import {systemAdapter} from "../systems/adapter.js";

export const SETTING_LAST_GRANT = "lastGrant";

/**
 * Remember what was just handed over, so it can be handed back.
 *
 * World scope: only a GM can write it, and any GM can undo, which matters when
 * the GM who presented the wheel is not the one who spots the mistake.
 *
 * @param {object|null} record  Null clears it.
 */
export async function recordGrant(record) {
  return game.settings.set(MODULE_ID, SETTING_LAST_GRANT, record ?? {});
}

/** @returns {object|null} The reversible grant, or null if there is none. */
export function lastGrant() {
  const record = game.settings.get(MODULE_ID, SETTING_LAST_GRANT);
  return record && record.actorId ? record : null;
}

/**
 * A short description of what would be undone, for a confirmation dialog.
 *
 * @returns {string|null}
 */
export function describeLastGrant() {
  const record = lastGrant();
  if (!record) return null;
  const actor = game.actors.get(record.actorId);
  return t("Undo.Describe", {
    prize: record.prizeName ?? t("Unknown"),
    actor: actor?.name ?? t("Unknown")
  });
}

/**
 * Whether an item is the one this grant record describes.
 *
 * @param {Item} item
 * @param {object} record
 * @returns {boolean}
 */
export function isOurGrant(item, record) {
  const uuid = item.getFlag?.(MODULE_ID, "wonFromUuid");
  // Both sides know the uuid: the strong check, and rename-proof.
  if (uuid && record.tableUuid) return uuid === record.tableUuid;
  // Granted before the uuid was stamped. Fall back to the name it was given at
  // the time, which is exactly as good as the check has always been.
  return item.getFlag?.(MODULE_ID, "wonFrom") === record.tableName;
}

/**
 * Reverse the most recent grant. GM only.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function undoLastGrant() {
  if (!game.user.isGM) return {ok: false, reason: "notGM"};

  const record = lastGrant();
  if (!record) return {ok: false, reason: "nothing"};

  const actor = game.actors.get(record.actorId);
  if (!actor) return {ok: false, reason: "noActor"};

  try {
    if (record.itemId) {
      const item = actor.items.get(record.itemId);
      if (!item) return {ok: false, reason: "itemGone"};
      // Never delete on the id alone: an id can be reused, and the point of the
      // check is to be sure this is the document the wheel created rather than
      // whatever has since taken its place.
      //
      // Matched on the table's uuid, not its name. Renaming a wheel between the
      // win and the undo is an ordinary thing to do and used to make the prize
      // unreturnable. The name is still accepted for items granted before the
      // uuid was stamped, so an older win is not stranded.
      if (!isOurGrant(item, record)) return {ok: false, reason: "notOurs"};
      await item.delete();
    } else if (record.coins) {
      const adapter = systemAdapter();
      const path = `system.currency.${record.coins.denom}`;
      const held = foundry.utils.getProperty(actor, path);
      if (typeof held !== "number") return {ok: false, reason: "noPurse"};
      // Never drive a purse negative: if the player has already spent it, take
      // back what is there and say so rather than inventing a debt.
      await actor.update({[path]: Math.max(0, held - record.coins.amount)});
    }

    // The spin was spent to get here, so it comes back with the prize.
    if (record.spinnerId && !record.spinnerWasGM) {
      const map = getCredits();
      map[record.spinnerId] = (Number(map[record.spinnerId]) || 0) + 1;
      await writeCredits(map);
    }

    await recordGrant(null);
    return {ok: true};
  } catch (err) {
    console.error("Wheel of Loot | undo failed", err);
    return {ok: false, reason: "error"};
  }
}
