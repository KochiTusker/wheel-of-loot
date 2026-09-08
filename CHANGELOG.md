# Changelog

All notable changes to this module are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Custom prizes.** A wedge no longer has to be an Item. **New prize** in the
  builder takes a name, art, rules text and a rarity, and puts anything on the
  wheel — a favour owed, a title, a rumour, homebrew you have not written up
  yet. It weights, jackpots, limits and wins like any other wedge; nothing is
  created on the sheet, and the chat card asks you to hand it over.
- **Repairing a broken wedge.** When the item behind a prize has been deleted,
  or lived in a compendium from a module you have since removed, the builder
  flags it and offers to keep the wedge as a custom prize. Its name, art and
  rarity are already on the table result, and its slots, odds, jackpot and
  stock are preserved — so a broken link no longer means rebuilding the wedge.
- **Dry run.** Spin the wheel exactly as the table will meet it: the real
  layout, the real art, the real odds, the real confetti. On your screen only —
  no session, no broadcast, no credit spent, nothing granted, nothing written.
  It runs on the *unsaved* builder state, so you can try a change, look at it,
  and abandon it by closing the window. Reported missing items along the way,
  where it costs nothing, rather than at the table where it costs a spin.
- `tools/check-icons.mjs`, which verifies that every core Foundry icon path
  the module names actually exists. The module ships no artwork, so a mistyped
  path fails silently as a broken image in front of the players; this is the
  gate that catches it.

- **Weighted odds.** A wedge can now look bigger than it is: an odds multiplier
  in percent decouples a wedge's width from its real chance, so a grand prize
  can be three slices wide and still a quarter as likely as it appears. The
  builder shows the true chance beside every wedge and colours it when it
  diverges from what the picture implies. Leaving everything at 100% takes the
  original flat roll, and a test walks every face of both paths to prove they
  agree.
- **Themes.** Six looks that set palette and hub together — Fairground,
  Dragon's Hoard, Fae Court, Grimdark, Clockwork, Chapel. Hub art is Foundry's
  own bundled game-icons.net set (CC BY 3.0); the module ships no image files.
- **Preview this wheel** in the settings, showing a real wheel with the current
  form values, on the GM's screen only.
- **The scene shows through.** How far the canvas is dimmed behind the wheel is
  now a setting; at a low value your map reads through it.
- **Reduced motion**, following each viewer's own system preference by default.
- **Jackpot wedges.** Mark one wedge as the grand prize: a gold edge on the
  wheel so it can be tracked while spinning, a bigger confetti burst and a
  banner on the reveal.
- **A near-miss beat**, produced by the easing curve rather than by a second
  movement. The last tenth of the spin covers about a fifth of a slice, so the
  pointer visibly crawls toward the boundary — one continuous motion, because a
  wheel that moves again after stopping looks adjusted.
- **Every setting is now in Foundry’s module settings list.** Three of twenty-one
  used to be; the rest were only reachable through the grouped form. They render
  as native controls — sliders for the timings and the backdrop, dropdowns for
  the theme, palette, motion, result card and wheel size, and file pickers with
  browse buttons for the hub image and win sound. The grouped form remains, with
  the palette preview and the wheel preview, and is still what per-wheel
  overrides use.
- **A wheel manager.** Every wheel in the world, each drawn as a thumbnail of
  itself, with badges for broken, looted dry, own look, and limited wedges.
  Present, build, restyle, restock, duplicate, rename, delete. Wheels now
  declare themselves, so the launcher offers wheels rather than every RollTable.
- **Limited prizes.** A wedge can carry a stock count; it is struck through when
  it runs out, weighs nothing so the roll cannot reach it, and the count is
  written back to the table so a hoard stays looted.
- **Per-wheel appearance and rules.** Any wheel can override the world settings:
  its own palette, hub, speaker, confetti, backdrop, spin duration and rotations,
  win sound, and its own rules for gifting, refusing, whether the GM needs a
  spin, auto-close and where the result card goes. Open it from **This wheel’s
  look** in the builder. A blank field means "follow the world setting", and the
  placeholder shows what that currently is. The launcher marks a customised
  wheel with a ✦. Rules are enforced on the GM, not just hidden on the client.
- **Items you make in the game appear straight away.** The item list is cached
  for the session, so a newly created world item used to stay invisible until
  you remembered to press Refresh. World items are now folded in as they are
  created, renamed or deleted. Actor inventory and compendium items are left
  alone — a compendium change only drops the cache, so re-indexing is paid once,
  lazily, rather than hundreds of times during an import.
- **Undo the last win.** A quiet button on the result card takes the prize back
  and refunds the spin. One deep, GM only, and it verifies the item is still the
  one the wheel created before removing anything.

### Fixed

- **A claimed wedge could be won a second time.** Depletion sets a wedge's
  weight to zero, but it does not bend anyone's *odds* — so a wheel that had
  never been weighted still took the plain `1d<slices>` roll, which happily
  landed on a wedge already struck through as claimed and handed out a
  one-of-a-kind prize again. The flat roll is now taken only when it is also
  correct: no odds bent, and nothing claimed. A wheel that uses no stock limits
  is unaffected and rolls exactly as before.
