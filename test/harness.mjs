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

/**
 * A stand-in for `game.settings`, so the settings layer can be registered and
 * read under Node.
 *
 * Deliberately dumb: it stores defaults on register and hands them back on get,
 * which is exactly the behaviour the regression guard is asserting about.
 *
 * @param {Map} store   Receives key -> value; mutate it to simulate a GM change.
 * @param {Array} menus Receives each registerMenu call.
 */
export function installSettingsStub(store, menus = []) {
  const definitions = new Map();
  globalThis.game = {
    system: {id: "dnd5e"},
    i18n: {localize: k => k, format: k => k},
    settings: {
      register(namespace, key, data) {
        definitions.set(key, data);
        store.set(key, data.default);
      },
      registerMenu(namespace, key, data) {
        menus.push({key, ...data});
      },
      get: (namespace, key) => store.get(key),
      set: (namespace, key, value) => void store.set(key, value),
      settings: definitions
    }
  };
  return {store, menus, definitions};
}
