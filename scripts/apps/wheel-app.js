/**
 * The wheel overlay every client sees.
 *
 * Deliberately a plain DOM overlay rather than an Application: it is modal to
 * the whole table, has no header, no resize and no window controls, and needs
 * to sit above the canvas on every client simultaneously.
 *
 * The layout and the winning slice both arrive from the GM, so every client
 * draws an identical wheel and lands on the same slice. Nothing about the
 * drawing assumes a particular slice count — geometry, colouring, label length
 * and type size all derive from `layout.length`.
 */

import {burst} from "../lib/confetti.js";
import {labelBudget, labelFontSize, sliceColours} from "../core/wheel-data.js";
import {MODULE_ID, t} from "../core/constants.js";
import {
  S, allowGift, allowRefuse, backdrop, confettiEnabled, gmNeedsCredit, hubIcon,
  palette, reduceMotion, spinTurns, tickVolume, ticksEnabled, winSound
} from "../core/settings.js";
import {systemAdapter} from "../systems/adapter.js";

/**
 * Spins this client's user still has.
 *
 * Read straight off the world setting rather than through the ledger module, to
 * make plain that this is display only — the GM debits the real ledger before
 * it rolls, so a tampered client gains nothing by lying to itself here.
 */
function myCredits() {
  const ledger = game.settings.get(MODULE_ID, S.CREDITS) ?? {};
  return Number(ledger[game.user.id] ?? 0);
}

/** 0° is 12 o'clock, angles increase clockwise. */
function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return {x: cx + (r * Math.sin(rad)), y: cy - (r * Math.cos(rad))};
}

/** Annulus wedge path between two angles. */
function wedgePath(cx, cy, outer, inner, startAngle, sweep) {
  const end = startAngle + sweep;
  const large = sweep > 180 ? 1 : 0;
  const o1 = polar(cx, cy, outer, startAngle);
  const o2 = polar(cx, cy, outer, end);
  const i2 = polar(cx, cy, inner, end);
  const i1 = polar(cx, cy, inner, startAngle);
  return [
    `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
    `L ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    "Z"
  ].join(" ");
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
  return {r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255};
}

/** Perceived brightness, 0–1. */
function luminance(hex) {
  const {r, g, b} = hexToRgb(hex);
  return ((0.299 * r) + (0.587 * g) + (0.114 * b)) / 255;
}

function hexToHsl(hex) {
  const {r, g, b} = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return {h: 0, s: 0, l};
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d) + (gn < bn ? 6 : 0);
  else if (max === gn) h = ((bn - rn) / d) + 2;
  else h = ((rn - gn) / d) + 4;
  return {h: h * 60, s, l};
}

/**
 * Keep the rarity hue readable whatever slice it lands on.
 *
 * The inks are tuned for pale slices; on crimson and navy they vanish. Lifting
 * them by mixing toward white would work for contrast but desaturates the hue —
 * and then a rare item stops looking blue, which is the whole signal. Raising
 * lightness in HSL instead keeps the hue intact.
 */
function liftInk(ink, lightness = 74) {
  const {h, s} = hexToHsl(ink);
  // Near-grey inks (common) must stay grey; anything with real hue gets held at
  // a saturation high enough to survive the lightness lift.
  const sat = s < 0.15 ? s : Math.max(0.62, s);
  return `hsl(${h.toFixed(0)}, ${(sat * 100).toFixed(0)}%, ${lightness}%)`;
}

function inkFor(ink, background) {
  if (luminance(background) >= 0.5) {
    return {fill: ink, halo: "rgba(255, 255, 255, 0.9)"};
  }
  return {fill: liftInk(ink), halo: "rgba(0, 0, 0, 0.8)"};
}

/**
 * Decaying tick track, synthesized so the module ships no audio assets.
 *
 * The gap grows geometrically, which mirrors the visual ease-out closely enough
 * that the last tick lands about when the wheel stops.
 */
function tickTrack(durationMs) {
  if (!ticksEnabled()) return () => {};
  const volume = tickVolume();
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return () => {};
  }
  const timers = [];
  let elapsed = 0;
  let gap = 55;
  while (elapsed < durationMs - 120) {
    timers.push(window.setTimeout(() => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 900 + (Math.random() * 180);
      // 0.1 x the default 0.35 reproduces v1's fixed 0.035 gain exactly.
      gain.gain.setValueAtTime(0.1 * volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    }, elapsed));
    elapsed += gap;
    gap *= 1.085;
  }
  return () => {
    timers.forEach(id => window.clearTimeout(id));
    ctx.close?.();
  };
}

