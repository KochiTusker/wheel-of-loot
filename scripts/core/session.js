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
import {creditsFor, debit, getCredits, totalCredits, writeCredits} from "./ledger.js";
import {autoClose, chatCardMode, gmNeedsCredit, spinDuration, wheelSpeaker} from "./settings.js";
import {isExhausted, rollSlice} from "./odds.js";
import {recordGrant} from "./undo.js";
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
    layout: payload.layout,
    // Every client draws and behaves from the same resolved configuration,
    // rather than each reading the world settings for itself.
    appearance: payload.wheel?.appearance,
    rules: payload.wheel?.rules
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
  const isGM = user.isGM && !(session.wheel?.rules?.gmNeedsCredit ?? gmNeedsCredit());
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

  // Everything from here has already taken the player's credit, so any failure
  // has to give it back and return the wheel to a spinnable state. Leaving the
  // phase claimed would kill the wheel for the rest of the session, and the
  // only way out would be for the GM to close it and start again.
  try {
    const slice = await rollSlice(session.entries, session.layout);
    if (slice == null) throw new Error("the roll produced no slice");

    session.slice = slice;
    session.entry = session.entries[session.layout[slice]];

    await socket().executeForEveryone("playSpin", {
      sessionId,
      slice,
      durationMs: session.wheel?.rules?.spinMs ?? spinDuration(),
      spinnerId: caller,
      spinnerName: user.name,
      actorName: session.currentActorName,
      actorId: actor?.id ?? null,
      hasActor: !!actor
    });
  } catch (err) {
    console.error("Wheel of Loot | the spin failed after the credit was spent", err);
    await releaseSpin(session, {refund: !isGM ? caller : null});
    ui.notifications.error(t("Notify.RollFailed"));
    await tell(caller, t("Notify.SpinRefunded"));
  }
}

/**
 * Put a session back to a spinnable state, optionally giving a credit back.
 *
 * The phase is the wheel's lock. Anything that claims it must be able to give
 * it up again on every path, or one failed spin ends the ceremony.
 *
 * @param {object} session
 * @param {object} [options]
 * @param {?string} [options.refund]  User to hand a spin back to.
 */
async function releaseSpin(session, {refund = null} = {}) {
  session.phase = "idle";
  session.slice = null;
  session.entry = null;
  session.currentSpinnerId = null;
  session.currentActorId = null;
  session.currentActorName = null;
  session.giftedTo = null;
  if (refund) await refundSpin(refund);
}

/**
 * Hand one spin back.
 *
 * Separate from `releaseSpin` because a failed grant happens *after* the wheel
 * has landed: the phase still has to run through resolution and re-arm the
 * normal way, and only the credit is owed.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} Whether the ledger was changed.
 */
export async function refundSpin(userId) {
  if (!userId) return false;
  try {
    const map = getCredits();
    map[userId] = (Number(map[userId]) || 0) + 1;
    await writeCredits(map);
    return true;
  } catch (err) {
    console.error("Wheel of Loot | could not refund the spin", err);
    return false;
  }
}

/**
 * Whether this client is holding any live wheel.
 *
 * A GM that has just finished loading cannot be, by definition — the map is
 * in memory and a reload emptied it. That is what makes it safe to conclude
 * that any wheel still on a player's screen is an orphan.
 *
 * @returns {boolean}
 */
export function hasLiveSessions() {
  return sessions.size > 0;
}

/**
 * Give back any spin whose player has vanished mid-decision.
 *
 * The phase is released by `resolveWheel`, and a client that closed before
 * choosing never sends one — so without this the wheel stays locked on a
 * decision nobody is going to make, and the GM's only exit is ending the
 * ceremony for everybody.
 *
 * The credit comes back because the player never got to choose. They did not
 * spend their turn; their browser did.
 *
 * Returns the sessions it freed rather than broadcasting itself, so the rule
 * can be tested without a socket.
 *
 * @param {string} userId
 * @returns {Promise<string[]>} Session ids that were released.
 */
