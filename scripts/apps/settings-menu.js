/**
 * The settings form.
 *
 * Foundry's own module settings list is a flat column, which is fine for three
 * options and unreadable for eighteen. Grouping them into tabs is the
 * difference between "a wall of switches" and "somewhere to make this wheel
 * mine", which is the whole point of having the knobs at all.
 *
 * The palette gets a live preview because choosing colours from six hex codes
 * in a text field is guesswork, and a wheel is a thing you look at.
 */

import {MODULE_ID, t} from "../core/constants.js";
import {nameIconButtons} from "./a11y.js";
import {
  OVERRIDABLE, PALETTES, S, THEMES, parseNumberList, parsePalette,
  saveWheelOverrides, wheelOverrides
} from "../core/settings.js";
import {MAX_SLOTS, MIN_SLOTS, SLOT_PRESETS, sliceColours} from "../core/wheel-data.js";

const {ApplicationV2} = foundry.applications.api;

const TABS = ["appearance", "spin", "rules", "builder"];

/** Foundry has moved FilePicker more than once; find whichever exists. */
function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

export class WheelSettings extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "wheel-of-loot-settings",
    classes: ["wol-settings"],
    tag: "form",
    window: {
      title: "WHEELOFLOOT.Setting.MenuName",
      icon: "fa-solid fa-sliders",
      resizable: true
    },
    position: {width: 620, height: 640},
    actions: {
      switchTab: WheelSettings.#onTab,
      save: WheelSettings.#onSave,
      reset: WheelSettings.#onReset,
      pickFile: WheelSettings.#onPickFile,
      preview: WheelSettings.#onPreview
    }
  };

  /**
   * @param {object} [options]
   * @param {RollTable} [options.wheel]  Scope the form to one wheel rather than
   *                                     the world. Fields left blank defer to
   *                                     the world setting.
   */
  constructor(options = {}) {
    super(options);
    this.tab = "appearance";
    this.wheel = options.wheel ?? null;
  }

  /** True when this form is editing one wheel rather than the house style. */
  get scoped() {
    return !!this.wheel;
  }

  get title() {
    return this.scoped
      ? t("Setting.WheelTitle", {name: this.wheel.name})
      : t("Setting.MenuName");
  }

  /**
   * Current values, read once so the form edits a snapshot.
   *
   * Scoped to a wheel, a field holds only what that wheel overrides — blank
   * means "whatever the world says", which is what the placeholder shows.
   */
  #read() {
    if (this.scoped) {
      const overrides = wheelOverrides(this.wheel);
      return Object.fromEntries(OVERRIDABLE.map(key => [key, overrides[key] ?? ""]));
    }
    const get = key => game.settings.get(MODULE_ID, key);
    return Object.fromEntries(Object.entries(S)
      .filter(([name]) => !["CREDITS", "MIGRATED", "LAST_GRANT"].includes(name))
      .map(([, key]) => [key, get(key)]));
  }

  /**
   * What the world setting says, phrased for a placeholder.
   *
   * A blank field means "whatever the world says", and a GM should not have to
   * open the other form to find out what that is.
   */
  #globalPlaceholder(key) {
    let value;
    try { value = game.settings.get(MODULE_ID, key); } catch { return ""; }
    if (value === true) return t("Setting.On");
    if (value === false) return t("Setting.Off");
    if (value === "" || value === null || value === undefined) return t("Setting.Nothing");
    return String(value);
  }

  async _prepareContext() {
    return {};
  }

  /* ---------------------------------------- */
  /*  Render                                  */
  /* ---------------------------------------- */

  async _renderHTML() {
    const v = this.#read();
    const esc = foundry.utils.escapeHTML;
    const root = document.createElement("div");
    root.className = "wol-settings-body";

    // A checkbox has two states and a scoped field needs three, so scoped it
    // becomes a select: defer, on, or off.
    const check = (key, label, hint) => {
      if (this.scoped) {
        return select(key, label, [
          {value: "true", label: t("Setting.On")},
          {value: "false", label: t("Setting.Off")}
        ], hint);
      }
      return `
      <div class="wol-set-row">
        <label class="wol-set-check">
          <input type="checkbox" name="${key}" ${v[key] ? "checked" : ""}>
          <span>${t(label)}</span>
        </label>
        ${hint ? `<p class="notes">${t(hint)}</p>` : ""}
      </div>`;
    };

    const text = (key, label, hint, {picker = null, placeholder = ""} = {}) => `
      <div class="wol-set-row">
        <label for="wol-${key}">${t(label)}</label>
        <div class="wol-set-input">
          <input type="text" id="wol-${key}" name="${key}" value="${esc(String(v[key] ?? ""))}"
            placeholder="${esc(this.scoped ? this.#globalPlaceholder(key) : placeholder)}">
          ${picker ? `<button type="button" class="wol-b-ghost" data-action="pickFile"
            data-target="${key}" data-filetype="${picker}" data-tooltip="${t("Setting.Browse")}">
            <i class="fa-solid fa-folder-open"></i></button>` : ""}
        </div>
        ${hint ? `<p class="notes">${t(hint)}</p>` : ""}
      </div>`;

    const number = (key, label, hint, {min, max, step = 1}) => `
      <div class="wol-set-row">
        <label for="wol-${key}">${t(label)}</label>
        <input type="number" id="wol-${key}" name="${key}"
          value="${v[key] === "" ? "" : Number(v[key])}"
          placeholder="${esc(this.scoped ? this.#globalPlaceholder(key) : "")}"
          min="${min}" max="${max}" step="${step}">
        ${hint ? `<p class="notes">${t(hint)}</p>` : ""}
      </div>`;

    const select = (key, label, options, hint) => {
      // Scoped, the first option is always "leave this to the world setting".
      const all = this.scoped
        ? [{value: "", label: t("Setting.UseGlobal", {value: this.#globalPlaceholder(key)})}, ...options]
        : options;
      return `
      <div class="wol-set-row">
        <label for="wol-${key}">${t(label)}</label>
        <select id="wol-${key}" name="${key}">
          ${all.map(o => `<option value="${esc(o.value)}"${
            String(o.value) === String(v[key]) ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
        </select>
        ${hint ? `<p class="notes">${t(hint)}</p>` : ""}
      </div>`;
    };

    root.innerHTML = `
      <nav class="wol-set-tabs">
        ${TABS.filter(tab => !(this.scoped && tab === "builder"))
          .map(tab => `<button type="button" data-action="switchTab" data-tab="${tab}"
            class="${tab === this.tab ? "active" : ""}">${t(`Setting.Tab.${tab}`)}</button>`).join("")}
      </nav>

      <section class="wol-set-page" data-tab="appearance">
        ${select(S.THEME, "Setting.Theme", [
          ...Object.keys(THEMES).map(k => ({value: k, label: t(`Theme.${k}`)})),
          {value: "custom", label: t("Theme.custom")}
        ], "Setting.ThemeHint")}
        ${select(S.PALETTE, "Setting.Palette", [
          ...Object.keys(PALETTES).map(k => ({value: k, label: t(`Palette.${k}`)})),
          {value: "custom", label: t("Palette.custom")}
        ], "Setting.PaletteHint")}
        <div class="wol-set-row" data-role="customrow">
          <label for="wol-${S.PALETTE_CUSTOM}">${t("Setting.PaletteCustom")}</label>
          <input type="text" id="wol-${S.PALETTE_CUSTOM}" name="${S.PALETTE_CUSTOM}"
            value="${esc(String(v[S.PALETTE_CUSTOM] ?? ""))}" placeholder="#C1272D, #F4EAD2, #1F3A93">
          <p class="notes">${t("Setting.PaletteCustomHint")}</p>
        </div>
        <div class="wol-set-preview" data-role="preview"></div>
        <div class="wol-set-row">
          <button type="button" class="wol-b-ghost" data-action="preview">
            <i class="fa-solid fa-eye"></i> ${t("Setting.PreviewWheel")}
          </button>
          <p class="notes">${t("Setting.PreviewWheelHint")}</p>
        </div>
        ${text(S.HUB_ICON, "Setting.HubIcon", "Setting.HubIconHint", {picker: "image"})}
        ${text(S.WHEEL_SPEAKER, "Setting.Speaker", "Setting.SpeakerHint", {placeholder: t("Card.Speaker")})}
        ${check(S.CONFETTI, "Setting.Confetti", "Setting.ConfettiHint")}
        ${number(S.BACKDROP, "Setting.Backdrop", "Setting.BackdropHint", {min: 0, max: 1, step: 0.05})}
        ${select(S.REDUCE_MOTION, "Setting.ReduceMotion", [
          {value: "auto", label: t("Motion.auto")},
          {value: "always", label: t("Motion.always")},
          {value: "never", label: t("Motion.never")}
        ], "Setting.ReduceMotionHint")}
      </section>

      <section class="wol-set-page" data-tab="spin" hidden>
        ${number(S.SPIN_SECONDS, "Setting.SpinSeconds", "Setting.SpinSecondsHint", {min: 2, max: 20, step: 0.5})}
        ${number(S.SPIN_TURNS, "Setting.SpinTurns", "Setting.SpinTurnsHint", {min: 1, max: 20})}
        ${this.scoped ? "" : number(S.TICK_VOLUME, "Setting.TickVolume", "Setting.TickVolumeHint", {min: 0, max: 1, step: 0.05})}
        ${text(S.WIN_SOUND, "Setting.WinSound", "Setting.WinSoundHint", {picker: "audio"})}
      </section>

      <section class="wol-set-page" data-tab="rules" hidden>
        ${check(S.ALLOW_GIFT, "Setting.AllowGift", "Setting.AllowGiftHint")}
        ${check(S.ALLOW_REFUSE, "Setting.AllowRefuse", "Setting.AllowRefuseHint")}
        ${check(S.GM_NEEDS_CREDIT, "Setting.GMNeedsCredit", "Setting.GMNeedsCreditHint")}
        ${check(S.AUTO_CLOSE, "Setting.AutoClose", "Setting.AutoCloseHint")}
        ${select(S.CHAT_CARD, "Setting.ChatCard", [
          {value: "public", label: t("ChatCard.public")},
          {value: "gm", label: t("ChatCard.gm")},
          {value: "none", label: t("ChatCard.none")}
        ], "Setting.ChatCardHint")}
      </section>

      <section class="wol-set-page" data-tab="builder"${this.scoped ? " hidden data-unavailable" : ""} hidden>
        ${select(S.DEFAULT_SLOTS, "Setting.DefaultSlots",
          SLOT_PRESETS.map(n => ({value: n, label: t("Builder.NSlices", {n})})), "Setting.DefaultSlotsHint")}
        ${text(S.COIN_PRESETS, "Setting.CoinPresets", "Setting.CoinPresetsHint")}
        ${text(S.COIN_DENOMINATION, "Setting.CoinDenomination", "Setting.CoinDenominationHint")}
        <div class="wol-set-row"><p class="notes" data-role="coinpreview"></p></div>
      </section>

      <footer class="wol-set-foot">
        <button type="button" class="wol-b-ghost" data-action="reset">
          <i class="fa-solid fa-rotate-left"></i> ${t("Setting.Reset")}
        </button>
        <button type="button" class="wol-b-save" data-action="save">
          <i class="fa-solid fa-floppy-disk"></i> ${t("Setting.Save")}
        </button>
      </footer>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    this.#hydrate(content);
    nameIconButtons(content);
  }

  #hydrate(content) {
    // The palette preview and the coin line are the two places where what you
    // typed and what you get are not obviously the same thing, so both update
    // as you type rather than only on save.
    const refresh = () => {
      this.#renderPreview(content);
      this.#renderCoinPreview(content);
      this.#syncCustomRow(content);
    };

    content.addEventListener("change", ev => {
      const theme = ev.target.closest(`[name="${S.THEME}"]`);
      if (theme && theme.value !== "custom") this.#applyTheme(content, theme.value);
      // Touching a part the theme owns means the GM has diverged from it.
      else if (ev.target.matches(`[name="${S.PALETTE}"], [name="${S.HUB_ICON}"], [name="${S.PALETTE_CUSTOM}"]`)) {
        const select = content.querySelector(`[name="${S.THEME}"]`);
        if (select && !this.applyingTheme) select.value = "custom";
      }
      refresh();
    });
    content.addEventListener("input", refresh);
    refresh();
  }

  /**
   * Fill in the parts a theme stands for.
   *
   * The theme is a shortcut, not a layer: it writes the palette and hub and then
   * gets out of the way, so there is only ever one answer to "what colour is
   * this wheel" and it is the one in the palette setting.
   */
  #applyTheme(content, key) {
    const theme = THEMES[key];
    if (!theme) return;
    this.applyingTheme = true;
    const palette = content.querySelector(`[name="${S.PALETTE}"]`);
    const hub = content.querySelector(`[name="${S.HUB_ICON}"]`);
    if (palette) palette.value = theme.palette;
    if (hub) hub.value = theme.hub;
    this.applyingTheme = false;
  }

  /** The custom hex field is only meaningful when "Custom" is chosen. */
  #syncCustomRow(content) {
    const mode = content.querySelector(`[name="${S.PALETTE}"]`)?.value;
    const row = content.querySelector("[data-role=customrow]");
    if (row) row.hidden = mode !== "custom";
  }

  /** Which palette the form is currently describing, valid or not. */
  #livePalette(content) {
    const mode = content.querySelector(`[name="${S.PALETTE}"]`)?.value ?? "fairground";
    if (mode !== "custom") return {colours: PALETTES[mode] ?? PALETTES.fairground, valid: true};
    const custom = parsePalette(content.querySelector(`[name="${S.PALETTE_CUSTOM}"]`)?.value ?? "");
    // Fewer than two colours cannot alternate, so show what will actually be
    // used rather than a preview of something the wheel would refuse.
    if (custom.length < 2) return {colours: PALETTES.fairground, valid: false};
    return {colours: custom, valid: true};
  }

  #renderPreview(content) {
    const box = content.querySelector("[data-role=preview]");
    if (!box) return;
    const {colours, valid} = this.#livePalette(content);
    // Twenty slices is enough to show the alternation and the wrap seam without
    // the preview becoming a wheel in its own right.
    const slices = sliceColours(20, colours);
    box.innerHTML = `
      <div class="wol-set-swatches">
        ${slices.map(c => `<span style="background:${c}"></span>`).join("")}
      </div>
      <p class="notes">${valid ? t("Setting.PreviewOk", {n: colours.length}) : t("Setting.PreviewFallback")}</p>`;
  }

  #renderCoinPreview(content) {
    const box = content.querySelector("[data-role=coinpreview]");
    if (!box) return;
    const list = parseNumberList(content.querySelector(`[name="${S.COIN_PRESETS}"]`)?.value ?? "");
    const denom = (content.querySelector(`[name="${S.COIN_DENOMINATION}"]`)?.value ?? "gp").trim() || "gp";
    box.textContent = list.length
      ? t("Setting.CoinPreview", {list: list.map(n => `${n} ${denom}`).join(", ")})
      : t("Setting.CoinPreviewEmpty");
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

  /**
   * Switch pane.
   *
   * The action is called `switchTab` rather than `tab` because ApplicationV2
   * reserves `tab`: its click dispatcher intercepts that name in a switch and
   * routes it to its own `_onClickTab`, which drives the framework tab-group
   * machinery, before it ever consults `options.actions`. A handler registered
   * under `tab` is therefore never called, and the panes silently do nothing.
   */
  static #onTab(event, target) {
    this.tab = target.dataset.tab;
    const root = this.element;
    root.querySelectorAll(".wol-set-tabs button").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === this.tab);
    });
    root.querySelectorAll(".wol-set-page").forEach(p => {
      p.hidden = p.dataset.tab !== this.tab;
    });
  }

  static async #onPickFile(event, target) {
    const field = this.element.querySelector(`[name="${target.dataset.target}"]`);
    const Picker = filePicker();
    if (!Picker || !field) return;
    new Picker({
      type: target.dataset.filetype,
      current: field.value,
      callback: path => {
        field.value = path;
        field.dispatchEvent(new Event("change", {bubbles: true}));
      }
    }).render(true);
  }

  /**
   * Put a real wheel on screen with the settings as they stand in the form.
   *
   * Swatches answer "what are these colours"; only a wheel answers "does this
   * look right". Local to this client and dismissed on click, so it can be
   * fired while players are connected without anyone else seeing it.
   */
  static async #onPreview(event, target) {
    const {LootWheel} = await import("./wheel-app.js");
    const {colours} = this.#livePalette(this.element);
    const hub = this.element.querySelector(`[name="${S.HUB_ICON}"]`)?.value
      || this.#globalPlaceholder(S.HUB_ICON)
      || "icons/svg/chest.svg";

    const names = [
      t("Setting.SampleGrand"), t("Setting.SampleCommon"), t("Setting.SampleCoin"),
      t("Setting.SampleRare"), t("Setting.SampleNothing")
    ];
    const inks = ["#b26a00", "#3f3f46", "#7a5c00", "#1155cc", "#a3341f"];
    const counts = [2, 8, 5, 3, 6];
    const entries = names.map((name, i) => ({
      name, count: counts[i], ink: inks[i], img: hub,
      rarity: null, isCoin: false, description: "", uuid: null, odds: 100
    }));

    const {disperseSlots} = await import("../core/wheel-data.js");
    const total = counts.reduce((a, b) => a + b, 0);
    const layout = disperseSlots(entries, total, 1234);

    LootWheel.preview({
      tableName: t("Setting.PreviewTitle"),
      entries, layout, palette: colours, hubIcon: hub
    });
  }

  static async #onSave(event, target) {
    const form = this.element;
    const writes = [];
    const keys = this.scoped ? OVERRIDABLE : Object.values(S);

    for (const key of keys) {
      if (["spinCredits", "migratedFrom", "lastGrant"].includes(key)) continue;
      const el = form.querySelector(`[name="${key}"]`);
      if (!el) continue;
      let value;
      if (el.type === "checkbox") value = el.checked;
      else if (el.type === "number") value = el.value === "" ? "" : Number(el.value);
      else value = el.value;
      // Scoped, a booleanish select carries strings; turn them back into the
      // types the accessors expect, and leave "" alone as "defer".
      if (this.scoped && (value === "true" || value === "false")) value = value === "true";
      writes.push([key, value]);
    }

    try {
      if (this.scoped) {
        await saveWheelOverrides(this.wheel, Object.fromEntries(writes));
        ui.notifications.info(t("Setting.WheelSaved", {name: this.wheel.name}));
        this.close();
        return;
      }
      for (const [key, value] of writes) await game.settings.set(MODULE_ID, key, value);
      ui.notifications.info(t("Setting.Saved"));
      // A wheel already on screen was drawn with the old palette and icon, so
      // say plainly that it will not change under the players' feet.
      if (game.modules.get(MODULE_ID)?.api && globalThis.document.querySelector(".wol-overlay")) {
        ui.notifications.info(t("Setting.AppliesNextWheel"));
      }
      this.close();
    } catch (err) {
      console.error("Wheel of Loot | could not save settings", err);
      ui.notifications.error(t("Setting.SaveFailed"));
    }
  }

  static async #onReset(event, target) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: {title: this.scoped ? t("Setting.ClearTitle") : t("Setting.ResetTitle")},
      content: `<p>${this.scoped ? t("Setting.ClearBody", {name: this.wheel.name}) : t("Setting.ResetBody")}</p>`,
      modal: true
    });
    if (!ok) return;

    // Scoped, resetting means dropping every override so the wheel follows the
    // house style again — never touching the world settings themselves.
    if (this.scoped) {
      await saveWheelOverrides(this.wheel, {});
      ui.notifications.info(t("Setting.Cleared", {name: this.wheel.name}));
      this.render();
      return;
    }
    for (const [name, key] of Object.entries(S)) {
      // The ledger is live game state, not a preference — resetting the look of
      // the wheel must never confiscate somebody's outstanding spin.
      if (["CREDITS", "MIGRATED", "LAST_GRANT"].includes(name)) continue;
      const config = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (config) await game.settings.set(MODULE_ID, key, config.default);
    }
    ui.notifications.info(t("Setting.ResetDone"));
    this.render();
  }
}

/** Exported for the test harness; keeps the clamp rules in one place. */
export const SLOT_BOUNDS = {min: MIN_SLOTS, max: MAX_SLOTS};
