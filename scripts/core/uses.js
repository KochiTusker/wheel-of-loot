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
const UNTRACKED_MARK = "⚠ ";

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
