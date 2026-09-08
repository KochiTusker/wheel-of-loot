/**
 * Live wheels, and the rules that govern them.
 *
 * Trust model: the GM client is authoritative for everything that matters. It
 * holds the spin ledger, builds the wheel layout, rolls the slice, and creates
 * the item. Players only ever send "I clicked spin" and "I clicked keep".
 *
 * Anti-spam rests on three things, in order of importance:
 *   1. The credit is debited on the GM *before* the roll happens, so a flood of
 *      requests can only ever spend what the ledger holds.
 *   2. The session carries a phase; a spin is refused unless it is `idle`, so
 *      concurrent clicks cannot interleave.
 *   3. The caller is identified by `this.socketdata.userId`, stamped by
 *      Foundry's socket server and not forgeable by a modified client.
 * The disabled button on the player's screen is courtesy, not enforcement.
 *
 * Handlers that need the caller are declared with `function`, not arrow syntax,
 * because socketlib binds `this` to the socket data. They are exported so the
 * permission rules can be driven directly under test, by calling one with a
 * fabricated `this.socketdata.userId` exactly the way socketlib does. Exporting
 * them weakens nothing — they are already remotely callable, and every check
 * that matters lives inside the handler rather than in who can reach it.
 */

import {MODULE_ID, t} from "./constants.js";
import {creditsFor, debit, totalCredits} from "./ledger.js";
import {autoClose, chatCardMode, gmNeedsCredit, spinDuration, wheelSpeaker} from "./settings.js";
import {systemAdapter} from "../systems/adapter.js";
import {callOwner, socket, tell} from "./socket.js";

/**
 * GM-only. sessionId -> live wheel state.
 *
 * In-memory, so a session exists only on the client that created it. See
 * `callOwner` for why that has to be the designated GM and nobody else.
 */
export const sessions = new Map();

/* -------------------------------------------- */
/*  Presenting                                  */
/* -------------------------------------------- */

/**
 * Take ownership of a wheel and put it on everyone's screen.
 *
 * Runs on the designated GM, whichever GM actually pressed the button, so the
 * session lives on the same client that will later serve players' spins.
 */
export async function registerSession(payload) {
  const caller = this?.socketdata?.userId ?? game.user.id;
  if (!game.users.get(caller)?.isGM) return null;

  sessions.set(payload.sessionId, {
    ...payload,
    phase: "idle",
    slice: null,
    entry: null,
    currentSpinnerId: null,
    currentActorId: null,
    currentActorName: null,
    giftedTo: null
  });

  await socket().executeForEveryone("openWheel", {
    sessionId: payload.sessionId,
    tableName: payload.tableName,
    entries: payload.entries,
    layout: payload.layout
  });
  return payload.sessionId;
}

/** Close a wheel without resolving it. GM escape hatch. */
export async function cancelWheel(sessionId) {
  const caller = this?.socketdata?.userId ?? game.user.id;
  if (!game.users.get(caller)?.isGM) return;
  sessions.delete(sessionId);
  await socket().executeForEveryone("closeWheel", sessionId);
}

/* -------------------------------------------- */
/*  Spinning                                    */
/* -------------------------------------------- */

/**
 * Spend one credit, roll a slice, and tell every client where to land.
 */
