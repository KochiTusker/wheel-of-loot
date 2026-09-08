/**
 * The smallest possible stand-in for Foundry, so the pure modules can be
 * imported under plain Node.
 *
 * Kept deliberately tiny: every global stubbed here is a global the code under
 * test genuinely reaches for, so this file doubles as the honest list of what
 * `core/` and `systems/` depend on beyond the language itself. If it starts
 * growing, that is a signal that logic has leaked out of the pure layer.
 */

/**
 * Foundry's `getProperty`: walk a dot path, giving up quietly on a miss.
 * Matches the real one's contract closely enough for the paths in use.
 */
function getProperty(object, key) {
  if (!key || object == null) return undefined;
  let target = object;
  for (const step of key.split(".")) {
    if (target == null || typeof target !== "object") return undefined;
    target = target[step];
  }
  return target;
}

globalThis.foundry ??= {utils: {getProperty}};

export {getProperty};
