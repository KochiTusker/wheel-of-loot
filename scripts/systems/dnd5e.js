/**
 * What the wheel knows about D&D 5e.
 *
 * Everything here is a fact about dnd5e's data model rather than about wheels,
 * which is why it is quarantined in one file. Nothing else in the module reads
 * `system.rarity`, `system.uses` or `system.currency` directly.
 */

import {GENERIC_ADAPTER, registerSystemAdapter} from "./adapter.js";

/** Rarity -> the colour its *name* is printed in on the wheel. */
const RARITY_COLOURS = {
  common: "#3f3f46",
  uncommon: "#1a7f3c",
  rare: "#1155cc",
  veryRare: "#7b2fbe",
  legendary: "#b26a00",
  artifact: "#a3341f"
};

const RARITY_ORDER = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];

/** Spellings a GM might reasonably type, mapped to dnd5e currency keys. */
const CURRENCY_WORDS = {
  gp: "gp", gold: "gp",
  sp: "sp", silver: "sp",
  cp: "cp", copper: "cp",
  ep: "ep", electrum: "ep",
  pp: "pp", platinum: "pp"
};

/**
 * How many times an item can be used.
 *
 * dnd5e files permanent charged magic items under `type: "consumable"` too —
 * Pipes of Haunting is a "consumable" with three charges that regain 1d3 on a
 * long rest — so the type alone does not mean single-use. Recovery periods are
 * the reliable tell; charges without recovery are expendable but multi-use.
 *
 * Takes the whole document or index row rather than `system.uses`, so the
 * adapter interface stays uniform across systems that keep it elsewhere.
 *
 * @param {object} source  Document or compendium index entry.
 * @returns {"single"|"charges"|"recharge"}
 */
export function useProfile(source) {
  const uses = foundry.utils.getProperty(source, "system.uses") ?? {};
  const recovery = Array.isArray(uses.recovery) ? uses.recovery : [];
  if (recovery.some(r => r?.period)) return "recharge";
  return (Number(uses.max) || 0) > 1 ? "charges" : "single";
}

export const DND5E_ADAPTER = {
  id: "dnd5e",

  // Rarity, subtype, price, source and uses all drive the builder's UI, so they
  // have to come back on the index rather than costing a document load per row.
  indexFields: [
    "img", "type", "system.rarity", "system.type.value",
    "system.price.value", "system.source.book", "system.source.custom", "system.uses"
  ],

  rarities: RARITY_ORDER,
  tracksUses: true,

  rarityColour: key => RARITY_COLOURS[key] ?? RARITY_COLOURS.common,

  /**
   * dnd5e's rarity config returns a bare string in some versions and an object
   * in others, so normalise either into "Very Rare" rather than trusting it to
   * arrive display-ready.
   */
  rarityLabel(key) {
    const conf = CONFIG.DND5E?.itemRarity?.[key];
    const raw = typeof conf === "string" ? conf : (conf?.label ?? key);
    return String(raw)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\b\w/g, ch => ch.toUpperCase());
  },

  rarityOf: source => foundry.utils.getProperty(source, "system.rarity") || null,

  useProfile,

  parseCurrency(name) {
    const match = /^\s*(\d[\d,]*)\s*(gp|gold|sp|silver|cp|copper|ep|electrum|pp|platinum)\b/i.exec(name ?? "");
    if (!match) return null;
    const denom = CURRENCY_WORDS[match[2].toLowerCase()];
    const amount = Number(match[1].replace(/,/g, ""));
    if (!denom || !Number.isInteger(amount) || amount <= 0) return null;
    return {denom, amount};
  },

  async grantCurrency(actor, {denom, amount}) {
    const path = `system.currency.${denom}`;
    const held = foundry.utils.getProperty(actor, path) ?? 0;
    await actor.update({[path]: held + amount});
    return true;
  },

  /**
   * Gifting into an NPC or a stray actor is never what is meant, and dnd5e is
   * explicit about which type is a player character — so require that, on top
   * of the generic "somebody is playing them" check.
   */
  isRewardable(actor) {
    return actor?.type === "character" && GENERIC_ADAPTER.isRewardable(actor);
  }
};

/** Called once from main.js on `init`. */
export function registerDnd5e() {
  registerSystemAdapter(DND5E_ADAPTER);
}
