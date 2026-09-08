/**
 * The wheel builder.
 *
 * Foundry's stock RollTable sheet makes weight edits a per-row chore and gives
 * no sense of the whole: you cannot see that you are three slots short, and
 * there is no way to browse candidate items beside the table you are filling.
 * This does both — catalogue on the left, wheel on the right, running slot
 * total across the bottom — and adds the two things that turn it from an editor
 * into a builder: the wheel's size is yours to choose, and any wedge (or the
 * whole wheel) can be re-rolled from whatever the filters currently describe.
 *
 * Nothing is written until Save, so experimenting is free.
 */

import {
  buildCatalogue, cachedCatalogue, catalogueRow, cataloguePacks, catalogueSources,
  catalogueTypes, invalidateCatalogue
} from "../core/catalogue.js";
import {
  buildEntries, clampSlots, disperseSlots, MAX_SLOTS, MIN_SLOTS, readStock, richText,
  SLOT_PRESETS, slotCount
} from "../core/wheel-data.js";
import {DEDUPE_MODES, foldDuplicates} from "../core/dedupe.js";
import {DEFAULT_ODDS, MAX_ODDS, MIN_ODDS, clampOdds, isUnweighted, trueChances} from "../core/odds.js";
import {coinDenomination, coinPresets, defaultSlots, resolveWheelConfig} from "../core/settings.js";
import {MODULE_ID, t} from "../core/constants.js";
import {planWheel} from "../core/wheel-plan.js";
import {systemAdapter} from "../systems/adapter.js";

const {ApplicationV2, DialogV2} = foundry.applications.api;

const USE_LABEL = {
  single: {tag: "1×", key: "Use.Single"},
  charges: {tag: "N×", key: "Use.Charges"},
  recharge: {tag: "↻", key: "Use.Recharge"}
};

/** Rows rendered before the list is cut short; the filters are the answer. */
const CATALOGUE_CAP = 300;

/**
 * Art for a prize the GM has not chosen art for.
 *
 * One of Foundry's own bundled icons rather than anything drawn for this
 * module, so it is present in every install and carries no licence question.
 */
const DEFAULT_PRIZE_IMG = "icons/sundries/scrolls/scroll-bound-gold.webp";

export class WheelBuilder extends ApplicationV2 {
  /** @type {WheelBuilder|null} The open builder, if there is one. */
  static current = null;

  static DEFAULT_OPTIONS = {
    id: "wheel-of-loot-builder",
    classes: ["wol-builder"],
    tag: "div",
    window: {
      title: "WHEELOFLOOT.Builder.Title",
      icon: "fa-solid fa-arrows-spin",
      resizable: true
    },
    position: {width: 1180, height: 800},
    actions: {
      save: WheelBuilder.#onSave,
      remove: WheelBuilder.#onRemove,
      bump: WheelBuilder.#onBump,
      add: WheelBuilder.#onAdd,
      addCoin: WheelBuilder.#onAddCoin,
      custom: WheelBuilder.#onCustom,
      editEntry: WheelBuilder.#onEditEntry,
      dryRun: WheelBuilder.#onDryRun,
      pad: WheelBuilder.#onPad,
      clearFilters: WheelBuilder.#onClearFilters,
      refresh: WheelBuilder.#onRefresh,
      expand: WheelBuilder.#onExpand,
      variants: WheelBuilder.#onVariants,
      jackpot: WheelBuilder.#onJackpot,
      wheelSettings: WheelBuilder.#onWheelSettings,
      rerollOne: WheelBuilder.#onRerollOne,
      rollWheel: WheelBuilder.#onRollWheel,
      fill: WheelBuilder.#onFill,
      clearWheel: WheelBuilder.#onClearWheel
    }
  };

  constructor(table, options = {}) {
    super(options);
    this.table = table;
    // A saved wheel already knows how big it is; only a brand new one needs a
    // default, and that is the GM's own preference rather than a constant.
    this.target = clampSlots(slotCount(table) || defaultSlots());
    this.entries = [];
    this.filters = {
      search: "",
      pack: "",
      source: "",
      type: systemAdapter().id === "dnd5e" ? "consumable" : "",
      rarity: "",
      hideUsed: true,
      singleUse: systemAdapter().tracksUses,
      // A world with several imported books is the normal case, not the
      // exceptional one, so the browser folds by default and lets the GM
      // unfold rather than drowning them first and explaining later.
      dupes: "name"
    };
    this.dirty = false;
  }

  get title() {
    return `${t("Builder.Title")} — ${this.table.name}${this.dirty ? " •" : ""}`;
  }

  /* ---------------------------------------- */
  /*  Data                                    */
  /* ---------------------------------------- */

  /** Snapshot the table's current results into an editable working set. */
  async loadEntries() {
    const adapter = systemAdapter();
    const rows = [];
    for (const result of this.table.results) {
      const lo = result.range?.[0] ?? 0;
      const hi = result.range?.[1] ?? 0;
      const weight = result.weight || Math.max(1, (hi - lo) + 1);
      let rarity = null;
      let missing = false;
      let source = "";
      let profile = "single";
      if (result.documentUuid) {
        const hit = catalogueRow(result.documentUuid);
        rarity = hit?.rarity ?? null;
        source = hit?.source ?? "";
        profile = hit?.profile ?? "single";
        // Not in the index is not proof of absence — unindexed packs exist — so
        // confirm by resolving before crying wolf.
        if (!hit) {
          let doc = null;
          try { doc = await fromUuid(result.documentUuid); } catch { doc = null; }
          missing = !doc;
          rarity = doc ? adapter.rarityOf(doc) : null;
          // Through the adapter rather than dnd5e's own paths. A wedge whose
          // item is not in the index is precisely the case where another
          // system's field names matter, and reading system.source.* here made
          // every non-5e world show a dash.
          source = doc ? adapter.sourceOf(doc) : "";
          profile = doc ? adapter.useProfile(doc) : "single";
        }
      }
      // A prize with no document behind it keeps its own rarity and its own
      // words, because there is nothing else to ask.
      const custom = !result.documentUuid && !adapter.parseCurrency(result.name);
      if (!result.documentUuid) rarity = result.getFlag?.(MODULE_ID, "rarity") || null;
      // Older saves copied the name into the description, which printed the
      // prize's name twice on the reveal card. Treat that as no description.
      const description = result.description && result.description !== result.name
        ? result.description
        : "";

      rows.push({
        uuid: result.documentUuid ?? null,
        name: result.name,
        img: result.img,
        description,
        custom,
        weight,
        odds: clampOdds(result.getFlag?.(MODULE_ID, "odds") ?? DEFAULT_ODDS),
        jackpot: result.getFlag?.(MODULE_ID, "jackpot") === true,
        stock: readStock(result),
        rarity,
        missing,
        source,
        profile,
        isCoin: !result.documentUuid && !!adapter.parseCurrency(result.name)
      });
    }
    // Heaviest first: the bulk filler entries are what you actually re-balance.
    rows.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
    this.entries = rows;
  }

  get slotTotal() {
    return this.entries.reduce((a, e) => a + e.weight, 0);
  }

