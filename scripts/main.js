/**
 * Wheel of Loot — entry point.
 *
 * Everything substantial lives in `core/` (rules, layout, sockets, ledger),
 * `apps/` (the overlay, the builder, the launcher) and `systems/` (what one
 * game system means by rarity or coin). This file is only wiring: settings,
 * hooks, scene controls, the public API, and the one-time migration from the
 * id this module used to ship under.
 */

import {MODULE_ID, t} from "./core/constants.js";
import {getCredits, setSpins} from "./core/ledger.js";
import {S, registerSettings, resolveWheelConfig} from "./core/settings.js";
import {auditTable, buildEntries, describeFault, disperseSlots, SLOT_PRESETS, validateTable} from "./core/wheel-data.js";
import {callOwner, registerSocket, socketReady} from "./core/socket.js";
import {cancelWheel, registerSession, requestSpin, resolveWheel, sessions, startSession} from "./core/session.js";
import {LootWheel} from "./apps/wheel-app.js";
import {WheelBuilder} from "./apps/wheel-builder.js";
import {openLauncher, pickTable} from "./apps/launcher.js";
import {registerDnd5e} from "./systems/dnd5e.js";
import {WheelSettings} from "./apps/settings-menu.js";
import {runMigration} from "./core/migrate.js";
import {describeLastGrant, lastGrant, undoLastGrant} from "./core/undo.js";
import {invalidateCatalogue, isWorldItem, removeWorldItem, upsertWorldItem} from "./core/catalogue.js";

/* -------------------------------------------- */
/*  Client-side socket handlers                 */
/* -------------------------------------------- */

function openWheel(config) {
  LootWheel.present({
    ...config,
    // Routed to the wheel's owning GM rather than "any GM" — see callOwner.
    onSpin: id => callOwner("requestSpin", id),
    onResolve: (id, accepted, giftActorId) => callOwner("resolveWheel", id, accepted, giftActorId ?? null),
    onCancel: id => callOwner("cancelWheel", id)
  });
}

const clientHandlers = {
  openWheel,
  playSpin: payload => LootWheel.spinTo(payload),
  rearmWheel: sessionId => LootWheel.rearm(sessionId),
  closeWheel: sessionId => LootWheel.dismiss(sessionId),
  notify: message => ui.notifications.warn(message)
};

/* -------------------------------------------- */
/*  Public API                                  */
/* -------------------------------------------- */

/**
 * Present a wheel to the whole table. GM only.
 *
 * The wheel is view-only for everyone; interactivity comes from the spin
 * ledger, so pass `allocations` to hand out spins at the same time.
 *
 * @param {object} options
 * @param {RollTable|string} options.table               Table document or UUID.
 * @param {Record<string, number>} [options.allocations] userId -> spins to grant.
 * @returns {Promise<string|null>}  The session id, or null if it could not start.
 */
export async function present({table, allocations} = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn(t("Notify.GMOnly"));
    return null;
  }

  const doc = table instanceof RollTable ? table : await fromUuid(table);
  if (!doc) {
    ui.notifications.error(t("Notify.TableNotFound"));
    return null;
  }

  const faults = validateTable(doc);
  if (faults.length) {
    ui.notifications.error(t("Notify.TableNotReady", {name: doc.name, fault: describeFault(faults[0])}));
    return null;
  }

  // Every wedge must point at something that still exists, or the wheel can
  // land on a prize that cannot be handed over.
  const {missing} = await auditTable(doc);
  if (missing.length) {
    ui.notifications.error(t("Notify.EntriesMissing", {
      n: missing.length,
      names: missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : "")
    }));
    return null;
  }

  if (allocations) await setSpins.call({socketdata: {userId: game.user.id}}, allocations);

  const {entries, slots} = await buildEntries(doc);
  const seed = Math.floor(Math.random() * 0xFFFFFFFF);
  const layout = disperseSlots(entries, slots, seed);

  // Resolved here, on the GM, and carried with the session — see
  // resolveWheelConfig for why it is not read per-client.
  return startSession({table: doc, entries, layout, wheel: resolveWheelConfig(doc)});
}

/** Open the wheel builder. GM only. Prompts for a table when none is given. */
export async function build(table) {
  if (!game.user.isGM) return;
  let doc = table instanceof RollTable ? table : (table ? await fromUuid(table) : null);
  if (!doc) doc = await pickTable(t("Launcher.BuildWhich"), t("Launcher.OpenBuilder"));
  if (!doc) return;
  return WheelBuilder.open(doc);
}

/** Make a new wheel table and open the builder on it. GM only. */
export async function createTable() {
  return WheelBuilder.createNew();
}

/** Hand out spins without presenting anything new. GM only. */
export async function grant(allocations) {
  if (!game.user.isGM) return null;
  return setSpins.call({socketdata: {userId: game.user.id}}, allocations);
}

/**
 * Reverse the most recent grant, with a confirmation. GM only.
 *
 * @returns {Promise<boolean>} Whether anything was undone.
 */
export async function undo() {
  if (!game.user.isGM) return false;
  const description = describeLastGrant();
  if (!description) {
    ui.notifications.info(t("Undo.Nothing"));
    return false;
  }
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: {title: t("Undo.Title"), icon: "fa-solid fa-rotate-left"},
    content: `<p>${description}</p><p class="notes">${t("Undo.Note")}</p>`,
    modal: true
  });
  if (!ok) return false;

  const result = await undoLastGrant();
  if (result.ok) {
    ui.notifications.info(t("Undo.Done"));
    return true;
  }
  ui.notifications.warn(t(`Undo.Fail.${result.reason ?? "error"}`));
  return false;
}

