# Wheel of Loot — working notes

A Foundry VTT module. Broadcast prize wheel over a RollTable, plus a builder for
making one.

## Gate

```bash
node test/run.mjs
```

Must pass before any commit. It covers everything that is pure arithmetic —
slot distribution, dispersion, slice colouring, table validation, the generic
adapter. If a change makes something untestable, that is usually a sign the
logic belongs in `core/` rather than where it is going.

## Layout, and why

| Directory | Rule |
| --- | --- |
| `scripts/core/` | Rules and arithmetic. **No DOM, no `system.*`.** Must stay importable under plain Node. |
| `scripts/apps/` | Interface only — the overlay, the builder, the launcher. |
| `scripts/systems/` | One file per game system. The *only* place `system.*` paths may appear. |
| `scripts/lib/` | Self-contained helpers with no Foundry dependency at all. |

`test/harness.mjs` stubs the Foundry globals `core/` genuinely reaches for. If it
starts growing, logic has leaked out of the pure layer — that is the signal to
push it back.

## Traps that have already cost time

- **Two GM clients is the trap.** Sessions live in memory on one client. socketlib's
  `executeAsGM` short-circuits a *GM's own* call to run locally, so a wheel presented
  by GM-B could never be spun by a player — their request landed on GM-A, which had no
  such session, and returned silently. It read exactly like a permission bug. Every
  mutation now routes through `callOwner()` (`executeAsUser` targeting `activeGM`), and
  a missing session reports loudly instead of returning.

- **A CSS rule beats an SVG presentation attribute.** `<text fill="…" text-anchor="…">`
  is silently overridden by any loaded `.wol-wedge text { … }` rule. Worse, relying on
  the *absence* of a property fails too — a stale stylesheet once set `text-anchor: middle`
  and centred all 64 labels on the rim. Paint per-slice colour, anchoring and size via
  inline `style=`, which wins outright.

- **Foundry gives each result one contiguous range.** Three copies of an item are
  necessarily adjacent, which reads as one fat wedge. Hence `disperseSlots` — the wheel
  keeps its own layout, seeded and broadcast so every client draws the same thing. Odds
  are unchanged because a flat roll over equal slices reproduces the weights exactly.

- **`range`, not `weight`, is what drives a RollTable roll.** Normalise before presenting.

- **Foundry's format strings have no pluralisation.** `{n} entr(y|ies)` prints literally.

- **Handlers that need the caller must be `function`, not arrow** — socketlib binds
  `this` to the socket data, and `this.socketdata.userId` is the unforgeable sender.

- **dnd5e: "consumable" does not mean single-use.** Pipes of Haunting is a consumable
  with 3 charges recovering `1d3` on a long rest. The reliable tell is
  `system.uses.recovery[].period`. Encoded in `useProfile()` in `systems/dnd5e.js`.

- **Duplicate item names are usually real variants**, not mistakes — different printings.
  `system.source.book` is the discriminator. A *redundant* copy is narrower: same name,
  same pack, same book.

- **Descriptions must be enriched, not stripped.** Rules text carries
  `[[/save con 13 format=long]]`; stripping tags leaves that syntax visible to players.

## Trust model

The GM client is authoritative. Players only ever send "I clicked spin" and "I clicked
keep". Anti-spam rests on three things in order: the credit is debited **before** the
roll; a phase gate refuses a spin unless the session is `idle`; the caller is identified
by `this.socketdata.userId`. The disabled button is courtesy, not enforcement.

The socket handlers are exported so the permission rules can be driven directly —
call one as `handler.call({socketdata: {userId}}, sessionId)`. That weakens nothing:
they are already remotely callable, and every check lives inside the handler.

## Releasing

Tag `vX.Y.Z` and push. The workflow runs the tests, stamps `module.json` with the
version and a pinned download URL, zips, and publishes. `module.json` is the source of
truth for the id — do not hand-edit the version, let the tag drive it.

## Renamed from `sbts-loot-wheel`

`core/migrate.js` handles it: additive only, asks first, and declining defers rather
than dismisses. `LEGACY_MODULE_ID` in `core/constants.js` is the only place the old id
appears — keep it that way.