  /** Rows passing the filters, before duplicates are folded. */
  get matched() {
    const adapter = systemAdapter();
    const used = new Set(this.entries.map(e => e.uuid).filter(Boolean));
    const q = this.filters.search.trim().toLowerCase();
    return cachedCatalogue().filter(c => {
      if (this.filters.hideUsed && used.has(c.uuid)) return false;
      if (this.filters.singleUse && adapter.tracksUses && c.profile !== "single") return false;
      if (this.filters.type && c.itemType !== this.filters.type) return false;
      if (this.filters.rarity && c.rarity !== this.filters.rarity) return false;
      if (this.filters.pack && c.packId !== this.filters.pack) return false;
      if (this.filters.source && c.book !== this.filters.source) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  /**
   * What the browser shows, and what every roll draws from.
   *
   * Folding happens after filtering, not before, so narrowing to one compendium
   * shows that compendium's copies rather than whichever variant happened to
   * win the fold across the whole world.
   *
   * Rolling from the folded list matters as much as browsing it: a wheel rolled
   * from an unfolded pool in a world with eleven Potions of Healing would be
   * eleven Potions of Healing.
   */
  get pool() {
    return foldDuplicates(this.matched, this.filters.dupes);
  }

  /* ---------------------------------------- */
  /*  Render                                  */
  /* ---------------------------------------- */

  async _prepareContext() {
    return {};
  }

  async _renderHTML() {
    const adapter = systemAdapter();
    const denom = coinDenomination();
    const root = document.createElement("div");
    root.className = "wol-builder-body";
    root.innerHTML = `
      <div class="wol-b-cols">
        <section class="wol-b-cat">
          <header>
            <h2>${t("Builder.Catalogue")}</h2>
            <span class="wol-b-headbtns">
              <button type="button" class="wol-b-ghost" data-action="refresh"
                data-tooltip="${t("Builder.RefreshHint")}">
                <i class="fa-solid fa-rotate"></i> ${t("Builder.Refresh")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="clearFilters">
                <i class="fa-solid fa-filter-circle-xmark"></i> ${t("Builder.Reset")}
              </button>
            </span>
          </header>
          <div class="wol-b-filters">
            <input type="search" name="search" placeholder="${t("Builder.SearchPlaceholder")}"
              value="${foundry.utils.escapeHTML(this.filters.search)}">
            <select name="type"></select>
            ${adapter.rarities.length ? `<select name="rarity"></select>` : ""}
            <select name="pack"></select>
            <select name="source"></select>
            <select name="dupes" data-tooltip="${t("Builder.DupesHint")}">
              ${DEDUPE_MODES.map(m => `<option value="${m}"${
                m === this.filters.dupes ? " selected" : ""}>${t(`Builder.Dupes.${m}`)}</option>`).join("")}
            </select>
            <label class="wol-b-check">
              <input type="checkbox" name="hideUsed" ${this.filters.hideUsed ? "checked" : ""}>
              ${t("Builder.HideUsed")}
            </label>
            ${adapter.tracksUses ? `<label class="wol-b-check" data-tooltip="${t("Builder.SingleUseHint")}">
              <input type="checkbox" name="singleUse" ${this.filters.singleUse ? "checked" : ""}>
              ${t("Builder.SingleUse")}
            </label>` : ""}
          </div>
          <ol class="wol-b-list" data-role="catalogue"></ol>
          <footer class="wol-b-catfoot" data-role="catcount"></footer>
        </section>

        <section class="wol-b-wheel" data-role="dropzone">
          <header>
            <h2>${t("Builder.OnTheWheel")}</h2>
            <div class="wol-b-wheelbtns">
              <button type="button" class="wol-b-ghost wol-b-dry" data-action="dryRun"
                data-tooltip="${t("Builder.DryRunHint")}">
                <i class="fa-solid fa-eye"></i> ${t("Builder.DryRun")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="rollWheel"
                data-tooltip="${t("Builder.RollWheelHint")}">
                <i class="fa-solid fa-dice"></i> ${t("Builder.RollWheel")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="fill"
                data-tooltip="${t("Builder.FillHint")}">
                <i class="fa-solid fa-wand-sparkles"></i> ${t("Builder.Fill")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="wheelSettings"
                data-tooltip="${t("Builder.WheelSettingsHint")}">
                <i class="fa-solid fa-palette"></i> ${t("Builder.WheelSettings")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="clearWheel">
                <i class="fa-solid fa-trash-can"></i> ${t("Builder.Clear")}
              </button>
            </div>
          </header>
          <div class="wol-b-coinbar">
            <p class="wol-b-hint">${t("Builder.DropHint")}</p>
            <div class="wol-b-coin">
              <button type="button" class="wol-b-ghost" data-action="custom"
                data-tooltip="${t("Builder.NewPrizeHint")}">
                <i class="fa-solid fa-gift"></i> ${t("Builder.NewPrize")}
              </button>
              <select name="coin">
                ${coinPresets().map(v => `<option value="${v}">${v} ${denom}</option>`).join("")}
              </select>
              <button type="button" class="wol-b-ghost" data-action="addCoin">
                <i class="fa-solid fa-coins"></i> ${t("Builder.AddCoin")}
              </button>
            </div>
          </div>
          <ol class="wol-b-list" data-role="entries"></ol>
        </section>
      </div>

      <footer class="wol-b-foot">
        <div class="wol-b-size">
          <label for="wol-b-slots">${t("Builder.WheelSize")}</label>
          <select id="wol-b-slots" name="slotPreset">
            ${SLOT_PRESETS.map(n => `<option value="${n}"${n === this.target ? " selected" : ""}>${
              t("Builder.NSlices", {n})}</option>`).join("")}
            <option value="custom">${t("Builder.Custom")}</option>
          </select>
          <input type="number" name="slotCustom" min="${MIN_SLOTS}" max="${MAX_SLOTS}" step="1"
            value="${this.target}" aria-label="${t("Builder.WheelSize")}"
            ${SLOT_PRESETS.includes(this.target) ? "hidden" : ""}>
        </div>
        <div class="wol-b-tally" data-role="tally"></div>
        <div class="wol-b-footactions">
          <button type="button" data-action="pad" data-tooltip="${t("Builder.PadHint")}">
            <i class="fa-solid fa-scale-balanced"></i> <span data-role="padlabel"></span>
          </button>
          <button type="button" class="wol-b-save" data-action="save">
            <i class="fa-solid fa-floppy-disk"></i> ${t("Builder.Save")}
          </button>
        </div>
      </footer>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    this.#hydrate(content);
    WheelBuilder.current = this;
  }

  /** @inheritDoc */
  async close(options) {
    if (WheelBuilder.current === this) WheelBuilder.current = null;
    return super.close(options);
  }

  /**
   * Redraw the item list after the world's Items have changed underneath it.
   *
   * Only the catalogue side: the wheel the GM is assembling is unsaved work and
   * must not be disturbed by somebody editing an item in another window.
   */
  static refreshCatalogue() {
    const app = WheelBuilder.current;
    if (!app?.element) return;
    try {
      app.#renderCatalogue(app.element);
    } catch (err) {
      console.warn("Wheel of Loot | could not refresh the item list", err);
    }
  }

  /** Wire filters, size control, drag/drop and live inputs once the DOM is in place. */
  #hydrate(content) {
    const adapter = systemAdapter();
    const filters = content.querySelector(".wol-b-filters");

    const fill = (name, options, selected, allLabel) => {
      const el = filters.querySelector(`[name=${name}]`);
      if (!el) return;
      el.innerHTML = `<option value="">${allLabel}</option>`
        + options.map(o => `<option value="${o.value}"${o.value === selected ? " selected" : ""}>${
          foundry.utils.escapeHTML(o.label)}</option>`).join("");
    };
    fill("type", catalogueTypes().map(x => ({value: x, label: x})), this.filters.type, t("Builder.AnyType"));
    fill("rarity", adapter.rarities.map(r => ({value: r, label: adapter.rarityLabel(r)})),
      this.filters.rarity, t("Builder.AnyRarity"));
    fill("pack", cataloguePacks().map(x => ({value: x.id, label: x.label})),
      this.filters.pack, t("Builder.AllPacks"));
    fill("source", catalogueSources().map(x => ({value: x, label: x})),
      this.filters.source, t("Builder.AnySource"));

    const onFilterChange = ev => {
      const el = ev.target;
      if (!el.name) return;
      this.filters[el.name] = el.type === "checkbox" ? el.checked : el.value;
      this.#renderCatalogue(content);
    };
    filters.addEventListener("input", onFilterChange);
    filters.addEventListener("change", onFilterChange);

    this.#wireSizeControl(content);

    // Weight edits are live-bound rather than action-driven so typing a number
    // updates the tally immediately.
    content.querySelector("[data-role=entries]").addEventListener("input", ev => {
      const li = ev.target.closest("li[data-index]");
      if (!li) return;
      const index = Number(li.dataset.index);

      const weightInput = ev.target.closest("input[data-weight]");
      if (weightInput) {
        this.entries[index].weight = Math.max(1, Math.round(Number(weightInput.value) || 1));
      }

      const stockInput = ev.target.closest("input[data-stock]");
      if (stockInput) {
        // Blank means an endless supply, which is what a wedge was before
        // stock existed; zero means claimed, and must not read as blank.
        const raw = stockInput.value.trim();
        this.entries[index].stock = raw === "" ? null : Math.max(0, Math.floor(Number(raw) || 0));
        const box = stockInput.closest(".stock");
        box?.classList.toggle("limited", this.entries[index].stock != null);
        box?.classList.toggle("out", this.entries[index].stock === 0);
      }

      const oddsInput = ev.target.closest("input[data-odds]");
      if (oddsInput) {
        this.entries[index].odds = clampOdds(oddsInput.value);
        // Colour the control the moment it stops meaning "as likely as it looks".
        oddsInput.closest(".odds")?.classList.toggle("bent", this.entries[index].odds !== DEFAULT_ODDS);
      }

      if (!weightInput && !oddsInput && !stockInput) return;
      this.#markDirty(content);
      this.#renderTally(content);
      this.#renderChances(content);
    });

    this.#wireDropZone(content);
    this.#renderCatalogue(content);
    this.#renderEntries(content);
  }

  /**
   * The wheel's size, as a preset with an escape hatch.
   *
   * Presets cover what most wheels want; the number box appears only when
   * "Custom" is chosen, so the common case stays a single click and the
   * uncommon one is still reachable.
   */
  #wireSizeControl(content) {
    const preset = content.querySelector("[name=slotPreset]");
    const custom = content.querySelector("[name=slotCustom]");

    preset.addEventListener("change", () => {
      if (preset.value === "custom") {
        custom.hidden = false;
        custom.focus();
        custom.select();
        return;
      }
      custom.hidden = true;
      this.#setTarget(Number(preset.value), content);
    });

    custom.addEventListener("change", () => this.#setTarget(Number(custom.value), content));
  }

  #setTarget(value, content) {
    const next = clampSlots(value);
    if (next === this.target) return;
    this.target = next;
    const custom = content.querySelector("[name=slotCustom]");
    if (custom) custom.value = next;
    this.#markDirty(content);
    this.#renderTally(content);
  }

  /** Accept both internal catalogue drags and Foundry's own document drags. */
  #wireDropZone(content) {
    const zone = content.querySelector("[data-role=dropzone]");

    zone.addEventListener("dragover", ev => {
      ev.preventDefault();
      zone.classList.add("drop-active");
    });
    zone.addEventListener("dragleave", ev => {
      if (!zone.contains(ev.relatedTarget)) zone.classList.remove("drop-active");
    });
    zone.addEventListener("drop", async ev => {
      ev.preventDefault();
      zone.classList.remove("drop-active");

      let uuid = null;
      const raw = ev.dataTransfer?.getData("text/plain");
      if (raw) {
        try {
          // Foundry sidebar/compendium drags look like {type: "Item", uuid}.
          const data = JSON.parse(raw);
          if (data?.uuid) uuid = data.uuid;
        } catch {
          if (raw.startsWith("Compendium.") || raw.startsWith("Item.")) uuid = raw;
        }
      }
      if (!uuid) return;
      await this.#addByUuid(uuid, content);
    });
  }

  async #addByUuid(uuid, content) {
    if (this.entries.some(e => e.uuid === uuid)) {
      ui.notifications.info(t("Notify.AlreadyOnWheel"));
      return;
    }
    const adapter = systemAdapter();
    let row = catalogueRow(uuid);
    if (!row) {
      // Something outside the indexed packs — resolve it directly.
      const doc = await fromUuid(uuid);
      if (!doc || doc.documentName !== "Item") {
        ui.notifications.warn(t("Notify.ItemsOnly"));
        return;
      }
      row = {
        uuid, name: doc.name, img: doc.img,
        rarity: adapter.rarityOf(doc),
        source: foundry.utils.getProperty(doc, "system.source.book")
          || foundry.utils.getProperty(doc, "system.source.custom") || "",
        profile: adapter.useProfile(doc)
      };
    }

    // A different printing of something already on the wheel is easy to add by
    // accident when four books carry the same name.
    if (this.entries.some(e => e.name === row.name)) {
      ui.notifications.warn(t("Notify.TwinOnWheel", {name: row.name}));
    }
    if (row.profile === "recharge") {
      ui.notifications.warn(t("Notify.Recharges", {name: row.name}));
    }

    this.entries.push(this.#toEntry(row, 1));
    this.#markDirty(content);
    this.#renderEntries(content);
    this.#renderCatalogue(content);
  }

  /** Catalogue row -> working entry. */
  #toEntry(row, weight) {
    return {
      uuid: row.uuid,
      name: row.name,
      img: row.img,
      description: "",
      custom: false,
      weight,
      odds: DEFAULT_ODDS,
      jackpot: false,
      stock: null,
      rarity: row.rarity ?? null,
      source: row.source ?? "",
      profile: row.profile ?? "single",
      missing: false,
      isCoin: false
    };
  }

  /* ---------------------------------------- */
  /*  Lists                                   */
  /* ---------------------------------------- */

  #renderCatalogue(content) {
    const adapter = systemAdapter();
    const list = content.querySelector("[data-role=catalogue]");
    const rows = this.pool;
    const shown = rows.slice(0, CATALOGUE_CAP);

    list.innerHTML = shown.map(c => {
      const use = USE_LABEL[c.profile];
      return `
      <li class="wol-b-row" draggable="true" data-uuid="${c.uuid}">
        <img src="${foundry.utils.escapeHTML(c.img || "icons/svg/item-bag.svg")}" alt="">
        <span class="nm">${foundry.utils.escapeHTML(c.name)}</span>
        <span class="src" data-tooltip="${foundry.utils.escapeHTML(c.packLabel)}">${
          foundry.utils.escapeHTML(c.source || "—")}</span>
        ${c.group?.length > 1
          ? `<button type="button" class="var grouped" data-action="variants" data-uuid="${c.uuid}"
              data-tooltip="${t("Builder.Variants", {n: c.group.length})}">${c.group.length}&times;</button>`
          : (c.variants > 1
            ? `<span class="var${c.redundant ? " dup" : ""}"
                data-tooltip="${c.redundant ? t("Builder.LikelyDuplicate") : t("Builder.Variants", {n: c.variants})}"
                >${c.variants}&times;</span>`
            : `<span class="var"></span>`)}
        ${adapter.tracksUses ? `<span class="use u-${c.profile}" data-tooltip="${t(use.key)}">${use.tag}</span>` : ""}
        ${c.rarity ? `<span class="rar r-${c.rarity}">${adapter.rarityLabel(c.rarity)}</span>` : `<span class="rar"></span>`}
        <button type="button" data-action="expand" data-uuid="${c.uuid}" data-tooltip="${t("Builder.ShowDetail")}">
          <i class="fa-solid fa-chevron-down"></i>
        </button>
        <button type="button" data-action="add" data-uuid="${c.uuid}" data-tooltip="${t("Builder.AddToWheel")}">
          <i class="fa-solid fa-plus"></i>
        </button>
      </li>`;
    }).join("");

    list.querySelectorAll("li[draggable]").forEach(li => {
      li.addEventListener("dragstart", ev => {
        ev.dataTransfer.setData("text/plain", JSON.stringify({type: "Item", uuid: li.dataset.uuid}));
      });
    });

    // Say what folding removed, not just what survived: a GM with 2,000
    // redundant rows wants to know that, and one with none wants to be sure the
    // filter is not quietly hiding something they meant to see.
    const matched = this.matched.length;
    const hidden = matched - rows.length;
    const count = content.querySelector("[data-role=catcount]");
    const shownText = rows.length > CATALOGUE_CAP
      ? t("Builder.ShowingCapped", {cap: CATALOGUE_CAP, total: rows.length})
      : t("Builder.ShowingAll", {n: rows.length});
    count.textContent = hidden > 0
      ? `${shownText} — ${t("Builder.Folded", {n: hidden})}`
      : shownText;
  }

  #renderEntries(content) {
    const adapter = systemAdapter();
    const list = content.querySelector("[data-role=entries]");

    if (!this.entries.length) {
      list.innerHTML = `<li class="wol-b-empty">${t("Builder.EmptyWheel")}</li>`;
      this.#renderTally(content);
      return;
    }

    // Two wedges with the same name are almost never intended, so surface it.
    const nameCounts = new Map();
    this.entries.forEach(e => nameCounts.set(e.name, (nameCounts.get(e.name) ?? 0) + 1));

    list.innerHTML = this.entries.map((e, i) => {
      const use = USE_LABEL[e.profile ?? "single"];
      const clash = nameCounts.get(e.name) > 1;
      return `
      <li class="wol-b-row entry${e.isCoin ? " coin" : ""}${e.custom ? " custom" : ""}${
        e.missing ? " missing" : ""}${clash ? " clash" : ""}" data-index="${i}">
        <img src="${foundry.utils.escapeHTML(e.img || "icons/svg/item-bag.svg")}" alt="">
        <span class="nm">${e.missing ? `<i class="fa-solid fa-triangle-exclamation" data-tooltip="${
          t("Builder.MissingItem")}"></i> ` : ""}${clash ? `<i class="fa-solid fa-clone" data-tooltip="${
          t("Builder.NameClash")}"></i> ` : ""}${foundry.utils.escapeHTML(e.name)}</span>
        ${e.uuid
          ? `<span class="src" data-tooltip="${t("Builder.SourceBook")}">${
              foundry.utils.escapeHTML(e.source || "—")}</span>`
          : `<span class="src">${e.custom ? t("Builder.CustomTag") : ""}</span>`}
        ${adapter.tracksUses ? (e.uuid
          ? `<span class="use u-${e.profile ?? "single"}" data-tooltip="${t(use.key)}">${use.tag}</span>`
          : `<span class="use"></span>`) : ""}
        ${e.rarity ? `<span class="rar r-${e.rarity}">${adapter.rarityLabel(e.rarity)}</span>` : `<span class="rar"></span>`}
        <span class="slots">
          <button type="button" data-action="bump" data-index="${i}" data-delta="-1"><i class="fa-solid fa-minus"></i></button>
          <input type="number" min="1" step="1" value="${e.weight}" data-weight aria-label="${t("Builder.Slots")}">
          <button type="button" data-action="bump" data-index="${i}" data-delta="1"><i class="fa-solid fa-plus"></i></button>
        </span>
        <span class="odds${(e.odds ?? DEFAULT_ODDS) === DEFAULT_ODDS ? "" : " bent"}"
          data-tooltip="${t("Builder.OddsHint")}">
          <input type="number" min="${MIN_ODDS}" max="${MAX_ODDS}" step="5"
            value="${e.odds ?? DEFAULT_ODDS}" data-odds aria-label="${t("Builder.Odds")}">
          <span class="pct">%</span>
        </span>
        <span class="stock${e.stock != null ? " limited" : ""}${e.stock === 0 ? " out" : ""}"
          data-tooltip="${t("Builder.StockHint")}">
          <input type="number" min="0" step="1" placeholder="∞"
            value="${e.stock ?? ""}" data-stock aria-label="${t("Builder.Stock")}">
        </span>
        <span class="chance" data-role="chance-${i}"></span>
        <button type="button" class="jp${e.jackpot ? " on" : ""}" data-action="jackpot" data-index="${i}"
          data-tooltip="${t("Builder.JackpotHint")}">
          <i class="fa-solid fa-star"></i>
        </button>
        ${e.custom || e.missing
          ? `<button type="button" class="ed" data-action="editEntry" data-index="${i}"
              data-tooltip="${t(e.missing ? "Builder.RepairTip" : "Builder.EditPrizeTip")}">
              <i class="fa-solid fa-pen"></i>
            </button>`
          : `<span class="ed"></span>`}
        <button type="button" class="rr" data-action="rerollOne" data-index="${i}"
          data-tooltip="${t("Builder.RerollHint")}"${e.isCoin ? " disabled" : ""}>
          <i class="fa-solid fa-dice-d20"></i>
        </button>
        <button type="button" class="rm" data-action="remove" data-index="${i}" data-tooltip="${t("Builder.RemoveHint")}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </li>`;
    }).join("");
    this.#renderTally(content);
    this.#renderChances(content);
  }

