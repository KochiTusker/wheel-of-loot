/**
 * Every knob, in one place.
 *
 * A loot wheel is a piece of table furniture, and tables differ: a pirate
 * campaign and a fae courtly one want different colours, a silver-standard
 * economy wants different coin wedges, and some GMs never want a player to be
 * able to refuse a prize. So the things that are genuinely a matter of taste
 * are settings rather than constants.
 *
 * Two rules keep this honest:
 *
 *   - **Every setting is wired.** A knob that does nothing is worse than no
 *     knob, so nothing is registered here that is not read somewhere.
 *   - **Parsing is pure and total.** A GM typing into a free-text field will
 *     eventually type nonsense; `parsePalette` and `parseNumberList` always
 *     return something usable rather than throwing into a render.
 */

import {MODULE_ID} from "./constants.js";

/* -------------------------------------------- */
/*  Keys                                        */
/* -------------------------------------------- */

export const S = {
  // Appearance
  PALETTE: "palette",
  PALETTE_CUSTOM: "paletteCustom",
  HUB_ICON: "hubIcon",
  WHEEL_SPEAKER: "wheelSpeaker",
  CONFETTI: "confetti",

  // Spin
  SPIN_SECONDS: "spinSeconds",
  SPIN_TURNS: "spinTurns",
  TICK_SOUND: "tickSound",
  TICK_VOLUME: "tickVolume",
  WIN_SOUND: "winSound",

  // Rules
  ALLOW_GIFT: "allowGift",
  ALLOW_REFUSE: "allowRefuse",
  GM_NEEDS_CREDIT: "gmNeedsCredit",
  AUTO_CLOSE: "autoClose",
  CHAT_CARD: "chatCard",

  // Builder
  DEFAULT_SLOTS: "defaultSlots",
  COIN_PRESETS: "coinPresets",
  COIN_DENOMINATION: "coinDenomination",

  // Internal
  CREDITS: "spinCredits",
  MIGRATED: "migratedFrom"
};

/* -------------------------------------------- */
/*  Palettes                                    */
/* -------------------------------------------- */

/**
 * Named slice palettes.
 *
 * Each is four colours because four alternates cleanly on most wheel sizes, but
 * nothing downstream depends on the count — `sliceColours` copes with any
 * palette of two or more.
 */
export const PALETTES = {
  fairground: ["#C1272D", "#F4EAD2", "#1F3A93", "#E8B31F"],
  midnight: ["#1B1F3B", "#3C2A5E", "#0E4C6B", "#6E4B9E"],
  verdant: ["#1E4D2B", "#D7E4C0", "#2E6F40", "#A3C68C"],
  ember: ["#7A1F1F", "#C1440E", "#E8A33D", "#2B1B12"],
  parchment: ["#EFE3C8", "#C8B48A", "#8A6E4B", "#3F2F20"],
  monochrome: ["#1C1C1C", "#E8E8E8", "#4A4A4A", "#B0B0B0"]
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Read a custom palette out of whatever the GM typed.
 *
 * Accepts commas, spaces or newlines as separators, with or without the leading
 * hash. Anything unparseable is dropped rather than rejected wholesale, so one
 * typo in a list of six colours costs that colour and not the whole theme.
 *
 * @param {string} input
 * @returns {string[]}  Valid hex colours; fewer than two means unusable.
 */
export function parsePalette(input) {
  if (typeof input !== "string") return [];
  return input
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.startsWith("#") ? part : `#${part}`))
    .filter(part => HEX.test(part));
}

/**
 * A positive-integer list, for the builder's coin presets.
 *
 * @param {string} input
 * @param {number} [limit]  Most values to keep, so a pasted essay cannot fill
 *                          the dropdown with a thousand options.
 * @returns {number[]}  Sorted ascending, deduplicated.
 */
export function parseNumberList(input, limit = 12) {
  if (typeof input !== "string") return [];
  const seen = new Set();
  for (const part of input.split(/[\s,]+/)) {
    const n = Number(part.replace(/,/g, "").trim());
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b).slice(0, limit);
}

/* -------------------------------------------- */
/*  Accessors                                   */
/* -------------------------------------------- */

/** Raw read, with a guard so a call before `init` cannot break a render. */
function read(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * The slice palette actually in force.
 *
 * A custom palette that does not parse to at least two colours falls back to
 * the named one rather than drawing an unreadable wheel.
 */
export function palette() {
  const name = read(S.PALETTE, "fairground");
  if (name === "custom") {
    const custom = parsePalette(read(S.PALETTE_CUSTOM, ""));
    if (custom.length >= 2) return custom;
    return PALETTES.fairground;
  }
  return PALETTES[name] ?? PALETTES.fairground;
}

export function hubIcon() {
  return read(S.HUB_ICON, "icons/svg/chest.svg") || "icons/svg/chest.svg";
}

export function wheelSpeaker() {
  const name = read(S.WHEEL_SPEAKER, "");
  return name.trim() || game.i18n.localize("WHEELOFLOOT.Card.Speaker");
}

export function confettiEnabled() {
  return read(S.CONFETTI, true) !== false;
}

/** How long the wheel takes to settle, in milliseconds. */
export function spinDuration() {
  return Math.round((Number(read(S.SPIN_SECONDS, 6)) || 6) * 1000);
}

/** Full rotations before the wheel settles. */
export function spinTurns() {
  return Math.max(1, Math.round(Number(read(S.SPIN_TURNS, 6)) || 6));
}

/** Client-scope: whether this player wants the fairground ticks. */
export function ticksEnabled() {
  return read(S.TICK_SOUND, true) !== false;
}

/** Client-scope tick loudness, 0-1. */
export function tickVolume() {
  const v = Number(read(S.TICK_VOLUME, 0.35));
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.35));
}

