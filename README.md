# Wheel of Loot

A broadcast prize wheel for Foundry VTT, driven by a RollTable.

The GM presents a wheel to the whole table and hands out spins. It opens on
**every** client at once, and everybody watches the same wheel land on the same
slice — the spin is genuinely synchronised, not each client animating its own.
The winner gets confetti and a keep / gift / refuse choice, and keeping it puts
the item straight onto their character sheet.

Comes with a builder: browse every Item in your world and compendiums, drag them
onto the wheel, choose how big the wheel is, and re-roll any prize you don't
like — or roll a whole wheel at once.

Works in any game system. Knows a little extra about D&D 5e.

---

## Requirements

- Foundry VTT v13 or v14
- [socketlib](https://github.com/manuelVo/foundryvtt-socketlib)

## Getting started

1. Enable the module. A single **Wheel of Loot** button appears in the
   **RollTables** sidebar, beside Create RollTable. Everything the module does
   is reached from there — it adds nothing to the scene controls.
2. Press it, then **New wheel** next to the table dropdown. Name it, pick a size.
3. In the builder, filter the item list on the left and either drag prizes over
   or press **Roll a wheel**.
4. **Save to table**, then reopen the launcher → give someone a spin →
   **Present to the table**.

A wheel is an ordinary RollTable, so you can also open the builder from the
table's own sheet header.

## The builder

**Everything classified as an Item** is available: every Item compendium, plus
your world's own Items directory — so homebrew and anything you have dragged out
of a pack shows up alongside the official content. Filter by name, type, rarity,
compendium and source book; expand any row to read what it actually does before
committing.

**Duplicates are handled properly.** A world with several imported books has the
same item in it many times over, and a browser that lists all eleven copies is
useless. Three modes, and the default is the middle one:

| Mode | What it does |
| --- | --- |
| **Show every copy** | No folding at all |
| **Hide exact duplicates** | Drops only the same printing listed twice in the same compendium — nothing is lost |
| **One row per item** *(default)* | One row per distinct name; the badge shows how many printings exist, and clicking it lists them so you can add a specific one |

The distinction matters: four "Dust of Dryness" entries across four books are
*not* interchangeable — the 2014 printing has one use, the SRD one has ten — so
variants are always collapsed into something you can expand, never discarded.
Only genuinely identical rows are hidden. This works off whatever your system
records, so it degrades sensibly in a world with no rarities or source books.

**Choose the wheel's size.** Presets from 12 to 96 slices, or any number from 2
to 120. Slice colouring, label length and type size all adapt, and the wheel
never puts two same-coloured slices side by side at any size.

**Roll instead of picking.**

| Control | What it does |
| --- | --- |
| **Roll a wheel** | Replaces everything with a random draw from whatever your filters show |
| **Fill the gaps** | Tops the wheel up to its size, leaving your own picks alone |
| 🎲 on a row | Swaps one prize for another, keeping its slot count so your odds survive |
| **Pad to N** | Absorbs any shortfall or excess into the wedge that already has the most slots |

**Weight by rarity** (where the system has rarities) gives commoner prizes more
of the wheel than rare ones, so a legendary stays a thrill rather than a coin
flip.

Nothing is written until **Save**, so experimenting is free.

## Every wheel can look and behave differently

The world settings are the house style; any individual wheel may disagree.
**This wheel’s look** in the builder opens the same form scoped to that wheel —
palette, hub, speaker, confetti, backdrop, spin timing, win sound, and the rules
for gifting, refusing, GM spins, auto-close and the result card.

A blank field means "follow the world setting", and the placeholder tells you
what that is, so a wheel only carries the handful of things it actually differs
on. The launcher marks a customised wheel with a ✦.

A Dragon’s Hoard in ember with a coin hub and a nine-second spin; a Cursed Vault
in midnight that whispers its results to the GM and does not let anyone refuse.

## Spins are a permission, not a role

The wheel opens for everybody; whether you can *turn* it depends only on whether
you hold a spin. Hand them out in the launcher, or from a macro:

```js
game.modules.get("wheel-of-loot").api.grant({[someUserId]: 2});
```

Each spin is spent on the GM's client *before* the roll happens, so a flood of
clicks can only ever spend what the ledger holds. The wheel closes itself once
every granted spin is used.

## Coin wedges

Currency is not an Item in any system, so it cannot be handed over the normal
way. Name a text result `250 gp` (or gold / sp / silver / cp / ep / pp, commas
allowed) and it is paid into the winner's purse instead. The builder's **Add
coin** button writes these for you.

## Other systems

Everything system-specific — what a rarity is, where a purse lives, whether an
item is single-use, who may receive a prize — sits behind one adapter interface
in [`scripts/systems/`](scripts/systems/). Systems without an adapter still work:
the generic fallback answers from documents alone, and the UI hides the controls
it cannot support rather than showing ones that would do nothing.

Adding a system is one file and one call. Another module can do it without this
one changing:

```js
import {registerSystemAdapter} from "/modules/wheel-of-loot/scripts/systems/adapter.js";

Hooks.once("init", () => registerSystemAdapter({
  id: "my-system",
  rarities: ["mundane", "fine", "masterwork"],
  rarityColour: key => ({mundane: "#3f3f46", fine: "#1a7f3c", masterwork: "#b26a00"})[key],
  rarityOf: source => foundry.utils.getProperty(source, "system.quality") ?? null
  // anything you leave out falls through to the generic adapter
}));
```

## API

```js
const wheel = game.modules.get("wheel-of-loot").api;   // also globalThis.wheelOfLoot

await wheel.present({table, allocations});  // put a wheel on every screen
await wheel.build(table);                   // open the builder
await wheel.createTable();                  // new table + builder
await wheel.grant({userId: 3});             // hand out spins
wheel.getCredits();                         // { userId: spinsRemaining }
```

## Settings

Spin duration, default wheel size and the tick sound sit directly in Foundry's
module settings. Everything else lives behind **Configure the wheel**, grouped
into four tabs.

| | Setting | Default |
| --- | --- | --- |
| **Appearance** | Slice colours — six themes or your own hex list, with a live preview | Fairground |
| | Hub image | `icons/svg/chest.svg` |
| | Chat card speaker | "The Wheel" |
| | Confetti on a win | on |
| **Spin** | Duration | 6s |
| | Full rotations | 6 |
| | Tick volume *(per client)* | 0.35 |
| | Win sound | none |
| **Rules** | Allow gifting | on |
| | Allow refusing | on |
| | The GM needs a spin too | off |
| | Close when the spins run out | on |
| | Result card — everyone / GM only / none | everyone |
| **Builder** | Default wheel size | 64 |
| | Coin amounts | 10 … 1000 |
| | Coin denomination | `gp` |

**Every default reproduces the module's pre-2.0 behaviour exactly**, so upgrading
changes nothing until you change something. That promise is pinned by a test.

A silver-standard campaign sets the denomination to `sp`; a horror game takes the
Midnight palette, turns off confetti and whispers the result card to the GM; a
table that wants every spin binding turns off refusing.

## Development

```bash
node test/run.mjs
```

Covers the parts that are pure arithmetic: slot distribution, the dispersion
that keeps repeated prizes apart, slice colouring at every wheel size, table
validation, and the generic adapter. Anything needing `game` or the DOM is out
of scope and has to be exercised in a live world.

The layout is worth understanding before changing anything:

| Directory | Holds |
| --- | --- |
| `scripts/core/` | Rules and arithmetic — layout, sockets, sessions, the ledger, validation. No DOM. |
| `scripts/apps/` | The overlay, the builder, the launcher. |
| `scripts/systems/` | One file per game system, plus the generic fallback. |
| `scripts/lib/` | Self-contained helpers with no Foundry dependency. |

## Upgrading from `sbts-loot-wheel`

This module was called `sbts-loot-wheel` before 2.0.0. On first load as a GM it
offers to bring across the old spin ledger and re-stamp items that were won from
a wheel. The migration only ever **adds** — nothing is deleted, renamed or
overwritten — and declining just defers the offer to next session.

## Licence

MIT. See [LICENSE](LICENSE).
