/**
 * One-time migration from the id this module shipped under before 2.0.0.
 *
 * Two things carry the old namespace: the spin ledger, which is a world
 * setting, and a `wonFrom` flag on every item a wheel has ever handed out.
 * Neither is load-bearing, but both are the kind of thing a GM notices going
 * missing, so they are brought across rather than abandoned.
 *
 * Two rules govern everything here. It is **additive** — nothing is deleted,
 * renamed or overwritten, so the worst case of a wrong guess is a redundant
 * flag rather than a lost one. And it **asks first**, because a silent bulk
 * write across every actor in a world is not something to spring on a GM.
 */

import {LEGACY_MODULE_ID, MODULE_ID, t} from "./constants.js";
import {getCredits, writeCredits} from "./ledger.js";

/**
 * Read a setting belonging to another package without registering it.
 *
 * `game.settings.get` refuses a namespace this module does not own, but the
 * world's Setting documents are plain data and can be read directly — which is
 * exactly what is needed for a namespace that no longer exists.
 *
 * @param {string} key  Fully qualified, e.g. "old-module.someSetting".
 * @returns {any|null}
 */
function readForeignSetting(key) {
  try {
    const store = game.settings.storage.get("world");
    const doc = store?.find?.(s => s.key === key) ?? store?.getSetting?.(key);
    if (!doc) return null;
    const raw = doc.value;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    console.warn("Wheel of Loot | could not read legacy setting", err);
    return null;
  }
}

/** Every item in the world still carrying the old provenance flag. */
function findLegacyItems() {
  const hits = [];
  for (const actor of game.actors) {
    for (const item of actor.items) {
      const wonFrom = item.flags?.[LEGACY_MODULE_ID]?.wonFrom;
      // Skip anything already carrying the new flag, so re-running is harmless.
      if (wonFrom && !item.flags?.[MODULE_ID]?.wonFrom) hits.push({actor, item, wonFrom});
    }
  }
  for (const item of game.items) {
    const wonFrom = item.flags?.[LEGACY_MODULE_ID]?.wonFrom;
    if (wonFrom && !item.flags?.[MODULE_ID]?.wonFrom) hits.push({actor: null, item, wonFrom});
  }
  return hits;
}

/**
 * Offer to bring the old module's data across. GM only, once per world.
 *
 * @returns {Promise<boolean>} Whether anything was migrated.
 */
export async function runMigration() {
  if (game.settings.get(MODULE_ID, "migratedFrom")) return false;

  const legacyLedger = readForeignSetting(`${LEGACY_MODULE_ID}.spinCredits`) ?? {};
  const outstanding = Object.values(legacyLedger).reduce((a, n) => a + (Number(n) || 0), 0);
  const legacyItems = findLegacyItems();

  // Nothing to do: record that and never look again.
  if (!outstanding && !legacyItems.length) {
    await game.settings.set(MODULE_ID, "migratedFrom", "nothing-found");
    return false;
  }

  const go = await foundry.applications.api.DialogV2.confirm({
    window: {title: t("Migrate.Title"), icon: "fa-solid fa-arrow-right-arrow-left"},
    content: `
      <p>${t("Migrate.Body")}</p>
      <ul>
        ${outstanding ? `<li>${t("Migrate.Ledger", {n: outstanding})}</li>` : ""}
        ${legacyItems.length ? `<li>${t("Migrate.Items", {n: legacyItems.length})}</li>` : ""}
      </ul>
      <p class="notes">${t("Migrate.Safety")}</p>`,
    modal: true
  });

  if (!go) {
    // "Not now" must not mean "never" — leave the marker unset so the offer
    // comes back next session.
    ui.notifications.info(t("Migrate.Skipped"));
    return false;
  }

  let movedItems = 0;
  try {
    if (outstanding) {
      // Merge rather than replace: a credit granted since the upgrade wins.
      const merged = {...legacyLedger, ...getCredits()};
      await writeCredits(merged);
    }

    // Group by actor so each one takes a single embedded update rather than one
    // per item, which matters in a world with a lot of wheel history.
    const byActor = new Map();
    const worldUpdates = [];
    for (const {actor, item, wonFrom} of legacyItems) {
      const update = {_id: item.id, [`flags.${MODULE_ID}.wonFrom`]: wonFrom};
      if (actor) {
        if (!byActor.has(actor)) byActor.set(actor, []);
        byActor.get(actor).push(update);
      } else {
        worldUpdates.push(update);
      }
    }
    for (const [actor, updates] of byActor) {
      await actor.updateEmbeddedDocuments("Item", updates);
      movedItems += updates.length;
    }
    if (worldUpdates.length) {
      await Item.updateDocuments(worldUpdates);
      movedItems += worldUpdates.length;
    }

    await game.settings.set(MODULE_ID, "migratedFrom", LEGACY_MODULE_ID);
    ui.notifications.info(t("Migrate.Done", {spins: outstanding, items: movedItems}));
    return true;
  } catch (err) {
    // Leaving the marker unset means a failed run can simply be tried again;
    // every write was additive, so a partial pass is not a corrupt state.
    console.error("Wheel of Loot | migration failed", err);
    ui.notifications.error(t("Migrate.Failed"));
    return false;
  }
}