export async function requestSpin(sessionId) {
  const caller = this?.socketdata?.userId ?? game.user.id;
  const session = sessions.get(sessionId);

  // Never fail silently here: a missing session is the symptom of a routing
  // problem, and silence made exactly that bug invisible once already.
  if (!session) {
    console.error(`Wheel of Loot | ${game.user.name} has no session ${sessionId}; it belongs to another client.`);
    await tell(caller, t("Notify.WheelClosed"));
    return;
  }

  // Phase gate: refuses a second spin while one is mid-flight or unresolved.
  // This is what stops a click flood spending several credits at once.
  if (session.phase !== "idle") {
    console.warn(`Wheel of Loot | spin refused, session is ${session.phase}`);
    return;
  }

  const user = game.users.get(caller);
  if (!user) return;

  // A GM normally spins for free; when the table has asked for it, they are
  // treated exactly like a player for both the credit check and the debit.
  const isGM = user.isGM && !gmNeedsCredit();
  const held = creditsFor(caller);

  if (!isGM && held < 1) {
    console.warn(`Wheel of Loot | ${user.name} tried to spin with no credits`);
    await tell(caller, t("Notify.NoSpins"));
    return;
  }

  // A player needs somewhere to put the loot. A GM may spin without a
  // character and hand the result to someone via Gift.
  const actor = user.character ?? null;
  if (!isGM && !actor) {
    await tell(caller, t("Notify.NoCharacter"));
    return;
  }

  // Claim the phase before anything awaits, so two clicks arriving together
  // cannot both get past the gate, then debit before the roll happens.
  session.phase = "spinning";
  session.currentSpinnerId = caller;
  session.currentActorId = actor?.id ?? null;
  session.currentActorName = actor?.name ?? user.name;

  if (!isGM) await debit(caller);

  const total = session.layout.length;
  // Every slice is the same size and the layout already honours each entry's
  // weight, so a flat roll over the slices reproduces the table's odds exactly.
  const roll = await new Roll(`1d${total}`).evaluate();
  const slice = roll.total - 1;

  session.slice = slice;
  session.entry = session.entries[session.layout[slice]];

  await socket().executeForEveryone("playSpin", {
    sessionId,
    slice,
    durationMs: spinDuration(),
    spinnerId: caller,
    spinnerName: user.name,
    actorName: session.currentActorName,
    actorId: actor?.id ?? null,
    hasActor: !!actor
  });
}

/* -------------------------------------------- */
/*  Resolving                                   */
/* -------------------------------------------- */

/** Grant or decline the landed reward, then re-arm or close the wheel. */
export async function resolveWheel(sessionId, accepted, giftActorId = null) {
  const caller = this?.socketdata?.userId ?? game.user.id;
  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`Wheel of Loot | ${game.user.name} has no session ${sessionId} to resolve.`);
    await tell(caller, t("Notify.WheelClosed"));
    return;
  }
  if (session.phase !== "spinning" || session.slice == null) return;
  if (caller !== session.currentSpinnerId && !game.users.get(caller)?.isGM) {
    console.warn(`Wheel of Loot | ${caller} tried to resolve someone else's spin`);
    return;
  }

  const adapter = systemAdapter();

  // A gift redirects the reward, so the target is validated here rather than
  // trusted from the client — it must be an actor somebody is actually playing.
  let actor = session.currentActorId ? game.actors.get(session.currentActorId) : null;
  let gifted = null;
  if (accepted && giftActorId) {
    const target = game.actors.get(giftActorId);
    if (!target || !adapter.isRewardable(target)) {
      console.warn(`Wheel of Loot | rejected gift to ${giftActorId}`);
      await tell(caller, t("Notify.BadGiftTarget"));
      return;
    }
    actor = target;
    gifted = target.name;
  }

  if (accepted && !actor) {
    await tell(caller, t("Notify.NowhereToPutIt"));
    return;
  }

  session.phase = "resolving";
  session.giftedTo = gifted;
  const entry = session.entry;
  let granted = null;
  let coins = null;

  if (accepted) {
    try {
      if (entry.uuid) {
        const source = await fromUuid(entry.uuid);
        if (!source) throw new Error(`could not resolve ${entry.uuid}`);
        const data = source.toObject();
        delete data._id;
        // Stamp provenance so a later audit can tell wheel loot from imports.
        foundry.utils.setProperty(data, `flags.${MODULE_ID}.wonFrom`, session.tableName);
        [granted] = await actor.createEmbeddedDocuments("Item", [data]);
      } else {
        // A text wedge: the only thing we know how to pay out is coin, and only
        // if the system can tell us where a purse lives.
        const payout = adapter.parseCurrency(entry.name);
        if (payout && await adapter.grantCurrency(actor, payout)) coins = payout;
      }
    } catch (err) {
      console.error("Wheel of Loot | could not grant reward", err);
      ui.notifications.error(t("Notify.GrantFailed", {item: entry.name, actor: actor?.name ?? "?"}));
      granted = null;
      coins = null;
    }
  }

  await postResultCard(session, accepted, granted, coins);

  // Re-arm for whoever still holds credits; close once the wheel is spent.
  session.phase = "idle";
  session.slice = null;
  session.entry = null;
  session.currentSpinnerId = null;
  session.currentActorId = null;
  session.currentActorName = null;
  session.giftedTo = null;

  if (totalCredits() > 0 || !autoClose()) {
    await socket().executeForEveryone("rearmWheel", sessionId);
  } else {
    sessions.delete(sessionId);
    await socket().executeForEveryone("closeWheel", sessionId);
  }
}