/** Everything a macro or another module may reasonably call. */
const api = {present, build, createTable, grant, getCredits, undo};

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerDnd5e();
  registerSettings(WheelSettings, SLOT_PRESETS);
});

Hooks.once("socketlib.ready", () => {
  registerSocket({
    registerSession,
    requestSpin,
    resolveWheel,
    cancelWheel,
    setSpins,
    ...clientHandlers
  });
});

Hooks.once("ready", async () => {
  if (!socketReady()) {
    ui.notifications.error(t("Notify.NoSocketlib"));
    return;
  }
  game.modules.get(MODULE_ID).api = api;
  globalThis.wheelOfLoot = api;

  // Back-compat for macros written against the module's previous name. Cheap
  // insurance: a GM's hotbar is not something this module gets to invalidate.
  globalThis.sbtsLootWheel = {...api, edit: build};

  if (game.user.isGM) await runMigration();
});

// The ledger lives in a world setting, so every client learns about a grant
// through the Setting update rather than a bespoke broadcast.
Hooks.on("updateSetting", setting => {
  if (setting.key !== `${MODULE_ID}.${S.CREDITS}`) return;
  LootWheel.current?.refreshCredits();
});

/**
 * One button, in the sidebar where wheels actually live.
 *
 * An earlier version put three tools in the token scene controls, which is both
 * clutter and the wrong place: a wheel *is* a RollTable, so the RollTables tab
 * is where a GM already goes looking for one. Everything the module does is
 * reachable from the launcher this opens.
 */
/**
 * Keep the builder's item list in step with the world.
 *
 * A GM who makes a custom prize expects to find it on the wheel immediately,
 * not after remembering to press Refresh — the catalogue is cached for the
 * session, so without this it would stay invisible until something dropped it.
 *
 * World items are folded in surgically. A compendium change only drops the
 * cache, so the cost of re-indexing every pack is paid lazily, once, the next
 * time the catalogue is actually wanted — importing a whole book would
 * otherwise rebuild it hundreds of times.
 */
for (const [hook, apply] of [["createItem", upsertWorldItem], ["updateItem", upsertWorldItem],
                             ["deleteItem", removeWorldItem]]) {
  Hooks.on(hook, item => {
    if (!game.user.isGM) return;
    if (isWorldItem(item)) {
      if (apply(item)) WheelBuilder.refreshCatalogue();
      return;
    }
    // An item on an actor is inventory, not a candidate prize.
    if (item?.pack) invalidateCatalogue();
  });
}

/**
 * Offer the way back on the card that records the mistake.
 *
 * Only on the most recent grant, and only to a GM — an undo button on an old
 * card would either be a lie or a much bigger promise than this makes.
 */
Hooks.on("renderChatMessageHTML", (message, element) => {
  if (!game.user.isGM) return;
  const record = lastGrant();
  if (!record) return;
  const card = element.querySelector?.(".wol-card");
  if (!card || card.querySelector(".wol-undo")) return;
  if (message.getFlag(MODULE_ID, "sessionId") == null) return;
  // Only the card for the grant that is actually reversible.
  if (message.getFlag(MODULE_ID, "grantAt") !== record.at) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wol-undo";
  button.innerHTML = `<i class="fa-solid fa-rotate-left"></i> ${t("Undo.Button")}`;
  button.addEventListener("click", () => undo());
  card.append(button);
});

Hooks.on("renderRollTableDirectory", (app, element) => {
  if (!game.user.isGM) return;
  // v13+ hands over an HTMLElement; older cores hand over a jQuery object.
  const root = element instanceof HTMLElement ? element : element?.[0];
  const actions = root?.querySelector(".header-actions");
  // Re-renders are frequent and would otherwise stack up copies of the button.
  if (!actions || actions.querySelector(".wol-open")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "wol-open";
  button.innerHTML = `<i class="fa-solid fa-arrows-spin" inert></i><span>${t("Control.Open")}</span>`;
  button.addEventListener("click", () => openLauncher({present, getCredits, grant, createTable, build}));
  actions.append(button);
});

/**
 * A wheel is a RollTable, so offer the builder from the table's own sheet —
 * that is where a GM already goes to edit one.
 *
 * ApplicationV2 builds this hook's name as `getHeaderControls` plus the sheet
 * class name, walking the inheritance chain. v14 calls the sheet
 * `RollTableSheet`; older cores called it `RollTableConfig`. Registering both
 * costs nothing and means the button appears either way — only one will ever
 * fire, because only one class exists.
 */
for (const sheetClass of ["RollTableSheet", "RollTableConfig"]) {
  Hooks.on(`getHeaderControls${sheetClass}`, (app, controls) => {
    if (!game.user.isGM) return;
    controls.unshift({
      icon: "fa-solid fa-arrows-spin",
      label: "WHEELOFLOOT.Control.Build",
      onClick: () => WheelBuilder.open(app.document)
    });
  });
}

/**
 * Re-exported so the permission rules can be driven directly under test, and so
 * a macro can inspect live wheels. See `core/session.js` for why this is safe.
 */
export {sessions, requestSpin, resolveWheel, cancelWheel, registerSession};
