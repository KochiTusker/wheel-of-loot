/**
 * Capture the README's screenshots from a live world.
 *
 *   node tools/shoot.mjs [--url http://localhost:30000] [--user Claude] [--out docs/images]
 *
 * Documentation screenshots rot. The interface moves, the shots do not, and a
 * README ends up describing a version nobody is running. Making them
 * reproducible from one command is the only way that does not happen — rerun it
 * after a change and the pictures are current again.
 *
 * Drives a headless Chrome over the DevTools protocol rather than through any
 * automation library, because the repository has no dependencies and this is not
 * a good enough reason to start. Node's built-in WebSocket is enough.
 *
 * It joins as a real user, so it needs a Foundry world already running with a
 * **password-less GM** to sign in as. It only ever opens windows on its own
 * client: nothing is presented, broadcast, granted or saved, and the one wheel
 * it spins is a dry run.
 */
import {spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* -------------------------------------------- */
/*  Arguments                                   */
/* -------------------------------------------- */

const args = Object.fromEntries(
  process.argv.slice(2).join(" ").split("--").filter(Boolean)
    .map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(" ")])
);

const URL_BASE = args.url || "http://localhost:30000";
const USER = args.user || "Claude";
const OUT = args.out || "docs/images";
const PORT = Number(args.port || 9223);

/** Big enough that the builder is not cramped; 1.5x so the type stays crisp. */
const VIEW = {width: 1500, height: 950, scale: 1.5};

const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
];

/* -------------------------------------------- */
/*  A very small CDP client                     */
/* -------------------------------------------- */

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener("message", ev => {
      const msg = JSON.parse(ev.data);
      const pending = this.waiting.get(msg.id);
      if (!pending) return;
      this.waiting.delete(msg.id);
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params}));
      setTimeout(() => {
        if (!this.waiting.delete(id)) return;
        reject(new Error(`${method} timed out`));
      }, 180_000);
    });
  }

  /** Evaluate in the page and return the value. Top-level await is allowed. */
  async eval(expression) {
    const {result, exceptionDetails} = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "evaluate failed");
    return result.value;
  }

  async shot(file, clip = null) {
    const {data} = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      ...(clip ? {clip: {...clip, scale: VIEW.scale}} : {})
    });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  wrote ${file} (${kb} KB)`);
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * The bounds of one element, padded, for a cropped capture.
 *
 * A floating window shot full-screen is mostly battlemap. Cropping keeps the
 * picture about the thing it is illustrating and takes a megabyte off the
 * repository with it.
 */
async function bounds(tab, selector, pad = 28) {
  const r = await tab.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {x: b.left, y: b.top, width: b.width, height: b.height};
  `);
  if (!r) throw new Error(`nothing matched ${selector}`);
  return {
    x: Math.max(0, r.x - pad),
    y: Math.max(0, r.y - pad),
    width: r.width + pad * 2,
    height: r.height + pad * 2
  };
}

/**
 * Wait for something in the page to become true.
 *
 * Fixed waits were the wrong tool: the builder resolves every wedge's document
 * before a dry run can open, and on a loaded world over software rendering that
 * is comfortably slower than any number worth hard-coding.
 *
 * @param {Tab} tab
 * @param {string} expr   A JS expression, evaluated until it returns truthy.
 * @param {string} what   What is being waited for, for the error message.
 */
