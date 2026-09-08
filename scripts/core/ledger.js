/**
 * The spin ledger.
 *
 * Interactivity is a permission, not a role: the wheel opens for everybody, and
 * whether you can turn it depends only on whether you hold a credit. That makes
 * "give this player a spin" the single decision a GM has to make.
 *
 * The ledger is a world-scope setting, which buys two things for free. Only a
 * GM can write it, so a modified client cannot mint itself spins; and every
 * client is told about a change through the Setting document, so no bespoke
 * broadcast is needed to keep the UI honest.
 *
 * This file holds only the ledger. Everything else configurable lives in
 * `settings.js`.
 */

import {MODULE_ID} from "./constants.js";
import {S} from "./settings.js";

/**
 * @returns {Record<string, number>} userId -> spins remaining.
 */
export function getCredits() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, S.CREDITS) ?? {});
}

/** @returns {number} Spins held by one user. */
export function creditsFor(userId) {
  return Number(getCredits()[userId] ?? 0);
}

/** @returns {number} Every outstanding spin, across all users. */
export function totalCredits() {
  return Object.values(getCredits()).reduce((a, n) => a + n, 0);
}

/**
 * GM-side write. Values at or below zero are dropped rather than stored, so the
 * ledger only ever lists people who can actually do something.
 *
 * @param {Record<string, number>} map
 */
export async function writeCredits(map) {
  const clean = {};
  for (const [id, n] of Object.entries(map)) {
    const value = Math.max(0, Math.floor(Number(n) || 0));
    if (value > 0) clean[id] = value;
  }
  return game.settings.set(MODULE_ID, S.CREDITS, clean);
}

/**
 * Set spin allowances. GM only.
 *
 * Registered on the socket so the launcher can call it from any GM client.
 * Declared with `function`, not arrow syntax, because socketlib binds `this`
 * to the socket data and the caller's identity is read off it.
 *
 * @param {Record<string, number>} allocations  userId -> spins (absolute, not a delta).
 */
export async function setSpins(allocations) {
  const caller = this?.socketdata?.userId ?? game.user.id;
  if (!game.users.get(caller)?.isGM) return null;
  const map = getCredits();
  for (const [userId, n] of Object.entries(allocations)) map[userId] = n;
  await writeCredits(map);
  return getCredits();
}

/** Spend one credit. Assumes the caller already checked they hold one. */
export async function debit(userId) {
  const map = getCredits();
  map[userId] = Math.max(0, (Number(map[userId]) || 0) - 1);
  return writeCredits(map);
}