  /**
   * Put the real probability beside every wedge.
   *
   * The whole point of weighting is that the wheel no longer says what it
   * means, so the GM setting it has to be able to see the truth. Rendered
   * separately from the rows because it changes on every slot and odds edit.
   */
  #renderChances(content) {
    const chances = trueChances(this.entries.map(e => ({
      count: e.weight, odds: e.odds, depleted: e.stock === 0
    })));
    this.entries.forEach((entry, i) => {
      const cell = content.querySelector(`[data-role="chance-${i}"]`);
      if (!cell) return;
      const pct = chances[i] * 100;
      cell.textContent = pct >= 10 ? `${pct.toFixed(0)}%`
        : (pct >= 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`);
      // Flag the gap between what the wedge looks like and what it is.
      const naive = this.slotTotal ? (entry.weight / this.slotTotal) * 100 : 0;
      const bent = Math.abs(pct - naive) > 0.05;
      cell.classList.toggle("bent", bent);
      cell.dataset.tooltip = bent
        ? t("Builder.ChanceBent", {shown: naive.toFixed(1), real: pct.toFixed(2)})
        : t("Builder.ChancePlain");
    });
  }

  #renderTally(content) {
    const total = this.slotTotal;
    const delta = total - this.target;
    const el = content.querySelector("[data-role=tally]");
    const state = delta === 0 ? "ok" : (delta > 0 ? "over" : "under");
    const note = delta === 0
      ? t("Builder.Balanced")
      : (delta > 0 ? t("Builder.Over", {n: delta}) : t("Builder.Under", {n: -delta}));
    el.className = `wol-b-tally ${state}`;
    el.innerHTML = `<strong>${total}</strong> / ${this.target} ${t("Builder.SlotsWord")} — ${note}
      &nbsp;·&nbsp; ${t("Builder.NWedges", {n: this.entries.length})}`;

    // A weighted wheel no longer reads its odds off the picture, so say so
    // rather than letting the slot tally imply something untrue.
    if (!isUnweighted(this.entries.map(e => ({odds: e.odds})))) {
      el.innerHTML += ` &nbsp;·&nbsp; <span class="weighted">${t("Builder.Weighted")}</span>`;
    }

    const pad = content.querySelector("[data-role=padlabel]");
    if (pad) pad.textContent = t("Builder.PadTo", {n: this.target});
  }

  #markDirty(content) {
    this.dirty = true;
    const title = content.closest(".application")?.querySelector(".window-title");
    if (title) title.textContent = this.title;
  }

  /* ---------------------------------------- */
  /*  Manual actions                          */
  /* ---------------------------------------- */

  static async #onAdd(event, target) {
    await this.#addByUuid(target.dataset.uuid, this.element);
  }

  static #onRemove(event, target) {
    this.entries.splice(Number(target.dataset.index), 1);
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
    this.#renderCatalogue(this.element);
  }

  static #onBump(event, target) {
    const i = Number(target.dataset.index);
    const delta = Number(target.dataset.delta);
    this.entries[i].weight = Math.max(1, this.entries[i].weight + delta);
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
  }

  static #onAddCoin(event, target) {
    const amount = Number(this.element.querySelector("[name=coin]").value);
    // The denomination has to be written into the name, not just displayed:
    // the payout path reads it back out of the wedge name when the wheel lands.
    const name = `${amount} ${coinDenomination()}`;
    if (this.entries.some(e => e.name === name)) {
      ui.notifications.info(t("Notify.CoinOnWheel", {name}));
      return;
    }
    this.entries.push({
      uuid: null,
      name,
      img: "icons/commodities/currency/coin-engraved-jolly-roger-gold.webp",
      description: "",
      custom: false,
      weight: 1,
      odds: DEFAULT_ODDS,
      jackpot: false,
      stock: null,
      rarity: null,
      source: "",
      profile: "single",
      missing: false,
      isCoin: true
    });
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
  }

  /**
   * Add a prize that is not an item in this world at all.
   *
   * This closes the gap every GM hits eventually: the best rewards are
   * frequently not documents. A favour owed by the duke, a title, a rumour,
   * "roll again on the tavern table", a homebrew relic nobody has written up
   * yet — none of these is an Item, and before this the only way onto the wheel
   * was to create one first. That is a chore for a prize with no mechanics to
   * carry, and it leaves a junk item behind in the world afterwards.
   *
   * Stored as a text result, which the wheel has understood since the first
   * version: the reveal card shows the words, and the chat card tells the GM to
   * hand it over rather than pretending something was granted.
   */
  static async #onCustom(event, target) {
    const prize = await this.#askPrize({title: t("Builder.NewPrizeTitle")});
    if (!prize) return;
    this.entries.push(this.#toCustomEntry(prize));
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
  }

  /**
   * Edit a prize that has no working document behind it.
   *
   * Offered in two cases, for one reason: the wedge's own fields are the only
   * description of the prize that exists. A custom prize is edited outright,
   * and a wedge whose item has been deleted can be *kept* — its name and art
   * are still on the table result, so instead of making the GM delete the wedge
   * and rebuild it, the broken link is cut and what remains becomes a custom
   * prize.
   *
   * A working item-backed wedge is deliberately not editable here. Its name and
   * art come from the item, and letting them drift apart would mean the wheel
   * promising one thing and granting another.
   */
  static async #onEditEntry(event, target) {
    const i = Number(target.dataset.index);
    const entry = this.entries[i];
    if (!entry) return;
    const repair = !!entry.missing;

    const prize = await this.#askPrize({
      title: repair ? t("Builder.RepairTitle") : t("Builder.EditPrizeTitle"),
      entry,
      repair
    });
    if (!prize) return;

    this.entries[i] = {
      ...entry,
      ...this.#toCustomEntry(prize),
      // Slots, odds, jackpot and stock describe the wedge's place on the wheel
      // rather than what the prize is, so editing the prize must not silently
      // retune how likely it is or how many are left.
      weight: entry.weight,
      odds: entry.odds,
      jackpot: entry.jackpot,
      stock: entry.stock
    };
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
  }

  /** A dialog's answer -> a working entry with no document behind it. */
  #toCustomEntry(prize) {
    // A prize typed as "500 gp" is coin whichever route it arrived by, because
    // the payout path reads the denomination back out of the name.
    const isCoin = !!systemAdapter().parseCurrency(prize.name);
    return {
      uuid: null,
      name: prize.name,
      img: prize.img,
      description: prize.description,
      custom: !isCoin,
      weight: 1,
      odds: DEFAULT_ODDS,
      jackpot: false,
      stock: null,
      rarity: prize.rarity,
      source: "",
      profile: "single",
      missing: false,
      isCoin
    };
  }

  /**
   * The form behind a custom prize.
   *
   * Four fields, because four is what a wedge actually shows: the name on the
   * rim, the art on the reveal card, the ink that name is printed in, and the
   * words underneath it. The rarity select is omitted entirely in a system that
   * has no rarities rather than offered and ignored.
   */
  async #askPrize({title, entry = null, repair = false}) {
    const adapter = systemAdapter();
    const name = entry?.name ?? "";
    const img = entry?.img || DEFAULT_PRIZE_IMG;
    const description = entry?.description ?? "";
    const rarity = entry?.rarity ?? "";

    const result = await DialogV2.wait({
      window: {title, icon: "fa-solid fa-gift"},
      classes: ["wol-dialog"],
      content: `<div class="wol-form wol-prizeform">
          <p class="hint">${t(repair ? "Builder.RepairHint" : "Builder.NewPrizeHint")}</p>
          <div class="form-group">
            <label for="wol-prize-name">${t("Builder.PrizeName")}</label>
            <input type="text" id="wol-prize-name" name="name"
              value="${foundry.utils.escapeHTML(name)}" autofocus>
          </div>
          <div class="form-group">
            <label for="wol-prize-img">${t("Builder.PrizeImage")}</label>
            <file-picker id="wol-prize-img" name="img" type="image"
              value="${foundry.utils.escapeHTML(img)}"></file-picker>
          </div>
          ${adapter.rarities.length ? `<div class="form-group">
            <label for="wol-prize-rarity">${t("Builder.PrizeRarity")}</label>
            <select id="wol-prize-rarity" name="rarity">
              <option value="">${t("Builder.PrizeNoRarity")}</option>
              ${adapter.rarities.map(r => `<option value="${r}"${
                r === rarity ? " selected" : ""}>${adapter.rarityLabel(r)}</option>`).join("")}
            </select>
          </div>` : ""}
          <div class="form-group wol-prize-text">
            <label for="wol-prize-desc">${t("Builder.PrizeText")}</label>
            <textarea id="wol-prize-desc" name="description" rows="4">${
              foundry.utils.escapeHTML(description)}</textarea>
          </div>
          <p class="notes">${t("Builder.PrizeTextHint")}</p>
        </div>`,
      position: {width: 520},
      buttons: [
        {
          action: "ok",
          label: t(repair ? "Builder.RepairKeep" : "Builder.PrizeSave"),
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, button) => ({
            name: String(button.form.elements.name.value ?? "").trim(),
            img: String(button.form.elements.img.value ?? "").trim() || DEFAULT_PRIZE_IMG,
            description: String(button.form.elements.description.value ?? "").trim(),
            rarity: button.form.elements.rarity?.value || null
          })
        },
        {action: "cancel", label: t("Cancel"), icon: "fa-solid fa-xmark"}
      ],
      rejectClose: false,
      modal: true
    });

    if (!result || result === "cancel") return null;
    // A nameless wedge is a blank slice the players cannot read, so this is
    // refused rather than defaulted to something meaningless.
    if (!result.name) {
      ui.notifications.warn(t("Notify.PrizeNeedsName"));
      return null;
    }
    return result;
  }

  /**
   * Absorb the shortfall (or excess) into the heaviest entry, which is almost
   * always the bulk filler. Never drops an entry below one slot.
   */
  static #onPad(event, target) {
    const delta = this.target - this.slotTotal;
    if (!delta) return void ui.notifications.info(t("Notify.AlreadyBalanced", {n: this.target}));
    if (!this.entries.length) return void ui.notifications.warn(t("Notify.NothingToPad"));

    const heaviest = this.entries.reduce((a, b) => (b.weight > a.weight ? b : a));
    const next = heaviest.weight + delta;
    if (next < 1) {
      ui.notifications.warn(t("Notify.CannotAbsorb", {n: -delta, name: heaviest.name}));
      return;
    }
    heaviest.weight = next;
    ui.notifications.info(delta > 0
      ? t("Notify.PaddedUp", {n: delta, name: heaviest.name})
      : t("Notify.PaddedDown", {n: -delta, name: heaviest.name}));
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
  }

  /* ---------------------------------------- */
  /*  Rolling                                 */
  /* ---------------------------------------- */

  /**
   * Swap one wedge for a random item from the filtered pool, keeping its slots.
   *
   * Re-rolling a single wedge is the move you actually want most often: the
   * wheel is nearly right and one prize is wrong for the party. Holding the
   * slot count steady means the odds you tuned survive the swap.
   */
  /**
   * Mark the wedge the table is really hoping for.
   *
   * Only one at a time: a wheel with four grand prizes has no grand prize, and
   * the flourish on landing only means anything if it is rare.
   */
  static #onJackpot(event, target) {
    const i = Number(target.dataset.index);
    const wasOn = this.entries[i].jackpot === true;
    this.entries.forEach(e => { e.jackpot = false; });
    this.entries[i].jackpot = !wasOn;
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
  }

  static #onRerollOne(event, target) {
    const i = Number(target.dataset.index);
    const entry = this.entries[i];
    if (entry.isCoin) return;

    // The pool already excludes what is on the wheel when "hide used" is on;
    // exclude explicitly as well so the filter's state cannot hand back a
    // wedge that is already there.
    const used = new Set(this.entries.map(e => e.uuid).filter(Boolean));
    const pool = this.pool.filter(c => !used.has(c.uuid));
    if (!pool.length) {
      ui.notifications.warn(t("Notify.PoolEmpty"));
      return;
    }

    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.entries[i] = this.#toEntry(pick, entry.weight);
    ui.notifications.info(t("Notify.Rerolled", {from: entry.name, to: pick.name}));
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
    this.#renderCatalogue(this.element);
  }

  /**
   * Throw the wheel away and roll a fresh one from the filtered pool.
   *
   * Asks for the number of distinct prizes rather than inferring it: a 64-slot
   * wheel of eight prizes and one of thirty-two are both reasonable, and only
   * the GM knows which they meant.
   */
  static async #onRollWheel(event, target) {
    const adapter = systemAdapter();
    const pool = this.pool;
    if (!pool.length) {
      ui.notifications.warn(t("Notify.PoolEmpty"));
      return;
    }

    const maxWedges = Math.min(pool.length, this.target);
    const suggested = Math.min(maxWedges, Math.max(4, Math.round(this.target / 4)));

    const answer = await this.#askRoll({
      title: t("Builder.RollWheelTitle"),
      hint: t("Builder.RollWheelBody", {pool: pool.length, slots: this.target}),
      max: maxWedges,
      value: suggested,
      showRarity: adapter.rarities.length > 0
    });
    if (!answer) return;

    const planned = planWheel(pool, {
      wedges: answer.wedges,
      total: this.target,
      byRarity: answer.byRarity,
      rarities: adapter.rarities
    });
    if (!planned.length) {
      ui.notifications.warn(t("Notify.PoolEmpty"));
      return;
    }

    this.entries = planned.map(p => this.#toEntry(p.row, p.weight));
    this.entries.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
    ui.notifications.info(t("Notify.WheelRolled", {wedges: this.entries.length, slots: this.slotTotal}));
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
    this.#renderCatalogue(this.element);
  }

  /**
   * Top the wheel up to its target without disturbing what is already there.
   *
   * The complement of "roll a new wheel": a GM who has hand-picked six prizes
   * usually wants the remaining slots filled, not their six choices replaced.
   */
  static async #onFill(event, target) {
    const shortfall = this.target - this.slotTotal;
    if (shortfall <= 0) {
      ui.notifications.info(t("Notify.NoRoom", {n: this.target}));
      return;
    }

    const used = new Set(this.entries.map(e => e.uuid).filter(Boolean));
    const pool = this.pool.filter(c => !used.has(c.uuid));
    if (!pool.length) {
      ui.notifications.warn(t("Notify.PoolEmpty"));
      return;
    }

    const adapter = systemAdapter();
    const maxWedges = Math.min(pool.length, shortfall);
    const answer = await this.#askRoll({
      title: t("Builder.FillTitle"),
      hint: t("Builder.FillBody", {slots: shortfall, pool: pool.length}),
      max: maxWedges,
      value: Math.min(maxWedges, Math.max(1, Math.round(shortfall / 3))),
      showRarity: adapter.rarities.length > 0
    });
    if (!answer) return;

    const planned = planWheel(pool, {
      wedges: answer.wedges,
      total: shortfall,
      byRarity: answer.byRarity,
      rarities: adapter.rarities
    });
    this.entries.push(...planned.map(p => this.#toEntry(p.row, p.weight)));
    this.entries.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
    ui.notifications.info(t("Notify.Filled", {wedges: planned.length, slots: shortfall}));
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
    this.#renderCatalogue(this.element);
  }

  /* ---------------------------------------- */
  /*  Dry run                                 */
  /* ---------------------------------------- */

  /**
   * The working set expressed as table results, without writing anything.
   *
   * The same shape `#onSave` would write, so what the dry run assembles is
   * literally what saving would produce — including the odds, the jackpot and
   * the stock, which are the three things a GM most wants to check before
   * putting a wheel in front of the table.
   *
   * @returns {object[]}
   */
  #asResults() {
    let cursor = 1;
    return this.entries.map(e => {
      const range = [cursor, cursor + e.weight - 1];
      cursor += e.weight;
      const flags = {
        odds: clampOdds(e.odds ?? DEFAULT_ODDS),
        jackpot: e.jackpot === true,
        stock: e.stock ?? null,
        rarity: e.rarity ?? null
      };
      return {
        range,
        type: e.uuid ? CONST.TABLE_RESULT_TYPES.DOCUMENT : CONST.TABLE_RESULT_TYPES.TEXT,
        documentUuid: e.uuid ?? null,
        name: e.name,
        img: e.img,
        description: e.description ?? "",
        id: null,
        getFlag: (module, key) => flags[key]
      };
    });
  }

  /**
   * Show the wheel exactly as the table will meet it, and let the GM spin it.
   *
   * A builder is a list of names and numbers; a wheel is a thing the players
   * watch. The gap between the two is where the surprises live — a prize whose
   * name is too long to read at 64 slices, a jackpot that turns out to be
   * invisible, a palette that fights the art, an odds tweak that quietly made
   * the grand prize impossible. All of that is obvious in one spin and
   * invisible in a list.
   *
   * Local to this client and bound to nothing: no session, no broadcast, no
   * credit spent, no prize granted, no stock decremented, nothing written to
   * the table. It runs on the *unsaved* working set on purpose, so a GM can try
   * a change, look at it, and abandon it by closing the builder.
   */
  static async #onDryRun(event, target) {
    if (!this.entries.length) {
      ui.notifications.warn(t("Notify.NothingToPreview"));
      return;
    }

    const {entries, slots, missing} = await buildEntries(this.#asResults());
    if (!entries.length) {
      ui.notifications.warn(t("Notify.NothingToPreview"));
      return;
    }

    // The rehearsal doubles as a check: a wedge pointing at a deleted item is
    // reported here, rather than at the table where it costs somebody a spin.
    if (missing.length) {
      ui.notifications.warn(t("Notify.PreviewMissing", {
        n: missing.length,
        names: missing.slice(0, 3).join(", ") + (missing.length > 3 ? "…" : "")
      }));
    }

    const {LootWheel} = await import("./wheel-app.js");
    const {appearance, rules} = resolveWheelConfig(this.table);
    LootWheel.preview({
      tableName: this.table.name,
      entries,
      // A fresh seed each time, so two rehearsals do not lay out identically
      // and the GM sees the spread the layout actually produces.
      layout: disperseSlots(entries, slots, Math.floor(Math.random() * 0xFFFFFFFF)),
      appearance,
      rules,
      dryRun: true
    });
  }

  /** Shared prompt for the two rolling actions. */
  async #askRoll({title, hint, max, value, showRarity}) {
    const result = await DialogV2.wait({
      window: {title, icon: "fa-solid fa-dice"},
      classes: ["wol-dialog"],
      content: `<div class="wol-form">
          <p class="hint">${hint}</p>
          <div class="form-group">
            <label for="wol-wedges">${t("Builder.HowManyPrizes")}</label>
            <input type="number" id="wol-wedges" name="wedges" min="1" max="${max}" step="1" value="${value}">
          </div>
          ${showRarity ? `<label class="wol-b-check">
            <input type="checkbox" name="byRarity" checked>
            ${t("Builder.WeightByRarity")}
          </label>
          <p class="notes">${t("Builder.WeightByRarityHint")}</p>` : ""}
        </div>`,
      position: {width: 460},
      buttons: [
        {
          action: "roll",
          label: t("Builder.Roll"),
          icon: "fa-solid fa-dice",
          default: true,
          callback: (event, button) => ({
            wedges: Math.max(1, Math.min(max, Math.round(Number(button.form.elements.wedges.value) || 1))),
            byRarity: !!button.form.elements.byRarity?.checked
          })
        },
        {action: "cancel", label: t("Cancel"), icon: "fa-solid fa-xmark"}
      ],
      rejectClose: false,
      modal: true
    });
    return (!result || result === "cancel") ? null : result;
  }

  /**
   * Open the settings form scoped to this wheel.
   *
   * The same form as the world settings, because the things a wheel can
   * override are the same things — only here a blank field means "whatever the
   * world says" rather than "nothing".
   */
  static async #onWheelSettings(event, target) {
    const {WheelSettings} = await import("./settings-menu.js");
    new WheelSettings({wheel: this.table}).render({force: true});
  }