export class LootWheel {
  /** @type {LootWheel|null} The one wheel this client is showing. */
  static current = null;

  constructor(config) {
    this.config = config;
    this.root = null;
    this.stopConfetti = null;
    this.stopTicks = null;
    this.landed = null;
    this.state = "idle";
    /** Accumulated wheel rotation, so re-armed spins always turn forward. */
    this.rotation = 0;
    /** Set from the spin payload; who owns the keep/gift/refuse decision. */
    this.spinnerId = null;
    this.spinnerName = null;
    this.actorName = null;
  }

  /**
   * The look and rules this particular wheel is running under.
   *
   * A live wheel is handed both by the GM, already resolved against the table's
   * own overrides. A preview supplies its own. Anything absent falls back to the
   * world settings, which is what makes both cases work through one path.
   */
  get look() {
    return this.config.appearance ?? {};
  }

  get rules() {
    return this.config.rules ?? {};
  }

  /** True only while this client is the one whose spin is being resolved. */
  get isSpinner() {
    return game.user.id === this.spinnerId;
  }

  /**
   * A player must hold a credit. A GM normally need not, but a table that wants
   * the GM to play by the same rules can say so.
   */
  get canSpin() {
    if (game.user.isGM && !(this.rules.gmNeedsCredit ?? gmNeedsCredit())) return true;
    return myCredits() > 0;
  }

  /** Entry for a given slice index. */
  entryAt(slice) {
    return this.config.entries[this.config.layout[slice]];
  }

  /* ---------------------------------------- */
  /*  Lifecycle                               */
  /* ---------------------------------------- */

  static present(config) {
    LootWheel.current?.destroy();
    const wheel = new LootWheel(config);
    LootWheel.current = wheel;
    wheel.render();
    return wheel;
  }

  /**
   * Show a wheel to this client only, with a supplied look.
   *
   * Deliberately not a session: nothing is broadcast, no credit is spent, and
   * the spin button is replaced by a dismiss. It exists so a GM can answer
   * "does this actually look right" without putting a half-chosen theme on
   * five other screens.
   */
  static preview(config) {
    LootWheel.current?.destroy();
    const wheel = new LootWheel({...config, sessionId: "__preview__", preview: true});
    LootWheel.current = wheel;
    wheel.render();
    return wheel;
  }

  static spinTo(payload) {
    const wheel = LootWheel.current;
    if (!wheel || wheel.config.sessionId !== payload.sessionId) return;
    wheel.runSpin(payload);
  }

  /** Return an already-spun wheel to its resting state for the next spinner. */
  static rearm(sessionId) {
    const wheel = LootWheel.current;
    if (!wheel || wheel.config.sessionId !== sessionId) return;
    wheel.resetToIdle();
  }

  static dismiss(sessionId) {
    const wheel = LootWheel.current;
    if (!wheel || wheel.config.sessionId !== sessionId) return;
    wheel.destroy();
  }

  resetToIdle() {
    this.stopConfetti?.();
    this.stopConfetti = null;
    this.state = "idle";
    this.landed = null;
    this.spinnerId = null;
    const reveal = this.root?.querySelector(".wol-reveal");
    if (reveal) reveal.hidden = true;
    // Leave the wheel where it stopped; snapping back to 0° reads as a glitch.
    const rotor = this.root?.querySelector(".wol-rotor");
    if (rotor) rotor.style.transition = "none";
    this.#renderActions();
  }

  /** Re-render the spin affordance after the ledger changes. */
  refreshCredits() {
    if (this.state === "idle") this.#renderActions();
  }

  destroy() {
    this.stopConfetti?.();
    this.stopTicks?.();
    this.root?.remove();
    if (LootWheel.current === this) LootWheel.current = null;
  }

  /* ---------------------------------------- */
  /*  Rendering                               */
  /* ---------------------------------------- */

