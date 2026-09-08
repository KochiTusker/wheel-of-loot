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
import {SETTING_CREDITS, SETTING_SPIN_SECONDS, SETTING_TICKS, getCredits, setSpins} from "./core/ledger.js";
import {auditTable, buildEntries, describeFault, disperseSlots, SLOT_PRESETS, validateTable} from "./core/wheel-data.js";
import {callOwner, registerSocket, socketReady} from "./core/socket.js";
import {cancelWheel, registerSession, requestSpin, resolveWheel, sessions, startSession} from "./core/session.js";
import {LootWheel} from "./apps/wheel-app.js";
import {WheelBuilder} from "./apps/wheel-builder.js";
import {openLauncher, pickTable} from "./apps/launcher.js";
import {registerDnd5e} from "./systems/dnd5e.js";
import {runMigration} from "./core/migrate.js";

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

  return startSession({table: doc, entries, layout});
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

/** Everything a macro or another module may reasonably call. */
const api = {present, build, createTable, grant, getCredits};

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerDnd5e();

  game.settings.register(MODULE_ID, SETTING_SPIN_SECONDS, {
    name: "WHEELOFLOOT.Setting.SpinSeconds",
    hint: "WHEELOFLOOT.Setting.SpinSecondsHint",
    scope: "world",
    config: true,
    type: Number,
    range: {min: 2, max: 20, step: 0.5},
    default: 6
  });

  game.settings.register(MODULE_ID, "defaultSlots", {
    name: "WHEELOFLOOT.Setting.DefaultSlots",
    hint: "WHEELOFLOOT.Setting.DefaultSlotsHint",
    scope: "world",
    config: true,
    type: Number,
    choices: Object.fromEntries(SLOT_PRESETS.map(n => [n, `${n}`])),
    default: 64
  });

  // Client scope: whether you want the fairground ticks is a matter of taste,
  // and one player muting them should not mute the table.
  game.settings.register(MODULE_ID, SETTING_TICKS, {
    name: "WHEELOFLOOT.Setting.TickSound",
    hint: "WHEELOFLOOT.Setting.TickSoundHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  // The ledger. World scope means only a GM can write it, and every client is
  // updated automatically when it changes.
  game.settings.register(MODULE_ID, SETTING_CREDITS, {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // Set once the rename migration has run, so it never runs twice.
  game.settings.register(MODULE_ID, "migratedFrom", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
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

  if (game.user.isGM) await runMigration();
});

// The ledger lives in a world setting, so every client learns about a grant
// through the Setting update rather than a bespoke broadcast.
Hooks.on("updateSetting", setting => {
  if (setting.key !== `${MODULE_ID}.${SETTING_CREDITS}`) return;
  LootWheel.current?.refreshCredits();
});

Hooks.on("getSceneControlButtons", controls => {
  if (!game.user.isGM) return;
  const tokens = controls.tokens;
  if (!tokens?.tools) return;

  const order = Object.keys(tokens.tools).length;

  tokens.tools[`${MODULE_ID}-present`] = {
    name: `${MODULE_ID}-present`,
    title: "WHEELOFLOOT.Control.Present",
    icon: "fa-solid fa-arrows-spin",
    button: true,
    visible: true,
    order,
    onChange: () => openLauncher({present, getCredits, grant, createTable})
  };

  tokens.tools[`${MODULE_ID}-build`] = {
    name: `${MODULE_ID}-build`,
    title: "WHEELOFLOOT.Control.Build",
    icon: "fa-solid fa-sliders",
    button: true,
    visible: true,
    order: order + 1,
    onChange: () => build()
  };

  tokens.tools[`${MODULE_ID}-new`] = {
    name: `${MODULE_ID}-new`,
    title: "WHEELOFLOOT.Control.New",
    icon: "fa-solid fa-circle-plus",
    button: true,
    visible: true,
    order: order + 2,
    onChange: () => createTable()
  };
});

/**
 * A wheel is a RollTable, so offer the builder from the table's own sheet —
 * that is where a GM already goes to edit one.
 */
Hooks.on("getHeaderControlsRollTableConfig", (app, buttons) => {
  if (!game.user.isGM) return;
  buttons.unshift({
    icon: "fa-solid fa-arrows-spin",
    label: "WHEELOFLOOT.Control.Build",
    onClick: () => WheelBuilder.open(app.document)
  });
});

/**
 * Re-exported so the permission rules can be driven directly under test, and so
 * a macro can inspect live wheels. See `core/session.js` for why this is safe.
 */
export {sessions, requestSpin, resolveWheel, cancelWheel, registerSession};
