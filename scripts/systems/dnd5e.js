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
  const own = readUses(source, get(source, "system.uses"));
  if (own.max || own.regain.length) return own;

  const stated = GEAR_TYPES.has(source?.type) ? usesFromText(get(source, "system.description.value")) : null;
  // If the rules text states charges, say so, and say that the sheet will not
  // count them, because whoever wins it will have to.
  const fromText = () => ({profile: stated.regain.length ? "recharge" : "charges", max: stated.max,
    stated: stated.stated, regain: stated.regain, destroyed: false, untracked: true});

  // Nothing on the item. The limit may live on its activities instead, which
  // the sheet tracks just the same.
  const onActivities = activityUses(source);
  const pool = onActivities.find(u => Number(u.max) > 1);
  if (pool) return {...readUses(source, pool), abilities: onActivities.length};

  // An item's charges are its headline. Staff of Charming keeps a 1/long-rest
  // save on an activity, but its 10 charges are what a GM is choosing it for.
  if (stated?.kind === "charges") return fromText();

  if (onActivities.length) {
    const first = readUses(source, onActivities[0]);
    if (first.profile !== "permanent") return {...first, abilities: onActivities.length};
  }

  if (stated) return fromText();
  return own;
}

/** Profile from one `uses` record — the item's own, or an activity's. */
function readUses(source, raw) {
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

/** Item types that are gear. Spells and class features say "charges" about other things. */
const GEAR_TYPES = new Set(["equipment", "consumable", "weapon", "tool", "container", "loot"]);

const NUMBER_WORDS = {one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20};

/** "3", "three" or a formula like "1d8 + 1". */
const AMOUNT = String.raw`\d+d\d+(?:\s*[+-]\s*\d+)?|\d+|${Object.keys(NUMBER_WORDS).join("|")}`;
const COUNT_RX = new RegExp(String.raw`\b(?:has|have|starts with|holds?)\s+(${AMOUNT})\s+charges?\b`, "i");
const OF_ITS_RX = new RegExp(String.raw`\bof its\s+(${AMOUNT})\s+charges\b`, "i");
const REGAIN_RX = new RegExp(String.raw`\bregains?\s+(all(?:\s+of\s+its)?|its|${AMOUNT})\s+(?:expended\s+)?(?:charges?|uses)\b([^.]*)`, "i");
const ONCE_RX = /\b(?:can't|cannot)\b[^.]*?\bagain until the next (dawn|dusk)\b/i;

/** The period a sentence tail names, in dnd5e's keys. */
function periodIn(text) {
  if (/\bdawn\b/i.test(text)) return "dawn";
  if (/\bdusk\b/i.test(text)) return "dusk";
  if (/\blong rest\b/i.test(text)) return "lr";
  if (/\bshort rest\b/i.test(text)) return "sr";
  if (/\b(?:daily|each day|per day)\b/i.test(text)) return "day";
  return null;
}

/** "three" -> 3, "7" -> 7, "1d8 + 1" -> null (a roll, not a count). */
function countOf(amount) {
  const word = NUMBER_WORDS[amount.toLowerCase()];
  if (word) return word;
  return /^\d+$/.test(amount) ? Number(amount) : null;
}

/**
 * Read charges out of an item's rules text.
 *
 * For items whose data carries none. The D&D Beyond importer writes Pipes of
 * Haunting with empty `uses`, while its description still says "These pipes
 * have 3 charges and regain 1d3 expended charges daily at dawn". The patterns
 * are the phrasings that actually occur across the SRD and D&D Beyond packs;
 * anything else is left alone rather than guessed at.
 *
 * @param {string} html  Description HTML.
 * @returns {{max: number|null, stated: string|null, regain: object[]}|null}
 */
export function usesFromText(html) {
  if (typeof html !== "string" || !html) return null;
  const text = html
    .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2012-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ");

  const counted = COUNT_RX.exec(text) ?? OF_ITS_RX.exec(text);
  if (counted) {
    const amount = counted[1].replace(/\s+/g, " ");
    const regained = REGAIN_RX.exec(text);
    const period = regained && periodIn(regained[2]);
    const regain = period ? [{
      period,
      amount: /^(?:all|its)/i.test(regained[1]) ? null : regained[1].replace(/\s+/g, " ")
    }] : [];
    return {max: countOf(amount), stated: countOf(amount) ? null : amount, regain, kind: "charges"};
  }

  // No charges at all, but a property that works a set number of times and
  // comes back: "Once three fuzzy objects have been pulled from the bag, the
  // bag can't be used again until the next dawn" is three, not one.
  const once = ONCE_RX.exec(text);
  if (once) {
    const sentence = text.slice(text.lastIndexOf(".", once.index) + 1, once.index);
    const times = new RegExp(String.raw`\bonce\s+(\d+|${Object.keys(NUMBER_WORDS).join("|")})\b`, "i").exec(sentence);
    return {max: times ? countOf(times[1]) : 1, stated: null, regain: [{period: once[1].toLowerCase(), amount: null}],
      kind: "limit"};
  }
  return null;
}

/**
 * Limited uses recorded on an item's activities rather than the item itself.
 * The sheet tracks these — Javelin of Lightning's Lightning Bolt is 1/dawn on
 * the activity — so they are real data, not a guess.
 */
function activityUses(source) {
  const activities = get(source, "system.activities");
  if (!activities || typeof activities !== "object") return [];
  // A plain object on an index row, but an ActivityCollection — a Map, whose
  // entries Object.values cannot see — on a loaded document.
  return (activities instanceof Map ? [...activities.values()] : Object.values(activities))
    .filter(a => a && typeof a === "object" && Number(a.uses?.max) > 0)
    .map(a => a.uses);
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
    "system.price", "system.source", "system.uses",
    // Needed only for items whose uses are not on the item itself: activity
    // limits, and charges an importer left in the rules text alone.
    "system.activities", "system.description.value"
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
    const label = typeof conf === "string" ? conf : conf?.label;
    const raw = typeof label === "string" && label
      ? (game.i18n?.localize?.(label) ?? label)
      : String(key ?? "").replace(/([a-z])([A-Z])/g, "$1 $2");
    // dnd5e's English labels are lower case ("very rare"), so capitalise each
    // word — but only after whitespace. \b\w treats an accented letter as a
    // word boundary, which printed "LéGendaire" for French players.
    return raw.replace(/(^|\s)(\p{L})/gu, (_, gap, ch) => gap + ch.toUpperCase());
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
    const coin = price && typeof price === "object" ? price.denomination : null;
    const denom = typeof coin === "string" && coin.trim() ? coin.trim() : "gp";
    return `${value} ${denom}`;
  },

  usesMaxOf: entry => useDetail(entry).max,

  /**
   * Whether players must not learn what this item really is.
   *
   * dnd5e already swaps an unidentified item's *name* for its disguise, but the
   * description and rarity are left to whoever displays them.
   */
  conceals: source => get(source, "system.identified") === false,

  /** Rules text as players may see it: the disguise text for an unidentified item. */
  publicDescriptionOf(source) {
    if (get(source, "system.identified") === false) return text(get(source, "system.unidentified.description"));
    const value = get(source, "system.description.value");
    return typeof value === "string" ? value : "";
  },

  /**
   * The documents to create for a prize.
   *
   * A container carries its contents as separate items linked by
   * `system.container`, so copying the container alone granted an empty
   * Explorer's Pack. dnd5e's own helper walks the contents, and via
   * fromCompendium it also records where the item came from.
   */
  async grantData(source) {
    const cls = source?.constructor;
    if (typeof cls?.createWithContents === "function") {
      const data = await cls.createWithContents([source]);
      if (Array.isArray(data) && data.length) return data;
    }
    return GENERIC_ADAPTER.grantData(source);
  },

  /** `system.type.value` since 3.0; each item type had its own field before. */
  subtypeOf: entry => text(get(entry, "system.type.value"))
    || text(get(entry, "system.consumableType"))
    || text(get(entry, "system.weaponType"))
    || text(get(entry, "system.armor.type"))
    || null,

  parseCurrency(name) {
    // Anchored at both ends: "10 Silver Mirrors" and "100 gp gem" are prizes,
    // not purses, and must go to the GM to hand over.
    const match = /^\s*(\d[\d,]*)\s*(gp|gold|sp|silver|cp|copper|ep|electrum|pp|platinum)(?:\s+(?:pieces?|coins?))?\s*$/i
      .exec(name ?? "");
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