  static async #onClearWheel(event, target) {
    if (!this.entries.length) return;
    const ok = await DialogV2.confirm({
      window: {title: t("Builder.ClearTitle")},
      content: `<p>${t("Builder.ClearBody", {n: this.entries.length})}</p>`,
      modal: true
    });
    if (!ok) return;
    this.entries = [];
    this.#markDirty(this.element);
    this.#renderEntries(this.element);
    this.#renderCatalogue(this.element);
  }

  /* ---------------------------------------- */
  /*  Inspection                              */
  /* ---------------------------------------- */

  /**
   * Show what an item actually does, inline under its row.
   *
   * With four "Dust of Dryness" entries across three books, the only way to
   * pick the right one is to read them, so this pulls the real document rather
   * than anything the index carries.
   */
  static async #onExpand(event, target) {
    const adapter = systemAdapter();
    const li = target.closest("li");
    const list = li.parentElement;
    const icon = target.querySelector("i");
    const open = li.nextElementSibling?.classList.contains("wol-b-detail");

    // Only one panel at a time, so comparing means clicking down the list.
    list.querySelectorAll(".wol-b-detail").forEach(n => n.remove());
    list.querySelectorAll("[data-action=expand] i").forEach(i => { i.className = "fa-solid fa-chevron-down"; });
    if (open) return;

    const panel = document.createElement("li");
    panel.className = "wol-b-detail";
    panel.innerHTML = `<p class="muted"><i class="fa-solid fa-spinner fa-spin"></i> ${t("Loading")}</p>`;
    li.after(panel);
    icon.className = "fa-solid fa-chevron-up";

    const doc = await fromUuid(target.dataset.uuid);
    if (!doc) {
      panel.innerHTML = `<p class="muted">${t("Builder.CouldNotLoad")}</p>`;
      return;
    }

    const s = doc.system ?? {};
    const uses = s.uses ?? {};
    const recovery = (Array.isArray(uses.recovery) ? uses.recovery : [])
      .filter(r => r?.period)
      .map(r => `${r.formula ? `${r.formula} ` : ""}per ${r.period}`)
      .join(", ");
    const profile = adapter.useProfile(doc);

    // Every fact goes through the adapter, so this panel says something true in
    // a world running any system rather than dashes in all but one.
    const maxUses = adapter.usesMaxOf(doc);
    const facts = [
      [t("Builder.Fact.Source"), adapter.sourceOf(doc) || "—"],
      [t("Builder.Fact.Pack"), doc.compendium?.metadata?.label ?? t("Catalogue.WorldItems")],
      [t("Builder.Fact.Rarity"), adapter.rarityOf(doc) ? adapter.rarityLabel(adapter.rarityOf(doc)) : "—"],
      [t("Builder.Fact.Price"), adapter.priceOf(doc) ?? "—"],
      [t("Builder.Fact.Uses"), maxUses ? `${maxUses}${recovery ? ` (${recovery})` : ""}` : t("Use.Single")],
      [t("Builder.Fact.Type"), adapter.subtypeOf(doc) || doc.type]
    ];

    panel.innerHTML = `
      <div class="wol-b-detailbox">
        <dl class="facts">
          ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${foundry.utils.escapeHTML(String(v))}</dd></div>`).join("")}
        </dl>
        ${adapter.tracksUses && profile !== "single" ? `<p class="warn"><i class="fa-solid fa-triangle-exclamation"></i>
          ${t(profile === "recharge" ? "Builder.WarnRecharge" : "Builder.WarnCharges")}</p>` : ""}
        <p class="desc">${foundry.utils.escapeHTML(
          await richText(adapter.descriptionOf(doc), 1200) || t("Builder.NoDescription"))}</p>
      </div>`;
  }

  /**
   * List the printings a folded row stands for.
   *
   * Never a silent choice: four "Dust of Dryness" entries really are four
   * different items (one use versus ten), so the fold picks a representative
   * for browsing and this is how the GM picks a different one.
   */
  static #onVariants(event, target) {
    const adapter = systemAdapter();
    const li = target.closest("li");
    const list = li.parentElement;
    const open = li.nextElementSibling?.classList.contains("wol-b-detail");

    list.querySelectorAll(".wol-b-detail").forEach(n => n.remove());
    if (open) return;

    const row = this.pool.find(c => c.uuid === target.dataset.uuid);
    if (!row?.group?.length) return;

    const panel = document.createElement("li");
    panel.className = "wol-b-detail";
    panel.innerHTML = `
      <div class="wol-b-variants">
        <p class="muted">${t("Builder.VariantsHeading", {name: foundry.utils.escapeHTML(row.name)})}</p>
        <ol>
          ${row.group.map(g => `
            <li class="wol-b-row">
              <img src="${foundry.utils.escapeHTML(g.img || "icons/svg/item-bag.svg")}" alt="">
              <span class="nm">${foundry.utils.escapeHTML(g.source || t("Builder.NoSource"))}</span>
              <span class="src" data-tooltip="${foundry.utils.escapeHTML(g.packLabel)}">${
                foundry.utils.escapeHTML(g.packLabel)}</span>
              ${g.rarity ? `<span class="rar r-${g.rarity}">${adapter.rarityLabel(g.rarity)}</span>` : `<span class="rar"></span>`}
              ${g.usesMax != null ? `<span class="use">${g.usesMax}&times;</span>` : `<span class="use"></span>`}
              <button type="button" data-action="expand" data-uuid="${g.uuid}"
                data-tooltip="${t("Builder.ShowDetail")}"><i class="fa-solid fa-chevron-down"></i></button>
              <button type="button" data-action="add" data-uuid="${g.uuid}"
                data-tooltip="${t("Builder.AddToWheel")}"><i class="fa-solid fa-plus"></i></button>
            </li>`).join("")}
        </ol>
      </div>`;
    li.after(panel);
  }

  static #onClearFilters(event, target) {
    this.filters = {
      search: "", pack: "", source: "", type: "", rarity: "",
      hideUsed: true, singleUse: false, dupes: "name"
    };
    this.render();
  }

  /**
   * Re-index everything and re-check the wheel's entries.
   *
   * Compendium indexes are cached for the session, so items added, removed or
   * renamed in game do not show up until something drops that cache.
   */
  static async #onRefresh(event, target) {
    target.disabled = true;
    const original = target.innerHTML;
    target.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${t("Builder.Refreshing")}`;
    try {
      invalidateCatalogue();
      const cat = await buildCatalogue({force: true});
      await this.loadEntries();
      const gone = this.entries.filter(e => e.missing);
      await this.render();
      if (gone.length) {
        ui.notifications.warn(t("Notify.EntriesGone", {n: gone.length, names: gone.map(e => e.name).join(", ")}));
      } else {
        ui.notifications.info(t("Notify.Reindexed", {n: cat.length}));
      }
    } catch (err) {
      console.error("Wheel of Loot | refresh failed", err);
      ui.notifications.error(t("Notify.RefreshFailed"));
      target.disabled = false;
      target.innerHTML = original;
    }
  }

  /* ---------------------------------------- */
  /*  Saving                                  */
  /* ---------------------------------------- */

  static async #onSave(event, target) {
    if (!this.entries.length) {
      ui.notifications.warn(t("Notify.NothingToSave"));
      return;
    }

    const total = this.slotTotal;
    if (total !== this.target) {
      const go = await DialogV2.confirm({
        window: {title: t("Builder.UnbalancedTitle")},
        content: `<p>${t("Builder.UnbalancedBody", {total, target: this.target})}</p>
                  <p>${t("Builder.UnbalancedNote", {total})}</p>`,
        modal: true
      });
      if (!go) return;
    }

    // Rebuild every result from scratch: simpler than diffing, and the table is
    // small enough that a full replace is instant.
    let cursor = 1;
    const results = this.entries.map(e => {
      const range = [cursor, cursor + e.weight - 1];
      cursor += e.weight;
      const base = {
        name: e.name, img: e.img, weight: e.weight, range,
        flags: {[MODULE_ID]: {
          odds: clampOdds(e.odds ?? DEFAULT_ODDS),
          jackpot: e.jackpot === true,
          stock: e.stock ?? null
        }}
      };
      if (e.uuid) return {...base, type: CONST.TABLE_RESULT_TYPES.DOCUMENT, documentUuid: e.uuid};
      // A wedge with no document is the only kind that has to carry its own
      // rarity, since there is no item to read one off at spin time.
      base.flags[MODULE_ID].rarity = e.rarity ?? null;
      return {...base, type: CONST.TABLE_RESULT_TYPES.TEXT, description: e.description ?? ""};
    });

    try {
      const existing = this.table.results.map(r => r.id);
      if (existing.length) await this.table.deleteEmbeddedDocuments("TableResult", existing);
      await this.table.createEmbeddedDocuments("TableResult", results);
      await this.table.update({
        formula: `1d${cursor - 1}`,
        // Saying so is what lets the manager and the launcher tell a wheel from
        // an encounter table in a world full of both.
        [`flags.${MODULE_ID}.isWheel`]: true
      });
      this.dirty = false;
      ui.notifications.info(t("Notify.Saved", {
        name: this.table.name, wedges: results.length, slots: cursor - 1
      }));
      this.render();
    } catch (err) {
      console.error("Wheel of Loot | save failed", err);
      ui.notifications.error(t("Notify.SaveFailed"));
    }
  }

  /* ---------------------------------------- */
  /*  Entry points                            */
  /* ---------------------------------------- */

  static async open(table) {
    if (!game.user.isGM) return;
    await buildCatalogue();
    const app = new WheelBuilder(table);
    await app.loadEntries();
    return app.render({force: true});
  }

  /**
   * Make a brand new wheel table and open the builder on it.
   *
   * The table is created empty and immediately, rather than at Save: a real
   * document means drag-and-drop from compendium windows works straight away,
   * and an abandoned empty table is a trivial thing to delete.
   *
   * @returns {Promise<RollTable|null>}
   */
  static async createNew() {
    if (!game.user.isGM) return null;

    const folders = game.folders.filter(f => f.type === "RollTable");
    const result = await DialogV2.wait({
      window: {title: t("Builder.NewTitle"), icon: "fa-solid fa-plus"},
      classes: ["wol-dialog"],
      content: `<div class="wol-form">
          <p class="hint">${t("Builder.NewHint")}</p>
          <div class="form-group">
            <label for="wol-new-name">${t("Builder.NewName")}</label>
            <input type="text" id="wol-new-name" name="name" value="${t("Builder.NewDefaultName")}">
          </div>
          <div class="form-group">
            <label for="wol-new-slots">${t("Builder.WheelSize")}</label>
            <select id="wol-new-slots" name="slots">
              ${SLOT_PRESETS.map(n => `<option value="${n}"${
                n === game.settings.get(MODULE_ID, "defaultSlots") ? " selected" : ""
              }>${t("Builder.NSlices", {n})}</option>`).join("")}
            </select>
          </div>
          ${folders.length ? `<div class="form-group">
            <label for="wol-new-folder">${t("Builder.NewFolder")}</label>
            <select id="wol-new-folder" name="folder">
              <option value="">${t("Builder.NoFolder")}</option>
              ${folders.map(f => `<option value="${f.id}">${foundry.utils.escapeHTML(f.name)}</option>`).join("")}
            </select>
          </div>` : ""}
        </div>`,
      position: {width: 460},
      buttons: [
        {
          action: "create",
          label: t("Builder.Create"),
          icon: "fa-solid fa-check",
          default: true,
          callback: (event, button) => ({
            name: button.form.elements.name.value.trim(),
            slots: Number(button.form.elements.slots.value),
            folder: button.form.elements.folder?.value || null
          })
        },
        {action: "cancel", label: t("Cancel"), icon: "fa-solid fa-xmark"}
      ],
      rejectClose: false,
      modal: true
    });

    if (!result || result === "cancel") return null;

    const name = result.name || t("Builder.NewDefaultName");
    const slots = clampSlots(result.slots);
    let table;
    try {
      table = await RollTable.create({
        name,
        folder: result.folder,
        // The formula has to match the wheel's size from the outset, or the
        // table validates as broken before a single prize is on it.
        formula: `1d${slots}`,
        replacement: true,
        displayRoll: false,
        img: "icons/svg/d20-grey.svg",
        flags: {[MODULE_ID]: {slots}}
      });
    } catch (err) {
      console.error("Wheel of Loot | could not create table", err);
      ui.notifications.error(t("Notify.CreateFailed"));
      return null;
    }

    await buildCatalogue();
    const app = new WheelBuilder(table);
    app.target = slots;
    await app.render({force: true});
    return table;
  }
}