export async function releaseAbandonedSpins(userId) {
  const released = [];
  for (const [sessionId, session] of sessions) {
    if (session.phase !== "spinning") continue;
    if (session.currentSpinnerId !== userId) continue;
    // A GM spins without spending, so there is nothing to give back.
    const wasGM = !!game.users.get(userId)?.isGM;
    await releaseSpin(session, {refund: wasGM ? null : userId});
    released.push(sessionId);
  }
  return released;
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
    // The client hides the button, but hiding is not enforcing.
    if (!(session.wheel?.rules?.allowGift ?? true)) {
      console.warn("Wheel of Loot | gift refused; this wheel does not allow it");
      await tell(caller, t("Notify.GiftNotAllowed"));
      return;
    }
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
  // Distinct from "granted nothing": a text wedge that is not currency is
  // *meant* to hand over nothing automatically, and the card says to do it by
  // hand. Only an actual failure earns the spin back.
  let failed = false;

  if (accepted) {
    try {
      if (entry.uuid) {
        const source = await fromUuid(entry.uuid);
        if (!source) throw new Error(`could not resolve ${entry.uuid}`);
        const data = source.toObject();
        delete data._id;
        // Provenance, so a later audit can tell wheel loot from an import — and
        // so undo can prove this is the document it created. The name is the
        // label a human reads; the uuid is what survives a rename.
        foundry.utils.setProperty(data, `flags.${MODULE_ID}.wonFrom`, session.tableName);
        foundry.utils.setProperty(data, `flags.${MODULE_ID}.wonFromUuid`, session.tableUuid ?? null);
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
      failed = true;
    }
  }

  // The credit was spent before the roll, which is what stops a click flood.
  // When the prize could not actually be handed over — the item was deleted
  // between the wheel being presented and the prize being taken, say — the
  // player has paid for nothing, exactly as they would have on a failed roll.
  if (failed && !game.users.get(session.currentSpinnerId)?.isGM) {
    await refundSpin(session.currentSpinnerId);
    await tell(session.currentSpinnerId, t("Notify.SpinRefunded"));
  }

  // Remember what changed hands, so a GM can take it back if it was a mistake.
  if (accepted && (granted || coins)) {
    session.grantAt = Date.now();
    // Bookkeeping must never cost the player their prize, which they already
    // have by this point; the worst case here is that undo is unavailable.
    await recordGrant({
      actorId: actor.id,
      itemId: granted?.id ?? null,
      coins: coins ?? null,
      prizeName: entry.name,
      tableName: session.tableName,
      tableUuid: session.tableUuid ?? null,
      spinnerId: session.currentSpinnerId,
      spinnerWasGM: !!game.users.get(session.currentSpinnerId)?.isGM,
      at: session.grantAt
    });
  }

  // A limited wedge is spent when it is actually taken, not when it is landed
  // on: a refused prize is still on offer to the next spinner.
  if (accepted && (granted || coins)) await spendStock(session, entry);

  // The prize has already changed hands, so a failure to *announce* it must not
  // strand the wheel in the resolving phase. Report and carry on.
  try {
    await postResultCard(session, accepted, granted, coins);
  } catch (err) {
    console.error("Wheel of Loot | could not post the result card", err);
  }

  // Re-arm for whoever still holds credits; close once the wheel is spent.
  await releaseSpin(session);

  // A wheel with nothing left to give is finished regardless of who still
  // holds a spin — re-arming it would offer a choice that cannot be made.
  if (isExhausted(session.entries)) {
    await socket().executeForEveryone("exhaustWheel", sessionId);
    sessions.delete(sessionId);
  } else if (totalCredits() > 0 || !(session.wheel?.rules?.autoClose ?? autoClose())) {
    await socket().executeForEveryone("rearmWheel", sessionId);
  } else {
    sessions.delete(sessionId);
    await socket().executeForEveryone("closeWheel", sessionId);
  }
}

/**
 * Take one off a limited wedge, and retire it when it runs out.
 *
 * Written back to the table as well as to the live session, because a hoard
 * that refills itself when the wheel is closed and reopened is not a hoard. The
 * table is the record; the session is only this evening's copy of it.
 *
 * Failure is reported but never blocks: the player already has the prize, and
 * an over-generous wheel is a far smaller problem than a lost item.
 *
 * @param {object} session
 * @param {object} entry
 */
async function spendStock(session, entry) {
  if (entry.stock == null) return;

  const left = Math.max(0, entry.stock - 1);
  entry.stock = left;
  entry.depleted = left === 0;

  try {
    const table = await fromUuid(session.tableUuid);
    const result = entry.resultId ? table?.results?.get(entry.resultId) : null;
    if (result) await result.setFlag(MODULE_ID, "stock", left);
  } catch (err) {
    console.error("Wheel of Loot | could not write the remaining stock back", err);
  }

  if (entry.depleted) {
    try {
      await socket().executeForEveryone("depleteWedge", {
        sessionId: session.sessionId,
        // The index, not the name: two wedges can legitimately share a name
        // (different printings of the same item), and only one of them is
        // spent. The index is what the layout is keyed on already.
        index: session.entries.indexOf(entry)
      });
    } catch (err) {
      console.error("Wheel of Loot | could not announce the depleted wedge", err);
    }
  }
}

/* -------------------------------------------- */
/*  Chat record                                 */
/* -------------------------------------------- */

async function postResultCard(session, accepted, granted, coins) {
  const mode = session.wheel?.rules?.chatCard ?? chatCardMode();
  if (mode === "none") return;
  const esc = foundry.utils.escapeHTML;
  const entry = session.entry;
  const spinner = session.currentActorName;
  const who = session.giftedTo ?? spinner;
  const gift = session.giftedTo
    ? ` <span class="wol-card-gift">${t("Card.GiftedBy", {name: esc(spinner)})}</span>`
    : "";
  // An item's name and image are author-controlled text that ends up in a chat
  // card every player sees. A stray quote breaks the markup; a crafted one does
  // worse. Neither goes in raw.
  const link = granted
    ? granted.link
    : (entry.uuid ? `@UUID[${entry.uuid}]{${esc(entry.name)}}` : esc(entry.name));

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
          <img src="${esc(entry.img ?? "")}" alt="">
          <div>
            <p class="wol-card-prize">${link}</p>
            <p class="wol-card-roll">${t("Card.Roll", {
              name: esc(spinner), slice: session.slice + 1, total: session.layout.length
            })}</p>
          </div>
        </div>
        ${verdict}
      </div>`,
    speaker: {alias: session.wheel?.speaker || wheelSpeaker()},
    // A GM-only card keeps the record without spoiling what is still on the
    // wheel for the players who have not spun yet.
    whisper: mode === "gm" ? ChatMessage.getWhisperRecipients("GM").map(u => u.id) : undefined,
    flags: {[MODULE_ID]: {sessionId: session.sessionId, accepted, grantAt: session.grantAt ?? null}}
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
export async function startSession({table, entries, layout, wheel}) {
  const sessionId = foundry.utils.randomID();
  await callOwner("registerSession", {
    sessionId,
    tableUuid: table.uuid,
    tableName: table.name,
    entries,
    layout,
    wheel
  });
  return sessionId;
}
