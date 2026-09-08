/**
 * The wheel manager: every wheel in the world, and what you can do to one.
 *
 * The launcher answers "spin which wheel tonight". This answers the questions
 * around that — what have I got, which one is broken, which has been looted
 * dry, make me another like that one, delete the experiment I abandoned. They
 * are separate jobs and cramming them into the launcher's dropdown made both
 * worse.
 *
 * Each row draws the actual wheel it describes, at thumbnail size, from the
 * same code that draws the real one. A list of names tells a GM nothing about
 * which of their four hoards is which; a picture does it instantly.
 */

import {t} from "../core/constants.js";
import {duplicateWheel, isWheel, listWheels, restock} from "../core/wheels.js";
import {buildEntries, describeFault, disperseSlots, sliceColours} from "../core/wheel-data.js";
import {palette} from "../core/settings.js";

const {ApplicationV2, DialogV2} = foundry.applications.api;

/** Thumbnails are decorative; past this many slices they are a grey disc. */
const THUMB_SLICES = 48;

export class WheelManager extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "wheel-of-loot-manager",
    classes: ["wol-manager"],
    tag: "div",
    window: {
      title: "WHEELOFLOOT.Manager.Title",
      icon: "fa-solid fa-arrows-spin",
      resizable: true
    },
    position: {width: 720, height: 620},
    actions: {
      create: WheelManager.#onCreate,
      build: WheelManager.#onBuild,
      present: WheelManager.#onPresent,
      duplicate: WheelManager.#onDuplicate,
      rename: WheelManager.#onRename,
      remove: WheelManager.#onDelete,
      restock: WheelManager.#onRestock,
      look: WheelManager.#onLook
    }
  };

  /** @type {WheelManager|null} */
  static current = null;

  constructor(options = {}) {
    super(options);
    this.api = options.api ?? {};
  }

  async _prepareContext() {
    return {};
  }

  /* ---------------------------------------- */
  /*  Render                                  */
  /* ---------------------------------------- */

  async _renderHTML() {
    const esc = foundry.utils.escapeHTML;
    const wheels = listWheels();
    const root = document.createElement("div");
    root.className = "wol-manager-body";

    const rows = await Promise.all(wheels.map(async w => {
      const tags = [
        w.broken ? `<span class="tag bad" data-tooltip="${esc(describeFault(w.faults[0]))}">
          <i class="fa-solid fa-triangle-exclamation"></i> ${t("Manager.Broken")}</span>` : "",
        w.exhausted ? `<span class="tag spent">${t("Manager.Exhausted")}</span>` : "",
        w.customised ? `<span class="tag own">${t("Manager.Customised")}</span>` : "",
        w.limited ? `<span class="tag limited">${t("Manager.Limited", {n: w.limited})}</span>` : ""
      ].filter(Boolean).join("");

      return `
        <li class="wol-m-row" data-uuid="${esc(w.uuid)}">
          <div class="thumb">${await this.#thumbnail(w.table)}</div>
          <div class="about">
            <p class="name">${esc(w.name)}</p>
            <p class="meta">${w.folder ? `${esc(w.folder)} · ` : ""}${
              t("Manager.Meta", {wedges: w.wedges, slots: w.slots})}</p>
            <p class="tags">${tags}</p>
          </div>
          <div class="acts">
            <button type="button" data-action="present" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Present")}"${w.broken || w.exhausted ? " disabled" : ""}>
              <i class="fa-solid fa-tv"></i></button>
            <button type="button" data-action="build" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Build")}"><i class="fa-solid fa-sliders"></i></button>
            <button type="button" data-action="look" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Look")}"><i class="fa-solid fa-palette"></i></button>
            <button type="button" data-action="restock" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Restock")}"${w.limited ? "" : " disabled"}>
              <i class="fa-solid fa-boxes-stacked"></i></button>
            <button type="button" data-action="duplicate" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Duplicate")}"><i class="fa-solid fa-clone"></i></button>
            <button type="button" data-action="rename" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Rename")}"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="rm" data-action="remove" data-uuid="${esc(w.uuid)}"
              data-tooltip="${t("Manager.Delete")}"><i class="fa-solid fa-trash-can"></i></button>
          </div>
        </li>`;
    }));

    root.innerHTML = `
      <header class="wol-m-head">
        <p class="hint">${wheels.length
          ? t("Manager.Count", {n: wheels.length})
          : t("Manager.Empty")}</p>
        <button type="button" class="wol-b-save" data-action="create">
          <i class="fa-solid fa-circle-plus"></i> ${t("Manager.New")}
        </button>
      </header>
      <ol class="wol-m-list">${rows.join("")}</ol>`;
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    WheelManager.current = this;
  }

  /** @inheritDoc */
  async close(options) {
    if (WheelManager.current === this) WheelManager.current = null;
    return super.close(options);
  }

  /**
   * A small picture of the actual wheel.
   *
   * Drawn from the same slice colouring the real wheel uses, so a GM
   * recognises it. Labels are omitted — at this size they would be noise — and
   * a very busy wheel is drawn as plain bands rather than hundreds of paths.
   */
  async #thumbnail(table) {
    let entries;
    try {
      ({entries} = await buildEntries(table));
    } catch {
      entries = [];
    }
    if (!entries.length) return `<div class="empty"><i class="fa-solid fa-circle-question"></i></div>`;

    const total = entries.reduce((a, e) => a + e.count, 0);
    if (!total) return `<div class="empty"><i class="fa-solid fa-circle-question"></i></div>`;

    const shown = Math.min(total, THUMB_SLICES);
    const layout = disperseSlots(entries, total, 7).slice(0, shown);
    const colours = sliceColours(shown, palette(table));
    const sweep = 360 / shown;
    const r = 26;
    const c = 30;

    const wedges = layout.map((entryIndex, i) => {
      const a0 = (i * sweep - 90) * Math.PI / 180;
      const a1 = ((i + 1) * sweep - 90) * Math.PI / 180;
      const large = sweep > 180 ? 1 : 0;
      const x0 = c + r * Math.cos(a0);
      const y0 = c + r * Math.sin(a0);
      const x1 = c + r * Math.cos(a1);
      const y1 = c + r * Math.sin(a1);
      const spent = entries[entryIndex]?.depleted ? ` opacity="0.3"` : "";
      return `<path d="M ${c} ${c} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${
        x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="${colours[i]}"${spent} />`;
    }).join("");

    return `<svg viewBox="0 0 60 60" role="img" aria-label="">
      ${wedges}<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#0b0a08" stroke-width="2"/>
      <circle cx="${c}" cy="${c}" r="7" fill="#14100c" stroke="#f2c14e" stroke-width="1.5"/>
    </svg>`;
  }

  /* ---------------------------------------- */
  /*  Actions                                 */
  /* ---------------------------------------- */

  /** The table a row's button refers to, or null if it has gone. */
  static async #tableFor(target) {
    const table = await fromUuid(target.dataset.uuid);
    if (!table) {
      ui.notifications.warn(t("Manager.Gone"));
      WheelManager.current?.render();
      return null;
    }
    return table;
  }

  static async #onCreate() {
    const table = await this.api.createTable?.();
    if (table) this.render();
  }

  static async #onBuild(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (table) await this.api.build?.(table);
  }

  static async #onPresent(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (!table) return;
    // The launcher is where spins are handed out, and presenting without
    // granting any would put a wheel nobody can turn on every screen.
    await this.api.launch?.(table);
  }

  static async #onLook(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (!table) return;
    const {WheelSettings} = await import("./settings-menu.js");
    new WheelSettings({wheel: table}).render({force: true});
  }

  static async #onDuplicate(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (!table) return;
    try {
      const copy = await duplicateWheel(table);
      ui.notifications.info(t("Manager.Duplicated", {name: copy.name}));
      this.render();
    } catch (err) {
      console.error("Wheel of Loot | could not duplicate the wheel", err);
      ui.notifications.error(t("Manager.DuplicateFailed"));
    }
  }

  static async #onRename(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (!table) return;
    const name = await DialogV2.prompt({
      window: {title: t("Manager.Rename")},
      content: `<div class="wol-form"><div class="form-group">
          <label for="wol-m-name">${t("Manager.NewName")}</label>
          <input type="text" id="wol-m-name" name="name" value="${foundry.utils.escapeHTML(table.name)}">
        </div></div>`,
      ok: {label: t("Manager.Save"), callback: (e, b) => b.form.elements.name.value.trim()},
      rejectClose: false
    });
    if (!name) return;
    await table.update({name});
    this.render();
  }

  static async #onDelete(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (!table) return;
    // Deleting a table is not recoverable from inside the module, so the
    // confirmation names what is going and says plainly that it is permanent.
    const ok = await DialogV2.confirm({
      window: {title: t("Manager.DeleteTitle")},
      content: `<p>${t("Manager.DeleteBody", {name: foundry.utils.escapeHTML(table.name)})}</p>
                <p class="notes">${t("Manager.DeleteNote")}</p>`,
      modal: true
    });
    if (!ok) return;
    try {
      await table.delete();
      this.render();
    } catch (err) {
      console.error("Wheel of Loot | could not delete the wheel", err);
      ui.notifications.error(t("Manager.DeleteFailed"));
    }
  }

  static async #onRestock(event, target) {
    const table = await WheelManager.#tableFor(target);
    if (!table) return;
    const answer = await DialogV2.wait({
      window: {title: t("Manager.RestockTitle"), icon: "fa-solid fa-boxes-stacked"},
      content: `<div class="wol-form">
          <p class="hint">${t("Manager.RestockBody", {name: foundry.utils.escapeHTML(table.name)})}</p>
          <div class="form-group">
            <label for="wol-m-stock">${t("Manager.RestockTo")}</label>
            <input type="number" id="wol-m-stock" name="stock" min="0" step="1" value="1">
          </div>
          <p class="notes">${t("Manager.RestockNote")}</p>
        </div>`,
      buttons: [
        {action: "set", label: t("Manager.Restock"), default: true,
         callback: (e, b) => ({to: Math.max(0, Math.floor(Number(b.form.elements.stock.value) || 0))})},
        {action: "endless", label: t("Manager.MakeEndless"), callback: () => ({to: null})},
        {action: "cancel", label: t("Cancel")}
      ],
      rejectClose: false,
      modal: true
    });
    if (!answer || answer === "cancel") return;
    const n = await restock(table, answer.to);
    ui.notifications.info(t("Manager.Restocked", {n, name: table.name}));
    this.render();
  }

  /* ---------------------------------------- */
  /*  Entry point                             */
  /* ---------------------------------------- */

  static open(api) {
    if (!game.user.isGM) return null;
    const app = WheelManager.current ?? new WheelManager({api});
    app.api = api;
    return app.render({force: true});
  }

  /** Redraw if open — a wheel changed underneath the list. */
  static refresh() {
    if (WheelManager.current?.rendered) WheelManager.current.render();
  }
}

/** Re-exported so main.js can mark saved tables without importing two modules. */
export {isWheel};
