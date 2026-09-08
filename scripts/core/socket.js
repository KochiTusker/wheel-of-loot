/**
 * socketlib wiring, and the routing rule that keeps one wheel on one owner.
 */

import {MODULE_ID} from "./constants.js";

/** @type {object|null} socketlib socket, set on `socketlib.ready`. */
let _socket = null;

export function socket() {
  return _socket;
}

export function socketReady() {
  return !!_socket;
}

/**
 * Every wheel is owned by exactly one GM client: Foundry's designated GM.
 *
 * Sessions live in memory, so one exists only on the client that created it.
 * socketlib's `executeAsGM` routes a *player's* call to `game.users.activeGM`
 * but short-circuits a *GM's* call to run locally — so with two GMs connected,
 * a wheel presented by one of them could never be spun by a player, because
 * their request landed on the other GM, which had no such session. It failed
 * silently, and looked for all the world like a permission problem.
 *
 * Pinning both creation and mutation to the designated GM keeps one owner.
 *
 * @param {string} handler  Registered socketlib handler name.
 * @returns {Promise<any>}
 */
export async function callOwner(handler, ...args) {
  // Reached before socketlib.ready, or with socketlib disabled: say so rather
  // than throwing a TypeError out of a click handler.
  if (!_socket) {
    ui.notifications.error(game.i18n.localize("WHEELOFLOOT.Notify.NoSocketlib"));
    return null;
  }
  const owner = game.users.activeGM;
  if (!owner) {
    ui.notifications.error(game.i18n.localize("WHEELOFLOOT.Notify.NoGM"));
    return null;
  }
  // executeAsUser runs locally when the target is this client, so a designated
  // GM acting on their own wheel still takes the fast path.
  return _socket.executeAsUser(handler, owner.id, ...args);
}

/** Warn one user, whether they are this client or a remote one. */
export async function tell(userId, message) {
  if (!_socket || userId === game.user.id) {
    ui.notifications.warn(message);
    return;
  }
  await _socket.executeForUsers("notify", [userId], message);
}

/**
 * Register every handler. Called once on `socketlib.ready`.
 *
 * @param {Record<string, Function>} handlers
 */
export function registerSocket(handlers) {
  _socket = socketlib.registerModule(MODULE_ID);
  for (const [name, fn] of Object.entries(handlers)) _socket.register(name, fn);
  return _socket;
}
