/**
 * The GM's launcher: pick a table, hand out spins, put the wheel on everyone's
 * screen.
 *
 * Allocation and presentation live in one dialog because they are one decision
 * in practice — "give the winner a spin on the loot wheel" — and splitting them
 * would mean two trips through the UI every time.
 *
 * Since the module has exactly one entry point in the sidebar, this is also the
 * hub: everything else it can do is reachable from here.
 */

import {slotCount, validateTable} from "../core/wheel-data.js";
import {t} from "../core/constants.js";
import {wheelOverrides} from "../core/settings.js";
import {isWheel} from "../core/wheels.js";

/** Players who can actually click a button right now, connected ones first. */
function candidateUsers() {
  return game.users
    .filter(u => !u.isGM)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/**
 * The tables worth offering as wheels.
 *
 * A world of encounter tables, treasure tables and name generators should not
 * present all of them here. Anything the module has saved says so explicitly,
 * and anything with slot ranges counts anyway — but if that leaves nothing,
 * fall back to every table rather than an empty dropdown, because a GM who has
 * built a wheel by hand should still be able to reach it.
 */
function wheelTables() {
  const wheels = game.tables.contents.filter(isWheel);
  return wheels.length ? wheels : game.tables.contents;
}

function tableOptions(selected = null) {
  return wheelTables()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(table => {
      const slots = slotCount(table);
      const broken = validateTable(table).length > 0;
      // A wheel with a look of its own is worth knowing about before presenting it.
      const custom = Object.keys(wheelOverrides(table)).length ? " ✦" : "";
      const label = `${table.name} — ${t("Launcher.NSlots", {n: slots || "?"})}${custom}${broken ? " ⚠" : ""}`;
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
 * @param {(table: RollTable) => Promise<any>} api.build            Builder opener.
 */
export async function openLauncher({present, getCredits, grant, createTable, build, table = null}) {
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
        <div class="wol-table-pick">
          <select id="wol-table" name="table">${tableOptions(table?.uuid ?? null)}</select>
          <button type="button" class="wol-b-ghost" data-role="newwheel"
            data-tooltip="${t("Launcher.NewHint")}">
            <i class="fa-solid fa-circle-plus"></i> ${t("Launcher.New")}
          </button>
        </div>
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
    // Creating a wheel is not one of the three things this dialog decides
    // between, so it sits beside the picker it affects rather than in the
    // footer competing with them.
    render: (event, dialog) => {
      dialog.element.querySelector("[data-role=newwheel]")?.addEventListener("click", async () => {
        dialog.close();
        await createTable();
      });
    },
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
    case "build":
      await build(result.table);
      break;
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