async function until(tab, expr, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tab.eval(`return !!(${expr})`).catch(() => false)) return true;
    await wait(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

const exe = BROWSERS.find(p => fs.existsSync(p));
if (!exe) {
  console.error("No Chrome or Edge found. Pass one in BROWSERS, or install Chrome.");
  process.exit(1);
}

fs.mkdirSync(OUT, {recursive: true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wol-shots-"));

console.log(`Launching ${path.basename(exe)} headless…`);
const chrome = spawn(exe, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${VIEW.width},${VIEW.height}`,
  // Foundry wants WebGL for the scene canvas; software rendering is fine here
  // and is the difference between a page that loads and one that does not.
  "--enable-unsafe-swiftshader",
  "--use-gl=swiftshader",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--mute-audio",
  "about:blank"
], {stdio: "ignore"});

let tab;
try {
  // Wait for the debugger to answer, then take the first page target.
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    await wait(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      targets = list.filter(t => t.type === "page");
      if (!targets.length) targets = null;
    } catch { /* not up yet */ }
  }
  if (!targets) throw new Error("the browser never opened a debugging port");

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, {once: true});
    ws.addEventListener("error", () => reject(new Error("could not attach to the tab")), {once: true});
  });
  tab = new Tab(ws);

  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false
  });

  console.log(`Joining ${URL_BASE} as ${USER}…`);
  await tab.send("Page.navigate", {url: `${URL_BASE}/join`});
  await wait(6000);

  const joined = await tab.eval(`
    const sel = document.querySelector('[name="userid"]');
    if (!sel) return "no join form — is a world running?";
    const opt = [...sel.options].find(o => o.textContent.trim() === ${JSON.stringify(USER)});
    if (!opt) return "no such user: " + ${JSON.stringify(USER)};
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", {bubbles: true}));
    sel.closest("form").querySelector('button[type="submit"]').click();
    return "ok";
  `);
  if (joined !== "ok") throw new Error(joined);

  // Foundry takes a while: packs, canvas, modules.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await wait(2000);
    ready = await tab.eval("return !!globalThis.game?.ready").catch(() => false);
  }
  if (!ready) throw new Error("the world never became ready");

  const info = await tab.eval(`
    const m = game.modules.get("wheel-of-loot");
    return {gm: game.user.isGM, active: !!m?.active, version: m?.version,
            wheels: game.tables.contents.filter(t => t.getFlag("wheel-of-loot", "isWheel")
              || [...t.results].some(r => (r.range?.[1] ?? 0) > 0)).map(t => ({id: t.id, name: t.name, n: t.results.size}))};
  `);
  if (!info.active) throw new Error("wheel-of-loot is not enabled in this world");
  if (!info.gm) throw new Error(`${USER} is not a GM`);
  console.log(`  in as a GM, module ${info.version}, ${info.wheels.length} wheel(s)`);

  // The fullest wheel makes the best picture.
  const target = info.wheels.sort((a, b) => b.n - a.n)[0];
  if (!target) throw new Error("this world has no wheels to photograph");
  console.log(`  using "${target.name}" (${target.n} wedges)`);

  const api = `game.modules.get("wheel-of-loot").api`;

  /**
   * Clear what only this client is showing.
   *
   * Headless Chrome has no GPU, so Foundry posts a hardware-acceleration
   * warning that sat across the top of every frame — an artefact of how the
   * picture was taken, not something a reader would ever see. The pause banner
   * is hidden the same way: in the DOM only, because toggling the world's pause
   * state would reach into the live game these pictures are being taken from.
   */
  const tidy = `
    document.querySelectorAll("#notifications > *").forEach(n => n.remove());
    const pause = document.querySelector("#pause");
    if (pause) pause.style.display = "none";
    document.querySelectorAll("#tooltip").forEach(n => n.classList.remove("active"));
  `;
  const closeAll = `
    const {WheelBuilder} = await import("/modules/wheel-of-loot/scripts/apps/wheel-builder.js");
    await WheelBuilder.current?.close();
    document.querySelectorAll('[id^="wheel-of-loot"]').forEach(n => n.remove());
    document.querySelector(".wol-overlay")?.remove();
    document.querySelectorAll("#tooltip").forEach(n => n.classList.remove("active"));
  `;

  /* ---- 1. The builder ---- */
  console.log("Shooting the builder…");
  await tab.eval(`${closeAll} await ${api}.build(game.tables.get("${target.id}"));`);
  await until(tab, `document.querySelector("#wheel-of-loot-builder [data-role=entries] li")`, "the builder");
  await wait(1200);
  await tab.eval(`
    ${tidy}
    const el = document.querySelector("#wheel-of-loot-builder");
    el.style.left = "40px"; el.style.top = "40px";
    el.style.width = "${VIEW.width - 80}px"; el.style.height = "${VIEW.height - 80}px";
    window.dispatchEvent(new Event("resize"));
  `);
  await wait(1500);
  await tab.eval(tidy);
  await tab.shot(path.join(OUT, "builder.png"));

  /* ---- 2. The wheel itself, waiting to be spun ---- */
  console.log("Shooting the wheel…");
  await tab.eval(`document.querySelector('[data-action="dryRun"]').click();`);
  // Resolving every wedge's document over a slow link is the long pole here.
  await until(tab, `document.querySelector(".wol-overlay .wol-wedge")`, "the dry run to draw a wheel", 150_000);
  await wait(1200);
  await tab.eval(`
    ${tidy}
    document.querySelector("#wheel-of-loot-builder").style.display = "none";
  `);
  await tab.shot(path.join(OUT, "wheel.png"));

  /* ---- 3. What winning looks like ---- */
  //
  // The dry run's card offers "Spin again" and "Close preview", which is not
  // what a player meets — they get Keep, Gift and Refuse. Showing the real one
  // needs a wheel in its live state, so this renders one directly.
  //
  // `LootWheel.present` only draws. It is the GM's *session* that broadcasts,
  // and no session is started here — so this is the genuine interface, built by
  // the module's own code from the real table, with nothing reaching the live
  // game: no socket call, no credit spent, no grant, no write.
  console.log("Shooting the reveal…");
  const landed = await tab.eval(`
    ${closeAll}
    const {buildEntries, disperseSlots} = await import("/modules/wheel-of-loot/scripts/core/wheel-data.js");
    const {resolveWheelConfig} = await import("/modules/wheel-of-loot/scripts/core/settings.js");
    const {slicesOf} = await import("/modules/wheel-of-loot/scripts/core/odds.js");
    const {LootWheel} = await import("/modules/wheel-of-loot/scripts/apps/wheel-app.js");

    const table = game.tables.get("${target.id}");
    const {entries, slots} = await buildEntries(table.results);
    const layout = disperseSlots(entries, slots, 20260908);
    const {appearance, rules} = resolveWheelConfig(table);

    // A prize that shows the card off: real art, a rarity worth printing, and
    // rules text to fill the description. Coin has none of the three.
    const ranked = entries.map((e, i) => ({i, e}));
    const best = ranked
      .filter(({e}) => e.uuid && e.description && e.rarity && e.name.length < 26)
      .sort((a, b) => b.e.description.length - a.e.description.length)[0]
      ?? ranked.find(({e}) => e.uuid);
    if (!best) return null;

    const wheel = LootWheel.present({
      sessionId: "__docs__", tableName: table.name, entries, layout, appearance, rules
    });

    // A real player and their character, so the card reads as a table sees it.
    const player = game.users.find(u => !u.isGM && u.character) ?? game.users.find(u => !u.isGM);
    wheel.runSpin({
      slice: slicesOf(layout, best.i)[0],
      durationMs: 700,
      spinnerId: game.user.id,
      spinnerName: player?.name ?? game.user.name,
      actorName: player?.character?.name ?? "",
      actorId: player?.character?.id ?? null,
      hasActor: !!player?.character
    });
    return {prize: best.e.name, spinner: player?.name, actor: player?.character?.name};
  `);
  if (!landed) throw new Error("no document-backed prize to photograph");
  console.log(`  landing on "${landed.prize}" for ${landed.actor ?? landed.spinner}`);
  await until(tab, `(() => { const r = document.querySelector(".wol-overlay .wol-reveal");
    return r && !r.hidden && r.querySelector(".wol-reveal-name")?.textContent; })()`,
    "the wheel to land");
  // Let the confetti and the card's own entrance settle before the shutter.
  await wait(1800);
  await tab.eval(tidy);
  await tab.shot(path.join(OUT, "reveal.png"));

  /* ---- 4. The manager ---- */
  console.log("Shooting the manager…");
  await tab.eval(`${closeAll} await ${api}.manage();`);
  await until(tab, `document.querySelector("#wheel-of-loot-manager .wol-m-row")`, "the manager");
  await wait(800);
  await tab.eval(`
    ${tidy}
    // Through the application, not the element: ApplicationV2 owns its own
    // geometry and reapplies it over anything written straight onto the style.
    const {WheelManager} = await import("/modules/wheel-of-loot/scripts/apps/wheel-manager.js");
    WheelManager.current?.setPosition({left: 300, top: 150, width: 900, height: 330});
  `);
  await wait(800);
  await tab.eval(tidy);
  await tab.shot(path.join(OUT, "manager.png"), await bounds(tab, "#wheel-of-loot-manager"));

  /* ---- 5. The settings ---- */
  console.log("Shooting the settings…");
  await tab.eval(`
    ${closeAll}
    const menu = [...game.settings.menus.values()].find(m => m.key?.startsWith("wheel-of-loot"));
    new menu.type().render({force: true});
  `);
  await until(tab, `document.querySelector("#wheel-of-loot-settings .wol-set-page")`, "the settings form");
  await wait(800);
  await tab.eval(`
    ${tidy}
    const el = document.querySelector("#wheel-of-loot-settings");
    el.style.left = "420px"; el.style.top = "120px"; el.style.height = "700px";
  `);
  await wait(800);
  await tab.eval(tidy);
  await tab.shot(path.join(OUT, "settings.png"), await bounds(tab, "#wheel-of-loot-settings"));

  await tab.eval(closeAll);
  console.log(`\nDone. ${fs.readdirSync(OUT).length} file(s) in ${OUT}.`);
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exitCode = 1;
} finally {
  chrome.kill();
  try { fs.rmSync(profile, {recursive: true, force: true}); } catch { /* Windows holds it briefly */ }
}
