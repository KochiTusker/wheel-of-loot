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

/** Structural clone, as the ledger uses before handing its map out. */
function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

globalThis.foundry ??= {utils: {getProperty, deepClone}};

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

/**
 * Add a world to the settings stub: compendium packs and the Items directory.
 *
 * Lets the catalogue be exercised through `buildCatalogue` rather than by
 * reaching into its cache, so the tests drive the same path the module does.
 *
 * @param {object} [world]
 * @param {object[]} [world.packs]  [{collection, label, entries}]
 * @param {object[]} [world.items]  World Item documents.
 */
export function installWorldStub({packs = [], items = []} = {}) {
  globalThis.game.packs = packs.map(p => ({
    collection: p.collection,
    documentName: "Item",
    metadata: {label: p.label},
    getIndex: async () => p.entries
  }));
  globalThis.game.items = items;
  return globalThis.game;
}

/**
 * The globals `buildEntries` reaches for beyond the settings stub.
 *
 * Three, and each is a fact about the module rather than a convenience: it
 * needs the table-result type enum, it resolves wedges by uuid, and it strips
 * markup out of a description through a DOM node.
 *
 * The `document` stand-in is faithful only for text carrying no markup, which
 * is all these checks feed it — `plainText` collapses whitespace and truncates
 * by itself, and a tag-free string has no elements to remove. Enrichment is
 * Foundry's own and is stubbed as identity, so what the checks assert about is
 * what the module does with the result rather than what Foundry does to it.
 *
 * @param {Record<string, object>} docs  uuid -> document, for `fromUuid`.
 */
export function installEntryStub(docs = {}) {
  globalThis.CONST ??= {};
  globalThis.CONST.TABLE_RESULT_TYPES = {DOCUMENT: "document", TEXT: "text"};
  globalThis.CONFIG ??= {};
  globalThis.CONFIG.ux = {TextEditor: {enrichHTML: async html => html}};
  globalThis.fromUuid = async uuid => docs[uuid] ?? null;
  globalThis.document ??= {
    createElement: () => ({
      innerHTML: "",
      querySelectorAll: () => [],
      get textContent() { return this.innerHTML; }
    })
  };
  return docs;
}

/**
 * A stand-in for Foundry's `Roll`, so the wheel's chooser can be exercised.
 *
 * Records every formula it is asked to evaluate, which is how the checks tell
 * the flat roll from the weighted one — the two are the whole point of
 * `rollSlice`, and they are indistinguishable from the result alone.
 *
 * @param {number[]} totals  Handed out in order, one per roll.
 * @returns {{formulas: string[]}}
 */
export function installRollStub(totals) {
  const seen = {formulas: []};
  const queue = [...totals];
  globalThis.Roll = class {
    constructor(formula) {
      seen.formulas.push(formula);
      this.total = queue.shift();
    }
    async evaluate() { return this; }
  };
  return seen;
}