  render() {
    const root = document.createElement("div");
    root.className = "wol-overlay";
    if (this.config.preview) root.classList.add("wol-preview");
    // Drives the backdrop gradient, so the canvas can show through as much or
    // as little as the GM wants.
    const dim = this.look.backdrop ?? backdrop();
    root.style.setProperty("--wol-dim", String(dim));
    root.style.setProperty("--wol-blur", dim < 0.3 ? "0px" : "6px");
    root.innerHTML = `
      <canvas class="wol-confetti"></canvas>
      <div class="wol-stage">
        <header class="wol-head">
          <h1>${foundry.utils.escapeHTML(this.config.tableName)}</h1>
          <p class="wol-sub" data-role="sub"></p>
        </header>
        <div class="wol-wheelbox">
          ${this.#wheelSvg()}
          <div class="wol-pointer" aria-hidden="true"></div>
          <div class="wol-hub"><img alt="" src="${foundry.utils.escapeHTML(this.config.hubIcon ?? this.look.hubIcon ?? hubIcon())}"></div>
        </div>
        <footer class="wol-actions"></footer>
      </div>
      <div class="wol-reveal" hidden>
        <div class="wol-reveal-card">
          <img class="wol-reveal-img" alt="">
          <h2 class="wol-reveal-name"></h2>
          <p class="wol-reveal-rarity"></p>
          <div class="wol-reveal-desc"></div>
          <div class="wol-reveal-actions"></div>
        </div>
      </div>`;

    document.body.append(root);
    this.root = root;
    this.#renderActions();
  }

  #wheelSvg() {
    const {entries, layout} = this.config;
    const total = layout.length;
    const size = 900;
    const c = size / 2;
    const outer = 430;
    const inner = 118;
    const sweep = 360 / total;
    const backgrounds = sliceColours(total, this.config.palette ?? this.look.palette ?? palette());
    const budget = labelBudget(total);
    const fontSize = labelFontSize(total);

    const wedges = layout.map((entryIndex, slice) => {
      const entry = entries[entryIndex];
      const start = slice * sweep;
      const mid = start + (sweep / 2);
      const background = backgrounds[slice];
      const {fill, halo} = inkFor(entry.ink, background);

      // Names read radially, ending at the rim and running inward, which is the
      // only orientation that fits once slices get narrow.
      const flip = mid > 180;
      const p = polar(c, c, outer - 14, mid);
      const rotate = flip ? mid + 90 : mid - 90;
      const anchor = flip ? "start" : "end";
      const label = entry.name.length > budget ? `${entry.name.slice(0, budget - 1)}…` : entry.name;

      // Painted via inline `style`, not presentation attributes: a stylesheet
      // rule beats an SVG attribute, so `fill`/`text-anchor` set as attributes
      // are silently overridden by any `.wol-wedge text { … }` rule that happens
      // to be loaded. Inline style wins outright and keeps the rarity ink, the
      // radial anchoring and the size-dependent type intact whatever CSS is present.
      const style = `fill:${fill};stroke:${halo};text-anchor:${anchor};font-size:${fontSize}px`;

      return `
        <g class="wol-wedge${entry.jackpot ? " jackpot" : ""}">
          <path d="${wedgePath(c, c, outer, inner, start, sweep)}" style="fill:${background}" />
          <text x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" style="${style}"
            transform="rotate(${rotate.toFixed(2)} ${p.x.toFixed(1)} ${p.y.toFixed(1)})"
          >${foundry.utils.escapeHTML(label)}</text>
        </g>`;
    }).join("");