- **Duplicate detection outside D&D 5e.** Price, charges and subtype — the three
  fields that tell one printing of an item from another — were read at dnd5e's
  own paths. In any other system they all came back empty, every printing
  scored identically, and the fold quietly collapsed genuinely different
  printings into one. They now go through the system adapter, as does the
  source book on a wedge whose item is not in the index, and the builder's item
  detail panel.

- The Spin and Rules tabs in the settings did nothing. `tab` is a reserved
  action name in ApplicationV2 — its dispatcher intercepts it and routes to the
  framework tab machinery before consulting the module’s own actions, so the
  handler was never called.
- The wheel sized on viewport height alone, so a short or narrow window pushed
  the title off the top.

## [2.0.0] — 2026-09-08

First public release. Renamed from `sbts-loot-wheel`, made system-agnostic, and
given a proper wheel builder.

### Breaking

- **Module id changed** from `sbts-loot-wheel` to `wheel-of-loot`. On first load
  as a GM, the module offers to bring across the old spin ledger and re-stamp
  items previously won from a wheel. The migration is additive — nothing is
  deleted, renamed or overwritten — and declining defers it to the next session.
- `globalThis.sbtsLootWheel` is now `globalThis.wheelOfLoot`. The module API
  moved with it: `game.modules.get("wheel-of-loot").api`. The old global is kept
  as an alias, with `edit()` still mapped to `build()`, so existing macros
  continue to work.
- The two token scene-control tools are gone, replaced by one button in the
  RollTables sidebar. Nothing is registered in the scene controls any more.
- CSS classes are prefixed `wol-` rather than `sbts-lw-`.

### Added

- **One entry point.** A single **Wheel of Loot** button in the RollTables
  sidebar replaces the three tools the module used to add to the token scene
  controls. Creating a wheel now sits beside the table picker in the launcher.
- **A settings menu**, grouped into Appearance, Spin, Rules and Builder:
  six slice palettes plus custom hex with a live preview, hub image, chat-card
  speaker, confetti, spin duration and rotations, per-client tick volume, an
  optional win sound, and switches for gifting, refusing, whether the GM needs a
  spin, whether the wheel auto-closes, and where the result card goes.
  Coin amounts and denomination are configurable, so a silver-standard campaign
  can write `sp` wedges.
  **Every default reproduces 1.0 behaviour exactly, and a test pins that.**
- **Duplicate handling in the builder.** A world with several imported books has
  the same item many times over. Three modes: show every copy, hide only exact
  duplicates (same printing, same compendium), or one row per item with the
  printings one click away. Variants are never silently discarded — four Dust of
  Dryness entries really are four different items.
- **Source book filter**, and duplicate detection driven through the system
  adapter, so it works outside dnd5e.
- **Choose the wheel's size.** Presets from 12 to 96 slices, or any number from
  2 to 120. Slice colouring, label length and type size all scale with it, and
  no two adjacent slices ever share a colour at any size — including the wrap.
- **Roll a wheel** builds a whole wheel from whatever the filters currently
  show; **Fill the gaps** tops one up without disturbing hand-picked prizes.
- **Re-roll a single wedge**, keeping its slot count so tuned odds survive.
- **Weight by rarity** when rolling, so commoner prizes take more of the wheel.
- **World items** now appear in the builder alongside compendium content.
  Homebrew and anything dragged out of a pack was previously invisible.
- **Create a new wheel table** from inside the module, rather than making a
  RollTable by hand first.
- Builder reachable from a RollTable sheet's own header.
- Fairground tick sound can be turned off per client.
- Full localisation; every string moved to `lang/en.json`.
- `node test/run.mjs` covers slot distribution, dispersion, colouring, table
  validation and the generic adapter.

### Changed

- **Any game system is supported.** Rarity, currency, use profiles and gift
  validation moved behind a system adapter interface, with a generic fallback
  that answers from documents alone. dnd5e keeps everything it had. The UI hides
  controls the running system cannot support rather than showing dead ones.
- Reorganised into `core/` (rules and arithmetic, no DOM), `apps/` (interface),
  `systems/` (per-system knowledge) and `lib/`.
- `validateTable` returns structured faults instead of English sentences, so the
  same check runs under test.
- Removed dead stylesheet rules left behind by an earlier reveal design.

## [1.0.0] — 2026-08-17

Initial version, as `sbts-loot-wheel`.

- Synchronised broadcast wheel over a RollTable, with a shared 64-slot layout.
- Spin ledger as a world setting; credits debited GM-side before the roll.
- Keep / gift / refuse on the reveal, with GM-side validation of gift targets.
- Coin wedges parsed from result names.
- Table editor with a compendium catalogue, filters and slot steppers.
- Repeated prizes dispersed around the rim rather than left adjacent.
