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

import {buildCatalogue, cachedCatalogue, catalogueRow, cataloguePacks, catalogueTypes, invalidateCatalogue} from "../core/catalogue.js";
import {clampSlots, MAX_SLOTS, MIN_SLOTS, richText, SLOT_PRESETS, slotCount} from "../core/wheel-data.js";
import {MODULE_ID, t} from "../core/constants.js";
import {planWheel} from "../core/wheel-plan.js";
import {systemAdapter} from "../systems/adapter.js";

const {ApplicationV2, DialogV2} = foundry.applications.api;

const USE_LABEL = {
  single: {tag: "1×", key: "Use.Single"},
  charges: {tag: "N×", key: "Use.Charges"},
  recharge: {tag: "↻", key: "Use.Recharge"}
};

/** Coin presets offered by the "add coin" control. */
const COIN_PRESETS = [10, 25, 50, 100, 250, 500, 1000];

/** Rows rendered before the list is cut short; the filters are the answer. */
const CATALOGUE_CAP = 300;

export class WheelBuilder extends ApplicationV2 {
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
      pad: WheelBuilder.#onPad,
      clearFilters: WheelBuilder.#onClearFilters,
      refresh: WheelBuilder.#onRefresh,
      expand: WheelBuilder.#onExpand,
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
    this.target = clampSlots(slotCount(table) || game.settings.get(MODULE_ID, "defaultSlots"));
    this.entries = [];
    this.filters = {
      search: "",
      pack: "",
      type: systemAdapter().id === "dnd5e" ? "consumable" : "",
      rarity: "",
      hideUsed: true,
      singleUse: systemAdapter().tracksUses
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
          source = doc ? (foundry.utils.getProperty(doc, "system.source.book")
            || foundry.utils.getProperty(doc, "system.source.custom") || "") : "";
          profile = doc ? adapter.useProfile(doc) : "single";
        }
      }
      rows.push({
        uuid: result.documentUuid ?? null,
        name: result.name,
        img: result.img,
        weight,
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

  /** Catalogue rows matching the current filters — the pool every roll draws from. */
  get pool() {
    const adapter = systemAdapter();
    const used = new Set(this.entries.map(e => e.uuid).filter(Boolean));
    const q = this.filters.search.trim().toLowerCase();
    return cachedCatalogue().filter(c => {
      if (this.filters.hideUsed && used.has(c.uuid)) return false;
      if (this.filters.singleUse && adapter.tracksUses && c.profile !== "single") return false;
      if (this.filters.type && c.itemType !== this.filters.type) return false;
      if (this.filters.rarity && c.rarity !== this.filters.rarity) return false;
      if (this.filters.pack && c.packId !== this.filters.pack) return false;
      if (q && !c.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  /* ---------------------------------------- */
  /*  Render                                  */
  /* ---------------------------------------- */

  async _prepareContext() {
    return {};
  }

  async _renderHTML() {
    const adapter = systemAdapter();
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
              <button type="button" class="wol-b-ghost" data-action="rollWheel"
                data-tooltip="${t("Builder.RollWheelHint")}">
                <i class="fa-solid fa-dice"></i> ${t("Builder.RollWheel")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="fill"
                data-tooltip="${t("Builder.FillHint")}">
                <i class="fa-solid fa-wand-sparkles"></i> ${t("Builder.Fill")}
              </button>
              <button type="button" class="wol-b-ghost" data-action="clearWheel">
                <i class="fa-solid fa-trash-can"></i> ${t("Builder.Clear")}
              </button>
            </div>
          </header>
          <div class="wol-b-coinbar">
            <p class="wol-b-hint">${t("Builder.DropHint")}</p>
            <div class="wol-b-coin">
              <select name="coin">
                ${COIN_PRESETS.map(v => `<option value="${v}">${v} gp</option>`).join("")}
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
    fill("pack", cataloguePacks().map(p => ({value: p.id, label: p.label})),
      this.filters.pack, t("Builder.AllPacks"));

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
      const input = ev.target.closest("input[data-weight]");
      if (!input) return;
      const index = Number(input.closest("li").dataset.index);
      this.entries[index].weight = Math.max(1, Math.round(Number(input.value) || 1));
      this.#markDirty(content);
      this.#renderTally(content);
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
      weight,
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
        <img src="${c.img || "icons/svg/item-bag.svg"}" alt="">
        <span class="nm">${foundry.utils.escapeHTML(c.name)}</span>
        <span class="src" data-tooltip="${foundry.utils.escapeHTML(c.packLabel)}">${
          foundry.utils.escapeHTML(c.source || "—")}</span>
        ${c.variants > 1 ? `<span class="var${c.likelyDuplicate ? " dup" : ""}"
          data-tooltip="${c.likelyDuplicate ? t("Builder.LikelyDuplicate") : t("Builder.Variants", {n: c.variants})}"
          >${c.variants}&times;</span>` : `<span class="var"></span>`}
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

    content.querySelector("[data-role=catcount]").textContent = rows.length > CATALOGUE_CAP
      ? t("Builder.ShowingCapped", {cap: CATALOGUE_CAP, total: rows.length})
      : t("Builder.ShowingAll", {n: rows.length});
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
      <li class="wol-b-row entry${e.isCoin ? " coin" : ""}${e.missing ? " missing" : ""}${clash ? " clash" : ""}"
        data-index="${i}">
        <img src="${e.img || "icons/svg/item-bag.svg"}" alt="">
        <span class="nm">${e.missing ? `<i class="fa-solid fa-triangle-exclamation" data-tooltip="${
          t("Builder.MissingItem")}"></i> ` : ""}${clash ? `<i class="fa-solid fa-clone" data-tooltip="${
          t("Builder.NameClash")}"></i> ` : ""}${foundry.utils.escapeHTML(e.name)}</span>
        ${e.uuid ? `<span class="src" data-tooltip="${t("Builder.SourceBook")}">${
          foundry.utils.escapeHTML(e.source || "—")}</span>` : `<span class="src"></span>`}
        ${adapter.tracksUses ? (e.uuid
          ? `<span class="use u-${e.profile ?? "single"}" data-tooltip="${t(use.key)}">${use.tag}</span>`
          : `<span class="use"></span>`) : ""}
        ${e.rarity ? `<span class="rar r-${e.rarity}">${adapter.rarityLabel(e.rarity)}</span>` : `<span class="rar"></span>`}
        <span class="slots">
          <button type="button" data-action="bump" data-index="${i}" data-delta="-1"><i class="fa-solid fa-minus"></i></button>
          <input type="number" min="1" step="1" value="${e.weight}" data-weight aria-label="${t("Builder.Slots")}">
          <button type="button" data-action="bump" data-index="${i}" data-delta="1"><i class="fa-solid fa-plus"></i></button>
        </span>
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
    const name = `${amount} gp`;
    if (this.entries.some(e => e.name === name)) {
      ui.notifications.info(t("Notify.CoinOnWheel", {name}));
      return;
    }
    this.entries.push({
      uuid: null,
      name,
      img: "icons/commodities/currency/coin-engraved-jolly-roger-gold.webp",
      weight: 1,
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

    const facts = [
      [t("Builder.Fact.Source"), s.source?.book || s.source?.custom || "—"],
      [t("Builder.Fact.Pack"), doc.compendium?.metadata?.label ?? t("Catalogue.WorldItems")],
      [t("Builder.Fact.Rarity"), adapter.rarityOf(doc) ? adapter.rarityLabel(adapter.rarityOf(doc)) : "—"],
      [t("Builder.Fact.Price"), s.price?.value != null ? `${s.price.value} ${s.price.denomination ?? "gp"}` : "—"],
      [t("Builder.Fact.Uses"), uses.max ? `${uses.max}${recovery ? ` (${recovery})` : ""}` : t("Use.Single")],
      [t("Builder.Fact.Type"), s.type?.value || doc.type]
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

  static #onClearFilters(event, target) {
    this.filters = {search: "", pack: "", type: "", rarity: "", hideUsed: true, singleUse: false};
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
      const base = {name: e.name, img: e.img, weight: e.weight, range};
      return e.uuid
        ? {...base, type: CONST.TABLE_RESULT_TYPES.DOCUMENT, documentUuid: e.uuid}
        : {...base, type: CONST.TABLE_RESULT_TYPES.TEXT, description: e.name};
    });

    try {
      const existing = this.table.results.map(r => r.id);
      if (existing.length) await this.table.deleteEmbeddedDocuments("TableResult", existing);
      await this.table.createEmbeddedDocuments("TableResult", results);
      await this.table.update({formula: `1d${cursor - 1}`});
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