    return `
      <svg class="wol-wheel" viewBox="0 0 ${size} ${size}" role="img"
        aria-label="${foundry.utils.escapeHTML(t("Wheel.Aria", {count: total}))}">
        <g class="wol-rotor">
          ${wedges}
          <circle cx="${c}" cy="${c}" r="${outer}" class="wol-rim" />
          <circle cx="${c}" cy="${c}" r="${inner}" class="wol-rim wol-rim-inner" />
        </g>
      </svg>`;
  }

  /** Headline under the title: who still holds spins, or whose spin this is. */
  #renderSub() {
    const sub = this.root.querySelector("[data-role=sub]");
    if (!sub) return;
    if (this.config.preview) return;

    if (this.state !== "idle") {
      sub.innerHTML = t("Wheel.SpinsFor", {
        spinner: `<strong>${foundry.utils.escapeHTML(this.spinnerName ?? "")}</strong>`,
        actor: `<strong>${foundry.utils.escapeHTML(this.actorName ?? "")}</strong>`
      });
      return;
    }

    const ledger = game.settings.get(MODULE_ID, S.CREDITS) ?? {};
    const holders = Object.entries(ledger)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => {
        const name = game.users.get(id)?.name ?? t("Unknown");
        return `${foundry.utils.escapeHTML(name)} &times;${n}`;
      });

    sub.innerHTML = holders.length
      ? `${t("Wheel.SpinsRemaining")} ${holders.join(" &nbsp;·&nbsp; ")}`
      : `<em>${t("Wheel.NoSpinsGranted")}</em>`;
  }

  #renderActions() {
    this.#renderSub();
    const footer = this.root.querySelector(".wol-actions");
    footer.innerHTML = "";

    if (this.config.preview) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "wol-btn wol-btn-ghost";
      close.innerHTML = `<i class="fa-solid fa-xmark"></i> ${t("Setting.ClosePreview")}`;
      close.addEventListener("click", () => this.destroy(), {once: true});
      footer.append(close);
      const sub = this.root.querySelector("[data-role=sub]");
      if (sub) sub.innerHTML = `<em>${t("Setting.PreviewNote")}</em>`;
      return;
    }

    if (this.state === "idle") {
      const mine = myCredits();
      if (this.canSpin) {
        const spin = document.createElement("button");
        spin.type = "button";
        spin.className = "wol-btn wol-btn-spin";
        // A GM spins without spending anything, so show a badge that says so
        // rather than a misleading "0".
        const freeGM = game.user.isGM && !(this.rules.gmNeedsCredit ?? gmNeedsCredit());
      const badge = mine > 0 ? String(mine) : (freeGM ? t("Wheel.GMBadge") : "0");
        spin.innerHTML = `<i class="fa-solid fa-arrows-spin"></i> ${t("Wheel.Spin")}
          <span class="wol-credit">${badge}</span>`;
        spin.addEventListener("click", () => this.#onSpinClicked(spin), {once: true});
        footer.append(spin);
      } else {
        footer.innerHTML = `<p class="wol-wait">${t("Wheel.Watching")}</p>`;
      }
      // The GM always keeps an escape hatch, in case a player disconnects mid-wheel.
      if (game.user.isGM) footer.append(this.#cancelButton());
      return;
    }

    if (this.state === "spinning") {
      footer.innerHTML = `<p class="wol-wait">${t("Wheel.Spinning")}</p>`;
    }
  }

  #cancelButton() {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "wol-btn wol-btn-ghost";
    cancel.innerHTML = `<i class="fa-solid fa-ban"></i> ${t("Wheel.CloseForEveryone")}`;
    cancel.addEventListener("click", () => this.config.onCancel?.(this.config.sessionId), {once: true});
    return cancel;
  }

  /* ---------------------------------------- */
  /*  Spin                                    */
  /* ---------------------------------------- */

  async #onSpinClicked(button) {
    button.disabled = true;
    try {
      await this.config.onSpin(this.config.sessionId);
    } catch (err) {
      console.error("Wheel of Loot | spin request failed", err);
      ui.notifications.error(t("Notify.SpinFailed"));
      button.disabled = false;
    }
  }

  runSpin({slice, durationMs, spinnerId, spinnerName, actorName, actorId, hasActor}) {
    if (this.state !== "idle") return;
    this.state = "spinning";
    this.duration = durationMs ?? 6000;
    this.landedSlice = slice;
    this.landed = this.entryAt(slice);
    this.spinnerId = spinnerId;
    this.spinnerName = spinnerName;
    this.actorName = actorName;
    this.actorId = actorId ?? null;
    this.hasActor = hasActor !== false;
    this.#renderActions();

    const total = this.config.layout.length;
    const sweep = 360 / total;
    const rotor = this.root.querySelector(".wol-rotor");
    const centre = (slice * sweep) + (sweep / 2);
    // A small deterministic nudge inside the slice so repeat wins are not
    // pixel-identical, while staying well clear of the slice edges.
    const jitter = (this.#seededUnit(slice) - 0.5) * sweep * 0.5;

    // Rotation accumulates across spins on a re-armed wheel, so the target has
    // to be projected forward from wherever it stopped. Taking the raw angle
    // would sometimes be behind the current one and visibly rewind the wheel.
    const desired = ((((-centre + jitter) % 360) + 360) % 360);
    const currentMod = (((this.rotation % 360) + 360) % 360);
    let advance = desired - currentMod;
    if (advance < 0) advance += 360;
    const final = this.rotation + (360 * (this.rules.turns ?? spinTurns())) + advance;
    this.rotation = final;

    // A six-second rotation of a large object is exactly what reduced-motion
    // preferences exist for. Skip straight to the result, but keep a beat so it
    // still reads as an outcome rather than a glitch.
    if (reduceMotion()) {
      rotor.style.transition = "none";
      rotor.style.transform = `rotate(${final.toFixed(3)}deg)`;
      window.setTimeout(() => this.#onLanded(), 400);
      return;
    }

    this.stopTicks = tickTrack(this.duration);

    // One continuous motion, all the way to rest.
    //
    // An earlier version stopped a third of a slice short and then crept the
    // rest of the way in a second transition. It produced the near-miss beat,
    // but it produced it by *moving the wheel again after it had stopped* —
    // which is indistinguishable from someone nudging the result, and a prize
    // wheel that looks adjusted is worse than one with no drama at all.
    //
    // The tension comes from the easing instead. The second control point sits
    // hard against the end, so the last couple of degrees take an appreciable
    // share of the spin and the pointer visibly crawls toward the boundary —
    // the same feeling, produced by friction rather than by a correction.
    rotor.style.transition = `transform ${this.duration}ms cubic-bezier(0.14, 0.72, 0.02, 1)`;
    // Force a reflow so the transition applies from the current angle rather
    // than being collapsed into the same style recalculation.
    void rotor.getBoundingClientRect();
    rotor.style.transform = `rotate(${final.toFixed(3)}deg)`;

    window.setTimeout(() => this.#onLanded(), this.duration + 60);
  }

  /** Deterministic 0–1 from the slice, so every client jitters identically. */
  #seededUnit(value) {
    const x = Math.sin((value + 1) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  #onLanded() {
    if (this.state !== "spinning") return;
    this.state = "landed";
    this.stopTicks?.();

    const entry = this.landed;
    const jackpot = entry.jackpot === true;
    const reveal = this.root.querySelector(".wol-reveal");
    reveal.hidden = false;
    reveal.querySelector(".wol-reveal-img").src = entry.img;

    // The reveal card is dark, so the raw ink — tuned for the pale wheel
    // slices — would be all but invisible on it. Lift it the same way.
    const cardInk = liftInk(entry.ink, 68);

    const name = reveal.querySelector(".wol-reveal-name");
    name.textContent = entry.name;
    name.style.color = cardInk;

    let banner = reveal.querySelector(".wol-reveal-jackpot");
    if (jackpot && !banner) {
      banner = document.createElement("p");
      banner.className = "wol-reveal-jackpot";
      banner.textContent = t("Wheel.Jackpot");
      name.before(banner);
    } else if (!jackpot && banner) {
      banner.remove();
    }

    const rarity = reveal.querySelector(".wol-reveal-rarity");
    rarity.textContent = entry.isCoin
      ? t("Wheel.Coin")
      : (entry.rarity ? systemAdapter().rarityLabel(entry.rarity) : "");
    rarity.style.color = cardInk;

    const desc = reveal.querySelector(".wol-reveal-desc");
    desc.textContent = entry.description || "";
    desc.hidden = !entry.description;

    reveal.querySelector(".wol-reveal-card").classList.toggle("jackpot", jackpot);

    if (this.look.confetti ?? confettiEnabled()) {
      const canvas = this.root.querySelector(".wol-confetti");
      // A grand prize earns a bigger burst; anything less and the flourish
      // stops meaning anything.
      this.stopConfetti = burst(canvas, {originX: 0.5, originY: 0.42, count: jackpot ? 520 : 220});
    }
    this.#playWinSound();

    this.#renderRevealActions();
  }

  #renderRevealActions() {
    const box = this.root.querySelector(".wol-reveal-actions");
    box.innerHTML = "";

    if (this.isSpinner) {
      // A GM may spin without a character; then there is nowhere for Keep to
      // put it, so only Gift and Refuse make sense.
      if (this.hasActor) {
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "wol-btn wol-btn-accept";
        accept.innerHTML = `<i class="fa-solid fa-check"></i> ${t("Wheel.Keep")}`;
        accept.addEventListener("click", () => this.#resolve(true), {once: true});
        box.append(accept);
      }

      if (this.rules.allowGift ?? allowGift()) {
        const gift = document.createElement("button");
        gift.type = "button";
        gift.className = "wol-btn wol-btn-gift";
        gift.innerHTML = `<i class="fa-solid fa-gift"></i> ${t("Wheel.Gift")}`;
        gift.addEventListener("click", () => this.#onGift(gift));
        box.append(gift);
      }

      if (this.rules.allowRefuse ?? allowRefuse()) {
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "wol-btn wol-btn-reject";
        reject.innerHTML = `<i class="fa-solid fa-xmark"></i> ${t("Wheel.Refuse")}`;
        reject.addEventListener("click", () => this.#confirmReject(reject), {once: true});
        box.append(reject);
      }

      // Turning both off would leave the spinner holding a prize with no way
      // to take it, so Keep is forced back on when nothing else remains.
      if (!box.children.length) {
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "wol-btn wol-btn-accept";
        accept.innerHTML = `<i class="fa-solid fa-check"></i> ${t("Wheel.Keep")}`;
        accept.addEventListener("click", () => this.#resolve(true), {once: true});
        box.append(accept);
      }
      return;
    }

    box.innerHTML = `<p class="wol-wait">${
      t("Wheel.Deciding", {name: foundry.utils.escapeHTML(this.spinnerName ?? t("Wheel.TheSpinner"))})}</p>`;
    if (game.user.isGM) box.append(this.#cancelButton());
  }

  /**
   * Optional flourish when the wheel lands.
   *
   * Failure here must never block the reveal — an unplayable file is a cosmetic
   * problem, not a reason the prize should not appear.
   */
  #playWinSound() {
    const src = this.look.winSound ?? winSound();
    if (!src) return;
    try {
      foundry.audio.AudioHelper.play({src, volume: 0.7, autoplay: true, loop: false}, false);
    } catch (err) {
      console.warn("Wheel of Loot | could not play the win sound", err);
    }
  }

  /* ---------------------------------------- */
  /*  Resolution                              */
  /* ---------------------------------------- */

  /**
   * Hand the prize to somebody else's character.
   *
   * Only actors that actually belong to a player are offered — gifting into an
   * NPC or a stray actor is never what is meant — and the GM validates the
   * target again before anything is created.
   */
  async #onGift(button) {
    const targets = game.users
      .filter(u => !u.isGM && u.character && u.character.id !== this.actorId)
      .map(u => ({id: u.character.id, label: `${u.character.name} (${u.name})`}))
      .sort((a, b) => a.label.localeCompare(b.label));

    if (!targets.length) {
      ui.notifications.warn(t("Notify.NobodyToGift"));
      return;
    }

    const chosen = await foundry.applications.api.DialogV2.wait({
      window: {title: t("Wheel.GiftTitle", {item: this.landed.name}), icon: "fa-solid fa-gift"},
      content: `<div class="wol-form">
          <p class="hint">${t("Wheel.GiftHint", {
            item: `<strong>${foundry.utils.escapeHTML(this.landed.name)}</strong>`
          })}</p>
          <div class="form-group">
            <label for="wol-gift">${t("Wheel.GiftTo")}</label>
            <select id="wol-gift" name="target">
              ${targets.map(g => `<option value="${g.id}">${foundry.utils.escapeHTML(g.label)}</option>`).join("")}
            </select>
          </div>
        </div>`,
      position: {width: 420},
      buttons: [
        {
          action: "gift",
          label: t("Wheel.GiftIt"),
          icon: "fa-solid fa-gift",
          default: true,
          callback: (event, b) => b.form.elements.target.value
        },
        {action: "cancel", label: t("Cancel"), icon: "fa-solid fa-xmark"}
      ],
      rejectClose: false,
      modal: true
    });

    if (!chosen || chosen === "cancel") return;
    return this.#resolve(true, chosen);
  }

  async #confirmReject(button) {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: {title: t("Wheel.RefuseTitle")},
      content: `<p>${t("Wheel.RefuseBody", {
        item: `<strong>${foundry.utils.escapeHTML(this.landed.name)}</strong>`
      })}</p><p>${t("Wheel.RefuseWarning")}</p>`,
      modal: true
    });
    if (ok) return this.#resolve(false);
    button.addEventListener("click", () => this.#confirmReject(button), {once: true});
  }

  async #resolve(accepted, giftActorId = null) {
    if (this.state !== "landed") return;
    this.state = "resolving";
    const verb = !accepted ? t("Wheel.Declining") : (giftActorId ? t("Wheel.Gifting") : t("Wheel.Claiming"));
    this.root.querySelector(".wol-reveal-actions").innerHTML = `<p class="wol-wait">${verb}</p>`;
    try {
      await this.config.onResolve(this.config.sessionId, accepted, giftActorId);
    } catch (err) {
      console.error("Wheel of Loot | resolve failed", err);
      ui.notifications.error(t("Notify.ResolveFailed"));
      this.state = "landed";
      this.#renderRevealActions();
    }
  }
}