/* -------------------------------------------- */
/*  Chat record                                 */
/* -------------------------------------------- */

async function postResultCard(session, accepted, granted, coins) {
  const mode = chatCardMode();
  if (mode === "none") return;
  const esc = foundry.utils.escapeHTML;
  const entry = session.entry;
  const spinner = session.currentActorName;
  const who = session.giftedTo ?? spinner;
  const gift = session.giftedTo
    ? ` <span class="wol-card-gift">${t("Card.GiftedBy", {name: esc(spinner)})}</span>`
    : "";
  const link = granted ? granted.link : (entry.uuid ? `@UUID[${entry.uuid}]{${entry.name}}` : entry.name);

  let verdict;
  if (!accepted) {
    verdict = `<p class="wol-card-verdict refused"><i class="fa-solid fa-xmark"></i> ${t("Card.Refused")}</p>`;
  } else if (coins) {
    verdict = `<p class="wol-card-verdict accepted"><i class="fa-solid fa-coins"></i> ${
      t("Card.Coins", {amount: coins.amount, denom: coins.denom, name: esc(who)})}${gift}</p>`;
  } else if (granted) {
    verdict = `<p class="wol-card-verdict accepted"><i class="fa-solid ${session.giftedTo ? "fa-gift" : "fa-check"}"></i> ${
      t(session.giftedTo ? "Card.GiftedTo" : "Card.ClaimedBy", {name: esc(who)})}${gift}</p>`;
  } else {
    // Accepted, but nothing could be handed over automatically — say so rather
    // than implying the player received something.
    verdict = `<p class="wol-card-verdict pending"><i class="fa-solid fa-hand"></i> ${
      t("Card.Manual", {name: esc(who)})}</p>`;
  }

  await ChatMessage.create({
    content: `
      <div class="wol-card">
        <h3><i class="fa-solid fa-arrows-spin"></i> ${esc(session.tableName)}</h3>
        <div class="wol-card-body">
          <img src="${entry.img}" alt="">
          <div>
            <p class="wol-card-prize">${link}</p>
            <p class="wol-card-roll">${t("Card.Roll", {
              name: esc(spinner), slice: session.slice + 1, total: session.layout.length
            })}</p>
          </div>
        </div>
        ${verdict}
      </div>`,
    speaker: {alias: wheelSpeaker()},
    // A GM-only card keeps the record without spoiling what is still on the
    // wheel for the players who have not spun yet.
    whisper: mode === "gm" ? ChatMessage.getWhisperRecipients("GM").map(u => u.id) : undefined,
    flags: {[MODULE_ID]: {sessionId: session.sessionId, accepted}}
  });
}

/* -------------------------------------------- */
/*  Client-side handlers                        */
/* -------------------------------------------- */

/**
 * The overlay is imported lazily by the socket layer rather than here, so this
 * module stays free of DOM concerns and can be exercised headlessly.
 */
export function sessionHandlers() {
  return {registerSession, requestSpin, resolveWheel, cancelWheel};
}

/** Present a wheel to the whole table, from wherever the GM pressed the button. */
export async function startSession({table, entries, layout}) {
  const sessionId = foundry.utils.randomID();
  await callOwner("registerSession", {
    sessionId,
    tableUuid: table.uuid,
    tableName: table.name,
    entries,
    layout
  });
  return sessionId;
}
