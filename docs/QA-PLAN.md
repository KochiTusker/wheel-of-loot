# QA remediation plan

Issues found in the adversarial pass that were **not** fixed in the first round,
ordered by what they cost a GM in the middle of a session.

Each entry states the symptom, why it happens, the fix, and — importantly — how
the fix is *proved*. A fix without a failing-then-passing check is a hope.

Status is updated as work lands.

| # | Issue | Severity | Status |
|---|---|---|---|
| Q1 | A player who disconnects mid-spin strands the wheel | High — kills the session | ☐ |
| Q2 | A GM reload leaves a dead wheel on every screen | High — kills the session | ☐ |
| Q3 | A failed grant costs the player their spin | Medium — silent loss | ☐ |
| Q4 | Depletion greys every wedge sharing a name | Medium — wrong prize retired | ☐ |
| Q5 | Undo breaks if the table is renamed | Low — feature unavailable | ☐ |
| Q6 | The manager resolves every UUID on every wheel to draw thumbnails | Low — slow with many wheels | ☐ |
| Q7 | Confidence gaps: multi-client, non-dnd5e, Foundry v13 | — | ☐ |

---

## Q1 — A player who disconnects mid-spin strands the wheel

**Symptom.** A player spins, the wheel lands, and their browser closes before
they choose keep / gift / refuse. The session phase stays `spinning` forever.
Nobody else can spin. The GM's only exit is *Close for everyone*, which ends the
ceremony for the whole table.

**Why.** The phase is released by `resolveWheel`, and nothing else ever calls it.
A client that never sends the resolution never releases the lock.

**Fix.** The owning GM watches for the current spinner going inactive. When that
happens with a spin unresolved, release the phase and refund the credit — the
player did not get to choose, so they have not spent their turn. Announce it, so
the table understands why the wheel came back.

**Proof.** A test drives a session into `spinning`, fires the disconnect path for
the spinner, and asserts the phase returns to `idle`, the credit comes back, and
a second player can then spin.

---

## Q2 — A GM reload leaves a dead wheel on every screen

**Symptom.** The GM refreshes their browser while a wheel is up. Every player
still sees the wheel. Pressing spin reports that the wheel is no longer open —
correctly and loudly — but nothing ever closes it, so the table is left staring
at a thing that cannot work.

**Why.** `sessions` is an in-memory `Map` on the owning GM's client. A reload
destroys it. The clients have no way to know.

**Fix.** A GM that has just finished loading owns no sessions by definition. If
it is the designated GM, it tells every client to close any wheel it is showing.
Cheap, and correct precisely because a freshly-loaded GM cannot be mid-ceremony.

**Proof.** A test asserts the ready path broadcasts a close when the GM holds no
sessions, and does **not** when it holds one — the second case matters, because
the designated GM re-electing itself mid-session must not shut its own wheel.

---

## Q3 — A failed grant costs the player their spin

**Symptom.** A player wins an item that was deleted from the world between the
wheel being presented and the prize being accepted. The grant fails, the module
reports it honestly, and the player is left with nothing — having spent a spin.

**Why.** The credit is debited before the roll (deliberately — it is what stops
a click flood). The grant failure path reports but does not refund.

**Fix.** Refund on a grant that produced neither an item nor coin, and say so.
The wheel already refunds a failed *roll*; a failed *grant* is the same loss
from the player's side.

**Proof.** A test forces the grant to fail and asserts the credit returns.

---

## Q4 — Depletion greys every wedge sharing a name

**Symptom.** Two wedges hold different printings of the same item. One runs out
of stock. Both are struck through, and only one of them is actually spent.

**Why.** The depletion broadcast carries the entry's *name*, and the client
matches on it.

**Fix.** Broadcast the entry index. It is already the identity the layout uses,
and it is unambiguous by construction.

**Proof.** A test builds a wheel with two identically-named entries, depletes
one, and asserts the other is still winnable.

---

## Q5 — Undo breaks if the table is renamed

**Symptom.** A prize is won, the GM renames the wheel, then tries to undo. Undo
refuses, saying the item is no longer the one the wheel gave out.

**Why.** Undo verifies provenance by comparing the item's `wonFrom` flag — a
table *name* — against the name recorded at grant time. Renaming breaks the
match. The check exists for a good reason: an id alone is not proof the document
is the same one. But the name is the wrong anchor.

**Fix.** Record the table's uuid as well, and verify against that. Keep `wonFrom`
as the human-readable label it was always meant to be.

**Proof.** A test records a grant, renames the table, and asserts undo still
recognises the item — and that an item from a *different* wheel is still refused.

---

## Q6 — The manager resolves every UUID on every wheel

**Symptom.** Opening the wheel manager in a world with many wheels is slow.

**Why.** Each thumbnail calls `buildEntries`, which resolves every wedge's
document to fetch its name, art and description. A thumbnail needs none of that
— it draws coloured arcs.

**Fix.** Read slice counts straight off the table's result ranges. No document
resolution at all.

**Proof.** A test renders the manager with `fromUuid` instrumented and asserts it
is never called.

---

## Q7 — Confidence gaps

Not defects; things not yet exercised. Recorded so they are not mistaken for
tested ground.

- **Multi-client.** Everything is driven headlessly or against a single browser.
  The two-GM routing bug in 1.0 is proof this class of failure is real and
  invisible to single-client testing.
- **Non-dnd5e.** The generic adapter is unit-tested, but no non-dnd5e world has
  ever loaded the module.
- **Foundry v13.** The manifest declares a v13 minimum; only v14.365 has been
  run against.

These need a real world and a second browser, not more code.
