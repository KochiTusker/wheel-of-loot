/**
 * The GM's launcher: pick a table, hand out spins, put the wheel on everyone's
 * screen.
 *
 * Allocation and presentation live in one dialog because they are one decision
 * in practice — "Azaroth gets a spin on the loot wheel" — and splitting them
 * would mean two trips through the UI every time.
 */

import {slotCount, validateTable} from "../core/wheel-data.js";
import {t} from "../core/constants.js";

/** Players who can actually click a button right now, connected ones first. */
function candidateUsers() {
  return game.users
    .filter(u => !u.isGM)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

function tableOptions(selected = null) {
  return game.tables.contents
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(table => {
      const slots = slotCount(table);
      const broken = validateTable(table).length > 0;
      const label = `${table.name} — ${t("Launcher.NSlots", {n: slots || "?"})}${broken ? " ⚠" : ""}`;
      return `<option value="${table.uuid}"${table.uuid === selected ? " selected" : ""}>${
        foundry.utils.escapeHTML(label)}</option>`;
    })
    .join("");
}

/**
 * Ask the GM to choose a table.
 *
 * @param {string} title   Dialog title.
 * @param {string} label   Confirm button label.
 * @returns {Promise<RollTable|null>}
 */
export async function pickTable(title, label) {
  if (!game.tables.size) {
    ui.notifications.warn(t("Notify.NoTables"));
    return null;
  }
  const result = await foundry.applications.api.DialogV2.wait({
    window: {title, icon: "fa-solid fa-table-list"},
    classes: ["wol-dialog"],
    content: `<div class="wol-form">
        <div class="form-group">
          <label for="wol-pick">${t("Launcher.Table")}</label>
          <select id="wol-pick" name="table">${tableOptions()}</select>
        </div>
      </div>`,
    position: {width: 440},
    buttons: [
      {
        action: "ok",
        label,
        icon: "fa-solid fa-check",
        default: true,
        callback: (event, button) => button.form.elements.table.value
      },
      {action: "cancel", label: t("Cancel"), icon: "fa-solid fa-xmark"}
    ],
    rejectClose: false
  });
  if (!result || result === "cancel") return null;
  return fromUuid(result);
}

/**
 * Open the launcher. GM only.
 *
 * @param {object} api
 * @param {(options: object) => Promise<string|null>} api.present   Presenter.
 * @param {() => Record<string, number>} api.getCredits             Ledger reader.
 * @param {(allocations: object) => Promise<any>} api.grant         Ledger writer.
 * @param {() => Promise<RollTable|null>} api.createTable           New-wheel flow.
 */
export async function openLauncher({present, getCredits, grant, createTable}) {
  if (!game.user.isGM) return;

  // With no tables at all, the only useful thing to offer is making one — so
  // skip the launcher entirely rather than showing an empty dropdown.
  if (!game.tables.size) {
    const make = await foundry.applications.api.DialogV2.confirm({
      window: {title: t("Launcher.Title")},
      content: `<p>${t("Launcher.NoTablesYet")}</p>`,
      modal: true
    });
    if (make) await createTable();
    return;
  }

  const users = candidateUsers();
  if (!users.length) {
    ui.notifications.warn(t("Notify.NoPlayers"));
    return;
  }

  const esc = foundry.utils.escapeHTML;
  const ledger = getCredits();
  const rows = users.map(u => `
    <li class="wol-alloc-row${u.active ? "" : " offline"}">
      <span class="dot" style="background:${u.color?.css ?? u.color ?? "#888"}"></span>
      <span class="nm">${esc(u.name)}</span>
      <span class="ch">${u.character ? esc(u.character.name) : `<em>${t("Launcher.NoCharacter")}</em>`}</span>
      <span class="st">${u.active ? "" : t("Launcher.Offline")}</span>
      <input type="number" min="0" step="1" name="spins.${u.id}" value="${ledger[u.id] ?? 0}"
        aria-label="${t("Launcher.SpinsFor", {name: esc(u.name)})}">
    </li>`).join("");

  const content = `
    <div class="wol-form">
      <div class="form-group">
        <label for="wol-table">${t("Launcher.Table")}</label>
        <select id="wol-table" name="table">${tableOptions()}</select>
      </div>
      <h4 class="wol-alloc-head">${t("Launcher.Spins")}</h4>
      <p class="hint">${t("Launcher.SpinsHint")}</p>
      <ol class="wol-alloc">${rows}</ol>
      <p class="notes">${t("Launcher.Notes")}</p>
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: {title: t("Launcher.Title"), icon: "fa-solid fa-arrows-spin"},
    classes: ["wol-dialog"],
    content,
    position: {width: 580},
    buttons: [
      {
        action: "present",
        label: t("Launcher.Present"),
        icon: "fa-solid fa-tv",
        default: true,
        callback: (event, button) => ({...collect(button.form), mode: "present"})
      },
      {
        action: "grant",
        label: t("Launcher.GrantOnly"),
        icon: "fa-solid fa-ticket",
        callback: (event, button) => ({...collect(button.form), mode: "grant"})
      },
      {
        action: "build",
        label: t("Launcher.Build"),
        icon: "fa-solid fa-sliders",
        callback: (event, button) => ({...collect(button.form), mode: "build"})
      },
      {action: "cancel", label: t("Cancel"), icon: "fa-solid fa-xmark"}
    ],
    rejectClose: false
  });

  if (!result || result === "cancel") return;

  switch (result.mode) {
    case "present":
      await present({table: result.table, allocations: result.allocations});
      break;
    case "grant": {
      await grant(result.allocations);
      const total = Object.values(result.allocations).reduce((a, n) => a + n, 0);
      ui.notifications.info(t("Notify.LedgerUpdated", {n: total}));
      break;
    }
    case "build": {
      const {WheelBuilder} = await import("./wheel-builder.js");
      const table = await fromUuid(result.table);
      if (table) await WheelBuilder.open(table);
      break;
    }
  }
}

/** Read the allocation inputs off the dialog form. */
function collect(form) {
  const allocations = {};
  for (const el of form.elements) {
    if (!el.name?.startsWith("spins.")) continue;
    allocations[el.name.slice(6)] = Math.max(0, Math.floor(Number(el.value) || 0));
  }
  return {table: form.elements.table.value, allocations};
}
