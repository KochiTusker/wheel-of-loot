# API and other game systems

## The module API

```js
const wheel = game.modules.get("wheel-of-loot").api;   // also globalThis.wheelOfLoot

await wheel.present({table, allocations});  // put a wheel on every screen
await wheel.build(table);                   // open the builder
await wheel.createTable();                  // new table + builder
await wheel.grant({userId: 3});             // hand out spins
await wheel.manage();                       // open the wheel manager
await wheel.undo();                         // take back the last prize
wheel.getCredits();                         // { userId: spinsRemaining }
```

Everything here is GM-only and says so by returning early rather than throwing.
`present` takes the same shape the launcher builds:

```js
await wheel.present({
  table: game.tables.getName("Dragon's Hoard"),
  allocations: {[game.users.getName("Amos").id]: 2}
});
```

### Undo

One deep, GM only, and deliberately narrow. It reverses the most recent grant —
deleting the item or taking the coin back out of the purse — and refunds the
spin that bought it.

It will only ever reverse something this module did. The item is matched on the
table's **uuid**, stamped onto every prize as it is granted, so renaming a wheel
between the win and the undo does not strand the prize. Anything that does not
match is left alone and reported rather than deleted on trust.

## Other game systems

Everything system-specific — what a rarity is, where a purse lives, whether an
item is single-use, who may receive a prize, which fields tell one printing of
an item from another — sits behind one adapter interface in
[`scripts/systems/`](../scripts/systems/).

Systems without an adapter still work. The generic fallback answers from
documents alone, trying the field names that actually occur across systems
rather than guessing one, and the interface **hides the controls it cannot
support** rather than showing ones that would do nothing: no rarity filter in a
system with no rarities, no single-use filter where uses are not tracked.

### Adding one

One file and one call. Another module can do it without this one changing, and
anything you leave out falls through to the generic adapter:

```js
import {registerSystemAdapter} from "/modules/wheel-of-loot/scripts/systems/adapter.js";

Hooks.once("init", () => registerSystemAdapter({
  id: "my-system",
  rarities: ["mundane", "fine", "masterwork"],
  rarityColour: key => ({mundane: "#3f3f46", fine: "#1a7f3c", masterwork: "#b26a00"})[key],
  rarityOf: source => foundry.utils.getProperty(source, "system.quality") ?? null
}));
```

### The full interface

| Member | Purpose |
| --- | --- |
| `id` | The `game.system.id` this serves |
| `indexFields` | Extra compendium index fields to request, so browsing does not cost a document load per row |
| `rarities` | Rarity keys, least to most rare. Empty hides every rarity control |
| `rarityOf` / `rarityColour` / `rarityLabel` | What a rarity is, what ink it prints in, what it is called |
| `useProfile` | `"single"` / `"charges"` / `"recharge"` |
| `tracksUses` | False hides the single-use filter entirely |
| `parseCurrency` | `"250 gp"` → `{denom, amount}`, or null |
| `grantCurrency` | Move coin into an actor's purse; return false if there is nowhere to put it |
| `isRewardable` | May this actor receive a prize? |
| `descriptionOf` | Raw description HTML |
| `sourceOf` | Book or publication an entry came from |
| `priceOf` / `usesMaxOf` / `subtypeOf` | The three fields the duplicate fold discriminates on |

Those last three matter more than they look. They are what tells one *printing*
of an item from another, and reading them at one system's field names in
another system's world does not throw — it quietly makes duplicate detection
useless, which is worse.

---

[← Back to the README](../README.md)
