# Changelog

All notable changes to this module are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- **A near-miss beat.** The wheel now stops a third of a slice short and creeps
  home, which is what turns "it stopped" into "it nearly went past".
- **Undo the last win.** A quiet button on the result card takes the prize back
  and refunds the spin. One deep, GM only, and it verifies the item is still the
  one the wheel created before removing anything.

### Fixed

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