/** Optional sound played when the wheel lands. Empty means silence. */
export function winSound() {
  return (read(S.WIN_SOUND, "") || "").trim();
}

export function allowGift() {
  return read(S.ALLOW_GIFT, true) !== false;
}

export function allowRefuse() {
  return read(S.ALLOW_REFUSE, true) !== false;
}

/** When true, a GM must hold a credit like anyone else. */
export function gmNeedsCredit() {
  return read(S.GM_NEEDS_CREDIT, false) === true;
}

/** When false, the wheel stays open after the last spin is spent. */
export function autoClose() {
  return read(S.AUTO_CLOSE, true) !== false;
}

/** "public" | "gm" | "none" */
export function chatCardMode() {
  return read(S.CHAT_CARD, "public");
}

export function defaultSlots() {
  return Number(read(S.DEFAULT_SLOTS, 64)) || 64;
}

/** Coin amounts offered by the builder's Add-coin control. */
export function coinPresets() {
  const list = parseNumberList(read(S.COIN_PRESETS, ""));
  return list.length ? list : [10, 25, 50, 100, 250, 500, 1000];
}

/**
 * The denomination coin wedges are written in.
 *
 * A silver-standard campaign wants `sp` on the wedge, and the payout path reads
 * the denomination back out of the wedge name, so this has to drive the label
 * rather than being cosmetic.
 */
export function coinDenomination() {
  return (read(S.COIN_DENOMINATION, "gp") || "gp").trim().toLowerCase();
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/**
 * Register everything. Called once on `init`.
 *
 * The frequently-tweaked settings are `config: true` so they appear directly in
 * Foundry's module settings; the rest are grouped behind the menu, because a
 * flat wall of eighteen fields is not a granular experience, it is a form.
 *
 * @param {Function} MenuApplication  The settings menu form.
 * @param {number[]} slotPresets      Offered wheel sizes.
 */
export function registerSettings(MenuApplication, slotPresets) {
  const register = (key, data) => game.settings.register(MODULE_ID, key, {
    scope: "world", config: false, ...data
  });

  game.settings.registerMenu(MODULE_ID, "configure", {
    name: "WHEELOFLOOT.Setting.MenuName",
    label: "WHEELOFLOOT.Setting.MenuLabel",
    hint: "WHEELOFLOOT.Setting.MenuHint",
    icon: "fa-solid fa-sliders",
    type: MenuApplication,
    restricted: true
  });

  /* Appearance */
  register(S.PALETTE, {
    name: "WHEELOFLOOT.Setting.Palette",
    hint: "WHEELOFLOOT.Setting.PaletteHint",
    type: String,
    default: "fairground",
    choices: {
      ...Object.fromEntries(Object.keys(PALETTES).map(k => [k, `WHEELOFLOOT.Palette.${k}`])),
      custom: "WHEELOFLOOT.Palette.custom"
    }
  });
  register(S.PALETTE_CUSTOM, {type: String, default: ""});
  register(S.HUB_ICON, {type: String, default: "icons/svg/chest.svg"});
  register(S.WHEEL_SPEAKER, {type: String, default: ""});
  register(S.CONFETTI, {type: Boolean, default: true});

  /* Spin */
  register(S.SPIN_SECONDS, {
    name: "WHEELOFLOOT.Setting.SpinSeconds",
    hint: "WHEELOFLOOT.Setting.SpinSecondsHint",
    config: true,
    type: Number,
    range: {min: 2, max: 20, step: 0.5},
    default: 6
  });
  register(S.SPIN_TURNS, {type: Number, default: 6});

  // Client scope: whether you want the ticks is a matter of taste, and one
  // player muting them should not mute the table.
  register(S.TICK_SOUND, {
    name: "WHEELOFLOOT.Setting.TickSound",
    hint: "WHEELOFLOOT.Setting.TickSoundHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
  register(S.TICK_VOLUME, {scope: "client", type: Number, default: 0.35});
  register(S.WIN_SOUND, {type: String, default: ""});

  /* Rules */
  register(S.ALLOW_GIFT, {type: Boolean, default: true});
  register(S.ALLOW_REFUSE, {type: Boolean, default: true});
  register(S.GM_NEEDS_CREDIT, {type: Boolean, default: false});
  register(S.AUTO_CLOSE, {type: Boolean, default: true});
  register(S.CHAT_CARD, {type: String, default: "public"});

  /* Builder */
  register(S.DEFAULT_SLOTS, {
    name: "WHEELOFLOOT.Setting.DefaultSlots",
    hint: "WHEELOFLOOT.Setting.DefaultSlotsHint",
    config: true,
    type: Number,
    choices: Object.fromEntries(slotPresets.map(n => [n, `${n}`])),
    default: 64
  });
  register(S.COIN_PRESETS, {type: String, default: "10, 25, 50, 100, 250, 500, 1000"});
  register(S.COIN_DENOMINATION, {type: String, default: "gp"});

  /* Internal */
  register(S.CREDITS, {type: Object, default: {}});
  register(S.MIGRATED, {type: String, default: ""});
}
