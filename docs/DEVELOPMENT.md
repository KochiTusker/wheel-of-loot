# Development

## The gates

```bash
node test/run.mjs            # the tests
node tools/check-i18n.mjs    # localisation, both directions
node tools/check-imports.mjs # nothing imported and unused
node tools/check-icons.mjs   # every core Foundry icon path exists
```

All four run in CI on every push, and again on a version tag before a release is
published — a tag that cannot pass them should not become a release.

**`test/run.mjs`** covers the parts that are pure arithmetic: slot distribution,
the dispersion that keeps repeated prizes apart, slice colouring at every wheel
size, table validation, the odds arithmetic, duplicate folding, the generic
adapter, and the promise that every setting default reproduces pre-2.0
behaviour. Anything needing `game` or the DOM is out of scope and has to be
exercised in a live world.

`test/harness.mjs` stubs the Foundry globals the pure layer touches. **If it
starts growing, that is the signal that logic has leaked out of `core/`.**

**`tools/check-icons.mjs`** exists because the module ships no artwork of its
own — every icon is a path into Foundry's bundled `icons/` tree, and a mistyped
one does not throw. It renders a broken-image box on a wheel in front of five
players, at the moment somebody wins that prize. The check needs a Foundry
installation to compare against and reports `SKIPPED` where there is none, so it
is useful locally and harmless in CI.

## Layout

The directory a thing lives in is a claim about what it may touch. Keeping that
true is what makes the pure layer testable under plain Node.

| Directory | Holds | May not |
| --- | --- | --- |
| `scripts/core/` | Rules and arithmetic — layout, sockets, sessions, the ledger, validation | Touch the DOM, or read `system.*` |
| `scripts/apps/` | The overlay, the builder, the manager, the launcher, the settings form | — |
| `scripts/systems/` | One file per game system, plus the generic fallback | — |
| `scripts/lib/` | Self-contained helpers | Depend on Foundry at all |

`scripts/systems/` is the **only** place `system.*` may appear. Everywhere else
asks the adapter. This is not tidiness: reading one system's field names
elsewhere does not fail loudly in another system's world, it fails silently, and
those are the bugs that reach users.

## Screenshots

The images in the README are captured from a live world by one command, so they
can be made current again after any interface change rather than slowly coming
to describe a version nobody is running:

```bash
node tools/shoot.mjs
```

It drives a headless Chrome over the DevTools protocol — no automation library,
because the repository has no dependencies and this was not a good enough reason
to start one. It needs a Foundry world already running and at least one wheel to
photograph.

```bash
node tools/shoot.mjs --url http://localhost:30000 --user Claude --out docs/images
```

It only ever opens windows on its own client. Nothing is presented, broadcast,
granted or saved.

### The tooling account

The script signs in as a real Foundry user, so one has to exist for it to sign in
*as*. The convention here — and for anything else that needs to drive a live
game, a browser agent included — is a **GM named `Claude` with no password**,
created in the world's User Configuration.

**Only on a server nobody else can reach.** A password-less GM is exactly what it
sounds like: anyone who can open the Foundry page becomes a GM. That is fine on
`localhost` or a LAN game you control. It is not fine on an instance exposed to
the internet, and it is worth deleting the account or giving it a password before
you open the server up.

## Security

`SECURITY.md` carries the threat model. The short version: the trust boundary is
the **socket**, not the network. The module makes no outbound requests of any
kind, and socketlib places no restriction on who may call `executeForEveryone`,
so **every broadcast handler verifies the sender is a GM** before acting. Rules
like "may this player refuse a prize" are enforced GM-side, never merely hidden
in the interface.

Secrets are scanned with gitleaks on every push, configured in `.gitleaks.toml`.

## Known gaps

`docs/QA-PLAN.md` tracks them. At the time of writing the open ones are all
things that need a second machine rather than more code: no multi-client test,
no non-`dnd5e` world has ever loaded the module, and Foundry v13 has never been
run.

On v13 specifically the evidence is static rather than empirical, and it is
good: `documentCollection` on TableResult is deprecated *since 13*, so the
`documentUuid` the module reads exists there; `renderChatMessage` is likewise
deprecated since 13, so the `renderChatMessageHTML` hook it uses exists there;
and ApplicationV2, DialogV2, the `<file-picker>` element and `foundry.utils`
all predate 13. The manifest still declares 14 as the minimum, because a
version nobody has run is not a version to promise.

---

[← Back to the README](../README.md)
