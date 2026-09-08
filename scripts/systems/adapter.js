/**
 * The seam between the wheel and whatever game system it is running in.
 *
 * Everything the wheel needs to know that is *not* true of Foundry in general
 * lives behind this interface: what a rarity is, how to pay someone in coin,
 * whether an item is single-use, which actors may receive a prize. The core —
 * layout, sockets, the ledger, the overlay, the builder — never touches
 * `system.*` directly, so a new system is one new file and one `register` call.
 *
 * A system that has no adapter still works. The generic adapter below answers
 * every question in the most defensible way it can from documents alone, and
 * the UI hides the affordances it cannot support rather than showing controls
 * that would do nothing.
 */

/** @type {Map<string, SystemAdapter>} game system id -> adapter */
const REGISTRY = new Map();

/**
 * @typedef {object} SystemAdapter
 * @property {string}   id             The `game.system.id` this serves.
 * @property {string[]} indexFields    Extra compendium index fields to request.
 * @property {string[]} rarities       Rarity keys, least to most rare. May be empty.
 * @property {(key: string) => string} rarityColour   Ink a rarity's name is printed in.
 * @property {(key: string) => string} rarityLabel    Display name for a rarity.
 * @property {(source: object) => string|null} rarityOf   Rarity of a document or index row.
 * @property {(source: object) => "single"|"charges"|"recharge"} useProfile
 * @property {boolean}  tracksUses     False hides the single-use filter entirely.
 * @property {(name: string) => {denom: string, amount: number}|null} parseCurrency
 * @property {(actor: Actor, payout: object) => Promise<boolean>} grantCurrency
 * @property {(actor: Actor) => boolean} isRewardable  May this actor receive a prize?
 * @property {(source: object) => string} descriptionOf  Raw description HTML.
 * @property {(source: object) => string} sourceOf   Book or publication an entry came from.
 * @property {(source: object) => string|null} priceOf     Display-ready price, or null.
 * @property {(source: object) => number|null} usesMaxOf   Charge capacity, or null.
 * @property {(source: object) => string|null} subtypeOf   Item subtype, or null.
 */

/* -------------------------------------------- */
/*  Generic fallback                            */
/* -------------------------------------------- */

/**
 * Where a system records which book an entry came from.
 *
 * This is the field that tells a reprint from a duplicate, so getting it right
 * in an unknown system materially improves duplicate detection. Different
 * systems disagree entirely — dnd5e uses `system.source.book`, pf2e uses
 * `system.publication.title`, older content uses a bare string — so the generic
 * adapter tries the shapes that actually occur rather than guessing one.
 */
const SOURCE_PATHS = [
  "system.source.book",
  "system.source.custom",
  "system.source.title",
  "system.publication.title",
  "system.details.source.book",
  "system.details.source",
  "system.source"
];

/**
 * Price, charges and subtype: the three fields that tell one *printing* of an
 * item from another.
 *
 * They exist here rather than being read inline because they are what the
 * duplicate detector discriminates on. Read through dnd5e's paths in a pf2e
 * world they all come back empty, every printing scores identically, and the
 * fold silently stops distinguishing the ten-charge Dust of Dryness from the
 * one-charge one. Getting them wrong does not throw; it quietly makes the
 * feature useless, which is worse.
 */
const PRICE_PATHS = ["system.price.value", "system.price", "system.cost.value", "system.cost"];
const USES_PATHS = ["system.uses.max", "system.uses.value", "system.charges.max", "system.charges.value"];
const SUBTYPE_PATHS = ["system.type.value", "system.category", "system.itemType", "system.subtype", "system.group"];

/**
 * Reduce whatever a system keeps at one of those paths to something comparable.
 *
 * Systems disagree wildly: a number, a string, or a record like `{gp: 5}`. An
 * object is flattened deterministically rather than dropped, because "5 gp" and
 * "3 sp" have to end up different for the fold to work at all.
 */
