# Security Policy

Thanks for taking the time to help keep Wheel of Loot safe.

This document does three things:

1. Lays out a **lightweight STRIDE threat model**, so you know what the module
   defends against and what it deliberately does not.
2. States plainly **what data the module touches** and where it goes.
3. Describes how to **report a vulnerability** privately.

---

## What this module is, in security terms

Wheel of Loot is a **Foundry VTT module**. It runs entirely inside a Foundry
world, on the GM's server and on each connected player's browser. It is not a
service, has no account system, and stores no credentials.

Three properties shape everything below, and all three are verifiable from the
source in a few seconds:

- **It makes no network calls.** There is no `fetch`, no `XMLHttpRequest`, no
  WebSocket of its own, and no external URL referenced at runtime. Nothing this
  module holds can leave your Foundry server by way of this module.
- **It ships no assets and no compendium packs.** Every image path it uses
  resolves against Foundry's own bundled icons.
- **It has one dependency**, [socketlib](https://github.com/manuelVo/foundryvtt-socketlib),
  declared in the manifest. There is no build step and no npm package tree.

The interesting trust boundary is therefore not the network. It is **the socket
between a player's browser and the GM's**.

---

## Lightweight STRIDE threat model

The adversary worth modelling is **a player at your own table running a modified
client**. They can call any handler this module registers with socketlib, with
any arguments they like. Everything below assumes exactly that.

| Threat | What the module does | What you should know |
|---|---|---|
| **S — Spoofing** | Caller identity is read from `this.socketdata.userId`, which Foundry's socket server stamps on every message. It is never taken from the payload, so a client cannot claim to be another user. | Handlers that need the caller are declared with `function` rather than arrow syntax, because socketlib binds `this`. A refactor that "tidies" one into an arrow silently removes the identity check. |
| **T — Tampering** | Every mutation runs on the GM's client. A player's call is only ever a *request*: the spin credit is debited GM-side **before** the roll, the winning slice is rolled GM-side, the item is created GM-side, and a gift target is re-validated GM-side rather than trusted from the client. Per-wheel rules are enforced on the GM too — a wheel that forbids gifting refuses the socket call, not merely the button. | The disabled button on a player's screen is courtesy, not enforcement. Everything that matters is checked again where it is applied. |
| **R — Repudiation** | Every granted prize is stamped with `flags.wheel-of-loot.wonFrom` on the item itself, and by default a card is posted to chat. Undo records what it reversed. | A GM can set the result card to GM-only or off. The flag on the item is the durable record; the chat card is not. |
| **I — Information disclosure** | A wheel's full contents are broadcast to every connected client when it is presented — that is the entire point of the feature. Item descriptions are enriched with `secrets: false` and `section.secret` blocks are stripped, so GM-only prose inside an item does not travel. | **Do not present a wheel whose contents are themselves a spoiler.** Everyone can read every wedge, including prizes nobody wins. If a wheel must stay secret until spun, it is the wrong tool. |
| **D — Denial of service** | A session carries a phase; a spin is refused unless it is `idle`, so concurrent clicks cannot interleave. The credit is spent before the roll, so a flood can only ever spend what the ledger holds. Every broadcast handler verifies the sender is a GM, so a player cannot open, spin or close a wheel on other people's screens. | Foundry offers no per-module socket rate limit, so a modified client can still generate traffic. It cannot make the module *do* anything, but it can be noisy. If a player is doing that, the answer is a Foundry-level ban, not a module setting. |
| **E — Elevation of privilege** | `registerSession`, `cancelWheel`, `setSpins` and every broadcast handler check `game.users.get(caller)?.isGM`. `resolveWheel` accepts only the player whose spin it is, or a GM. The spin ledger is a world-scope setting, which Foundry itself permits only a GM to write — a client cannot mint itself spins. | The ledger's write protection is Foundry's, not this module's. That is deliberate: it is a stronger guarantee than anything the module could enforce on its own. |

### What it explicitly does not defend against

Being honest about the edges is more useful than a longer list of controls:

- **A GM hostile to their own players.** The GM owns the world; the module
  cannot and should not constrain them.
- **A player with Foundry-level permission to edit items or actors.** If your
  permissions let a player create items, they do not need this module to give
  themselves one.
- **Hostile content in a compendium you installed.** The module escapes item
  names and image paths before putting them in markup, but a module or pack you
  have chosen to trust has many other ways in.
- **Anything about your Foundry server itself** — its bind address, its
  password, its exposure to the internet. Those are Foundry's concerns.

---

## What data the module touches

| Data | Read | Written | Leaves your server |
|---|---|---|---|
| Items in compendiums and the world Items directory | yes, to build the browser | no | no |
| The RollTable backing a wheel | yes | yes — results, ranges, and the module's own flags | no |
| A character's inventory | no | yes — the item a wheel grants, and its removal on undo | no |
| A character's currency | yes, to add to it | yes — coin wedges | no |
| The spin ledger and module settings | yes | yes | no |

Nothing is transmitted anywhere except over Foundry's own socket, to clients
already connected to your world.

---

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/KochiTusker/wheel-of-loot/security/advisories/new).
That opens a private thread visible only to the maintainer.

Useful things to include, if you have them:

- What an attacker gains, and what access they need to start.
- The Foundry version, game system, and module version.
- A minimal reproduction — for socket issues, the handler and the arguments.

### What to expect

- **Acknowledgement** within a week.
- A **triage assessment** — likely severity and fix complexity — once confirmed.
- For confirmed issues: a fix on `main` and a release, with credit in the
  release notes unless you would rather stay anonymous.

This is a hobby project maintained by one person. That is not an excuse for a
slow response to a real vulnerability, but it is a reason to be realistic about
the timeline for a low-severity one.

---

## For maintainers

Secret scanning runs on every push and pull request
([`.gitleaks.toml`](.gitleaks.toml), wired up in
[`ci.yml`](.github/workflows/ci.yml)), extending gitleaks' default ruleset with
two project-specific patterns: a maintainer's personal email address, and
private network addresses. Neither belongs in a public repository, and both are
the kind of thing that reaches a commit by accident rather than by malice.

The release workflow runs the same checks before it will publish a tag.
