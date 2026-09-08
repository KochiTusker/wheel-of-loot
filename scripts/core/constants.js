/**
 * Identity, in one place.
 *
 * Every id, flag scope, CSS prefix and localisation root derives from these, so
 * the module can be renamed without hunting through string literals — which is
 * exactly the trap this file exists to avoid, having been renamed once already.
 */

export const MODULE_ID = "wheel-of-loot";

/** The id this module shipped under before 2.0.0, kept only for migration. */
export const LEGACY_MODULE_ID = "sbts-loot-wheel";

/** Root of every localisation key. */
export const I18N = "WHEELOFLOOT";

/** Prefix for every class this module puts in the DOM. */
export const CSS = "wol";

/** Shorthand for `game.i18n.localize` under this module's namespace. */
export function t(key, data) {
  const full = `${I18N}.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}