function scalar(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || typeof value === "string") return String(value);
  if (typeof value === "object") {
    const parts = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`);
    return parts.length ? parts.join(" ") : null;
  }
  return null;
}

/** Description lives in a different place in almost every system. Try the common ones. */
const DESCRIPTION_PATHS = [
  "system.description.value",
  "system.description",
  "system.details.description.value",
  "system.details.biography.value",
  "system.notes"
];

/**
 * Words a GM might type for coin, mapped to the key a system is likely to use.
 *
 * Deliberately not a closed list of denominations: the generic adapter only
 * pays out if the actor turns out to *have* that key, so an unknown word simply
 * declines rather than writing junk onto a sheet.
 */
const COIN_WORDS = {
  pp: "pp", platinum: "pp",
  gp: "gp", gold: "gp",
  ep: "ep", electrum: "ep",
  sp: "sp", silver: "sp",
  cp: "cp", copper: "cp"
};

/**
 * The adapter used when nothing is registered for the running system.
 *
 * It answers from the document alone. No rarity (so wedge names take the
 * neutral ink), no use profile (so the single-use filter hides), and coin only
 * if the actor already has a matching `system.currency` key holding a number.
 */
export const GENERIC_ADAPTER = {
  id: "generic",
  indexFields: ["img", "type"],
  rarities: [],
  tracksUses: false,

  rarityColour: () => "#3f3f46",
  rarityLabel: key => String(key ?? ""),
  rarityOf: () => null,
  useProfile: () => "single",

  /**
   * Parse "250 gp" out of a wedge name.
   *
   * Currency is not an Item in any system, so a coin wedge cannot be granted
   * down the document path; it has to move the actor's purse. Encoding it in
   * the name keeps table authoring to plain typing, with no flags to remember.
   */
  parseCurrency(name) {
    const match = /^\s*(\d[\d,]*)\s*([a-z]{2,10})\b/i.exec(name ?? "");
    if (!match) return null;
    const denom = COIN_WORDS[match[2].toLowerCase()] ?? match[2].toLowerCase();
    const amount = Number(match[1].replace(/,/g, ""));
    if (!Number.isInteger(amount) || amount <= 0) return null;
    return {denom, amount};
  },

  /**
   * Add coin to a purse, but only where one demonstrably exists.
   *
   * Returning false rather than throwing lets the caller report "accepted, but
   * hand this over manually" instead of implying the player was paid.
   */
  async grantCurrency(actor, {denom, amount}) {
    const path = `system.currency.${denom}`;
    const held = foundry.utils.getProperty(actor, path);
    if (typeof held !== "number") return false;
    await actor.update({[path]: held + amount});
    return true;
  },

  /**
   * Any actor that some player has been assigned may receive loot.
   *
   * Systems disagree about what an actor "type" means, but every system agrees
   * about `user.character`, so that is the check that travels.
   */
  isRewardable(actor) {
    if (!actor) return false;
    return game.users.some(u => u.character?.id === actor.id);
  },

  /**
   * Best-effort book name. Returns "" rather than null so callers can join it
   * into a signature without special-casing.
   */
  sourceOf(entry) {
    for (const path of SOURCE_PATHS) {
      const value = foundry.utils.getProperty(entry, path);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  },

  priceOf(entry) {
    for (const path of PRICE_PATHS) {
      const value = scalar(foundry.utils.getProperty(entry, path));
      if (value !== null) return value;
    }
    return null;
  },

  usesMaxOf(entry) {
    for (const path of USES_PATHS) {
      const value = Number(foundry.utils.getProperty(entry, path));
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  },

  subtypeOf(entry) {
    for (const path of SUBTYPE_PATHS) {
      const value = foundry.utils.getProperty(entry, path);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  },

  descriptionOf(source) {
    for (const path of DESCRIPTION_PATHS) {
      const value = foundry.utils.getProperty(source, path);
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  }
};

/* -------------------------------------------- */
/*  Registry                                    */
/* -------------------------------------------- */

/**
 * Register an adapter for a game system.
 *
 * Public: another module can teach the wheel about its system without this one
 * changing. Missing methods fall through to the generic adapter, so an adapter
 * that only wants to add rarity colours need only supply those.
 *
 * @param {SystemAdapter} adapter  Must carry an `id` matching `game.system.id`.
 */
export function registerSystemAdapter(adapter) {
  if (!adapter?.id) throw new Error("Wheel of Loot | a system adapter needs an id");
  REGISTRY.set(adapter.id, {...GENERIC_ADAPTER, ...adapter});
}

/** @returns {SystemAdapter} The adapter for the running system. */
export function systemAdapter() {
  return REGISTRY.get(game.system?.id) ?? GENERIC_ADAPTER;
}

/** True when the running system has a purpose-built adapter rather than the fallback. */
export function hasSystemAdapter() {
  return REGISTRY.has(game.system?.id);
}
