/**
 * What the wheel knows about D&D 5e.
 *
 * Everything here is a fact about dnd5e's data model rather than about wheels,
 * which is why it is quarantined in one file. Nothing else in the module reads
 * `system.rarity`, `system.uses` or `system.currency` directly.
 */

import {registerSystemAdapter} from "./adapter.js";

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

/*
 * Everything below reads `system.*` defensively, because index rows are *not*
 * migrated. `pack.getIndex()` hands back what is stored, so a module pack last
 * saved under dnd5e 2.x or 3.x arrives in the old shape even on 5.x — a bare
 * number for price, a string for source, `uses.per` instead of a recovery
 * array. Homebrew adds its own oddities. A reader here may return nothing, but
 * it must never throw: one bad row used to cost the GM the whole catalogue.
 */

const get = (source, path) => foundry.utils.getProperty(source, path);

/** A trimmed string, or "" — for fields that are text in some versions and not others. */
function text(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** Legacy spellings of rarity ("Very Rare", "very rare") folded onto dnd5e's keys. */
const RARITY_ALIASES = Object.fromEntries(RARITY_ORDER.map(k => [k.toLowerCase(), k]));

/** Pre-4.0 recovery periods, as `uses.per`. "charges" meant none at all. */
const LEGACY_PERIODS = new Set(["sr", "lr", "day", "dawn", "dusk"]);

/**
 * Consumable subtypes that are spent by using them even when no uses are
 * tracked: one arrow per shot, one vial per throw.
 */
const EXPENDABLE_SUBTYPES = new Set(["ammo", "potion", "poison", "scroll", "food"]);

/**
 * How an item is used up, read straight off its own `system.uses`.
 *
 * Every rule here was checked against the SRD packs, not guessed:
 *
 * - dnd5e files permanent charged items under `type: "consumable"` too —
 *   Pipes of Haunting has three charges regaining 1d3 on a long rest. A
 *   recovery period is the reliable tell, so it wins over everything.
 * - No uses does not mean single-use either. A longsword tracks none because
 *   it is never spent, and the 2014 pack files Carpet of Flying, Crystal Ball
 *   and Portable Hole as uncounted "consumable" trinkets. Only an expendable
 *   subtype (ammo, potion…) makes an uncounted consumable single-use.
 * - One use with no recovery is single-use only on something that goes away:
 *   a consumable, or anything marked `autoDestroy`. Frost Brand and Wings of
 *   Flying carry `max: 1` for a limited feature, not because they are spent.
 *
 * Takes the whole document or index row rather than `system.uses`, so the
 * adapter interface stays uniform across systems that keep it elsewhere.
 *
 * @param {object} source  Document or compendium index entry.
 * @returns {{profile: "single"|"charges"|"recharge"|"permanent", max: number|null,
 *   regain: {period: string, amount: string|null}[], destroyed: boolean}}
 *   `amount` null means everything comes back.
 */
export function useDetail(source) {
  const raw = get(source, "system.uses");
  const uses = raw && typeof raw === "object" ? raw : {};
  const max = Math.max(0, Math.floor(Number(uses.max) || 0));
  const destroyed = uses.autoDestroy === true;
  const regain = Array.isArray(uses.recovery)
    ? uses.recovery
      .filter(r => r && typeof r === "object" && typeof r.period === "string" && r.period)
      .map(r => ({
        period: r.period,
        amount: r.type === "formula" && text(r.formula) ? text(r.formula) : null
      }))
    // Pre-4.0: one period in `per`, and `recovery` was the formula as a string.
    : LEGACY_PERIODS.has(uses.per)
      ? [{period: uses.per, amount: text(uses.recovery) || null}]
      : [];
  const detail = profile => ({profile, max: max || null, regain, destroyed});

  if (regain.length) return detail("recharge");
  if (max > 1) return detail("charges");
  const consumable = source?.type === "consumable";
  if (max === 1) return detail(consumable || destroyed ? "single" : "permanent");
  const subtype = get(source, "system.type.value") ?? get(source, "system.consumableType");
  return detail(consumable && EXPENDABLE_SUBTYPES.has(subtype) ? "single" : "permanent");
}

/** @returns {"single"|"charges"|"recharge"|"permanent"} */
export function useProfile(source) {
  return useDetail(source).profile;
}

export const DND5E_ADAPTER = {
  id: "dnd5e",

  // Rarity, subtype, price, source and uses all drive the builder's UI, so they
  // have to come back on the index rather than costing a document load per row.
  // Whole objects rather than leaf paths where the shape changed between
  // versions: asking for `system.price.value` returns nothing from a pack that
  // stored price as a bare number.
  indexFields: [
    "img", "type", "system.rarity", "system.type.value",
    "system.consumableType", "system.weaponType", "system.armor.type",
    "system.price", "system.source", "system.uses"
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

  rarityOf(source) {
    const value = text(get(source, "system.rarity"));
    if (!value) return null;
    return RARITY_ALIASES[value.toLowerCase().replace(/[\s_-]+/g, "")] ?? value;
  },

  useProfile,
  useDetail,

  /** `{book, custom}` since 3.0; a bare string before that. */
  sourceOf: entry => text(get(entry, "system.source.book"))
    || text(get(entry, "system.source.custom"))
    || text(get(entry, "system.source")),

  /** dnd5e keeps the denomination beside the number, so say which coin. */
  priceOf(entry) {
    // `{value, denomination}` since 2.0; a bare number of gold before that.
    const price = get(entry, "system.price");
    const value = text(price && typeof price === "object" ? price.value : price);
    if (!value) return null;
    const denom = (price && typeof price === "object" && text(price.denomination)) || "gp";
    return `${value} ${denom}`;
  },

  usesMaxOf: entry => useDetail(entry).max,

  /** `system.type.value` since 3.0; each item type had its own field before. */
  subtypeOf: entry => text(get(entry, "system.type.value"))
    || text(get(entry, "system.consumableType"))
    || text(get(entry, "system.weaponType"))
    || text(get(entry, "system.armor.type"))
    || null,

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
   * explicit about which type is a player character — so the type alone is the
   * check.
   *
   * Deliberately *not* also requiring that a user currently has them assigned.
   * The gift dialog only ever offers assigned characters anyway, so the extra
   * condition would buy nothing, and it would refuse a legitimate target whose
   * player happens to be unassigned at that moment.
   */
  isRewardable(actor) {
    return actor?.type === "character";
  }
};

/** Called once from main.js on `init`. */
export function registerDnd5e() {
  registerSystemAdapter(DND5E_ADAPTER);
}
