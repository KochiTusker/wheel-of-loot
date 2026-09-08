# Troubleshooting

Ordered roughly by how often each one bites.

## The module is not in Manage Modules at all

Not unticked — genuinely absent from the list.

**Foundry scans the modules directory once, at startup.** If the module arrived
while the server was running — an install, a manual copy, a symlink — Foundry
does not know it exists yet. Restart Foundry, not the world.

## "Item X isn't in the list"

Two filters are on by default because they are right most of the time, and both
of them will hide an ordinary weapon:

- **Single-use only** hides anything with more than one charge. A wand, a staff,
  a sword — all hidden.
- In D&D 5e the type filter starts on **consumable**, because that is what most
  loot wheels are made of.

Set the type to **Any type** and clear **Single-use only**. Press **Reset** to
clear every filter at once.

If it is still missing, check **Refresh items** — the item list is built once and
cached. Items you create while the builder is open are folded in automatically,
but a compendium you have only just installed needs the refresh.

## Everything is listed eleven times

A world with several imported books genuinely contains eleven Potions of
Healing. The duplicate control (the dropdown reading **One row per item**)
decides what to do about it:

| Mode | What it does |
| --- | --- |
| **Show every copy** | No folding at all |
| **Hide exact duplicates** | Drops only the same printing listed twice in the same compendium |
| **One row per item** *(default)* | One row per distinct name; the badge shows how many printings exist, and clicking it lists them |

Variants are never discarded, only collapsed — four "Dust of Dryness" entries
across four books are *not* interchangeable, since the printings differ in how
many uses they carry.

## A wedge has a warning triangle on it

The item behind it no longer exists — deleted, or in a compendium from a module
you have since removed. The wheel can still spin, but nothing can be handed over
if it lands there.

Click the **pencil** on that row. The builder offers to keep the wedge as a
custom prize: its name, art and rarity are already stored on the wedge itself,
and its slots, odds, jackpot and stock are preserved. You do not have to rebuild
it.

## A player cannot spin

Spins are a permission, not a role. Open the launcher (the **screen** button in
the manager), give them one or more, and present. Or from a macro:

```js
game.modules.get("wheel-of-loot").api.grant({[someUserId]: 2});
```

The GM spins for free unless **The GM needs a spin too** is on.

## The wheel is stuck — someone is deciding and never decides

Usually a player who closed their browser mid-decision.

The GM's own wheel carries **Close for everyone**, which ends the session on
every screen. You should rarely need it: when a player disconnects while holding
a spin, the GM's client notices, frees the wheel and refunds them.

If a *GM* reloads the page mid-session, every player's wheel is closed for them
automatically rather than being left on screen with nothing behind it.

## The prize did not land on the character sheet

Three things to check, in order:

1. **The winner has a character assigned.** The gift list and the Keep button
   both need one. A GM spinning with no character gets Gift and Refuse only.
2. **The actor is a player character.** In D&D 5e that means `type: "character"`
   — an NPC or a vehicle is never a valid target.
3. **The chat card said so.** A prize that is plain text and not currency is
   *meant* to grant nothing automatically; the card asks you to hand it over.

If the grant genuinely failed, the spin is refunded and an error appears — it
does not silently cost the player their turn.

## Coin did not pay out

The wedge name has to parse as an amount and a denomination: `250 gp`,
`1,000 gold`, `50 sp`. The number comes first and commas are allowed.

The system also has to have somewhere to put it. In D&D 5e that is
`system.currency.<denom>`. In a system with no adapter, the module only pays out
if the actor already has a matching currency key holding a number — otherwise it
declines rather than writing junk onto a sheet, and the card tells you to hand
the coin over yourself.

Change the default denomination in the settings if your campaign is on a silver
standard.

## Nothing happens when I press Present

- **The wheel has no wedges.** Build it and press **Save to table** first.
- **Every wedge is claimed.** A wheel whose prizes are all spent cannot be
  presented; **Restock** it from the manager.
- **A wedge points at a missing item.** The module refuses to present a wheel
  that could land on a prize it cannot hand over, and names the offenders.

## The names on the wheel are cut off

At 64 slices there is not much room, and long names are truncated on the rim by
design — the wheel would be unreadable otherwise. The full name is always on the
reveal card, and in the builder every row's name has the whole thing on hover.

If you want more room, use fewer slices: the label length and type size adapt to
whatever size you choose.

## socketlib

The module will not run without it. It is a hard dependency declared in the
manifest, so Foundry should offer to install it — but if the wheel opens for you
and nobody else, socketlib is the first thing to check.

---

Still stuck? [Open an issue](https://github.com/KochiTusker/wheel-of-loot/issues)
— include your Foundry version, your game system and its version, and whatever
the browser console said.

[← Back to the README](../README.md)
