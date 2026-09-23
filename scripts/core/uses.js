/**
 * Turn an adapter's `useDetail` into the short tag and the sentence the builder
 * shows, so "7/dawn" is read off the item rather than a generic "recharges".
 *
 * Pure: the translator is passed in, so this runs under plain Node.
 */

/**
 * Recovery periods that have wording of their own. Anything else — combat
 * periods, which no loot uses — is shown by its raw key rather than hidden.
 */
const WORDED_PERIODS = new Set(["lr", "sr", "day", "dawn", "dusk"]);

/** Tag for each profile when there is no count to show. */
const PLAIN_TAG = {single: "1×", charges: "N×", recharge: "↻", permanent: "∞"};

/** Prefix on the tag of a count read from rules text rather than tracked data. */
const UNTRACKED_MARK = "⚠";

/**
 * @param {object|null} detail  From `adapter.useDetail`, or null.
 * @param {(key: string, data?: object) => string} t  Module translator.
 * @param {string} [fallback="permanent"]  Profile to describe when detail is null.
 * @returns {{profile: string, tag: string, text: string, untracked: boolean}}
 */
export function describeUses(detail, t, fallback = "permanent") {
  if (!detail) {
    return {profile: fallback, tag: PLAIN_TAG[fallback] ?? "", text: plainText(fallback, t), untracked: false};
  }
  const {profile, max, stated, regain = [], destroyed, untracked = false, abilities = 1} = detail;
  // A count the text gives as a roll ("1d8 + 1 charges") is said in words but
  // cannot be a number on a tag.
  const n = max ?? stated ?? 0;
  const tagN = max ?? (stated ? "?" : 0);

  let tag;
  let text;
  if (profile === "recharge") {
    const first = regain[0]?.period;
    const tagPeriod = first && WORDED_PERIODS.has(first) ? t(`Use.Tag.${first}`) : first;
    text = regain.map(r => {
      const when = WORDED_PERIODS.has(r.period) ? t(`Use.When.${r.period}`) : `(${r.period})`;
      if (max === 1) return t("Use.Once", {when});
      if (!n) return t("Use.Regained", {when});
      return r.amount
        ? t("Use.Regains", {n, amount: r.amount, when})
        : t("Use.RegainsAll", {n, when});
    }).join("; ");
    tag = tagN && tagPeriod ? `${tagN}/${tagPeriod}` : PLAIN_TAG.recharge;
  } else if (profile === "charges") {
    tag = `${tagN || "N"}×`;
    text = t(destroyed ? "Use.ChargesGone" : "Use.ChargesKept", {n: n || "?"});
  } else {
    return {profile, tag: PLAIN_TAG[profile] ?? "", text: plainText(profile, t), untracked: false};
  }

  if (abilities > 1) text += ` ${t("Use.MoreAbilities", {n: abilities - 1})}`;
  if (untracked) {
    tag = UNTRACKED_MARK + tag;
    text = `${text} — ${t("Use.Untracked")}`;
  }
  return {profile, tag, text, untracked};
}

function plainText(profile, t) {
  return t(profile === "single" ? "Use.Single" : "Use.Permanent");
}

/* -------------------------------------------- */
/*  Settling one-use items against a reference  */
/* -------------------------------------------- */

/**
 * The name keys two printings of an item share: "Acid (vial)" and "Acid" both
 * give "acid"; "Feather Token (Anchor)" also gives "feather token anchor".
 *
 * @param {string} name
 * @returns {string[]}
 */
export function referenceKeys(name) {
  const lower = String(name ?? "").toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const bare = lower.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  const unwrapped = lower.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
  return [...new Set([bare, unwrapped].filter(Boolean))];
}

/**
 * Decide the items an adapter left unsettled by asking a reference copy.
 *
 * "One use, not destroyed by using it" means Rope in one pack and Acid in
 * another; the data cannot say which. The game system's own compendiums can: a
 * same-named item there that *is* settled answers whether this one is used up.
 * Only that question is borrowed — never a charge count, which would claim the
 * sheet tracks something this copy does not store. Anything left over stays
 * permanent, because calling gear single-use is the worse mistake.
 *
 * Mutates the rows it settles.
 *
 * @param {object[]} rows  Catalogue rows with `profile` and `uses`.
 * @param {(row: object) => boolean} isReference  Whether a row is from the system's own packs.
 * @returns {number} How many rows were settled.
 */
export function settleFromReference(rows, isReference) {
  const verdicts = new Map();
  for (const row of rows) {
    if (!isReference(row) || row.uses?.unsettled) continue;
    if (row.profile !== "single" && row.profile !== "permanent") continue;
    for (const key of referenceKeys(row.name)) {
      if (!verdicts.has(key)) verdicts.set(key, new Set());
      verdicts.get(key).add(row.profile);
    }
  }
  let settled = 0;
  for (const row of rows) {
    if (!row.uses?.unsettled) continue;
    const found = new Set(referenceKeys(row.name).flatMap(k => [...(verdicts.get(k) ?? [])]));
    // Only a unanimous answer counts; the reference disagreeing with itself is no answer.
    if (found.size !== 1) continue;
    const [profile] = found;
    row.profile = profile;
    row.uses = {...row.uses, profile, unsettled: false};
    settled++;
  }
  return settled;
}
