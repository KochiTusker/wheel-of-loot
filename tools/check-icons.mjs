/**
 * Every core Foundry icon the module names must actually exist.
 *
 * The module deliberately ships no artwork of its own: hub icons, the coin
 * wedge and the default prize art are all paths into Foundry's bundled `icons/`
 * tree. That keeps the download small and sidesteps every licensing question,
 * but it moves the risk somewhere silent — a mistyped filename does not throw,
 * it renders a broken-image box on a wheel in front of five players, and only
 * at the moment somebody wins that prize.
 *
 * Exactly that happened once: `scroll-bound-blue.webp` looked plausible and
 * does not exist. This is the check that would have caught it.
 *
 * Needs a Foundry installation to check against, so it reports SKIPPED rather
 * than failing where there is none — CI runners have no Foundry, and a gate
 * that cannot run is not a reason to fail a build.
 *
 *   node tools/check-icons.mjs [path-to-foundry-public-dir]
 *
 * Also honours FOUNDRY_PUBLIC. Run from the module root.
 */
import fs from "node:fs";
import path from "node:path";

const CANDIDATES = [
  process.argv[2],
  process.env.FOUNDRY_PUBLIC,
  "C:/Program Files/Foundry Virtual Tabletop/resources/app/public",
  "/Applications/FoundryVTT.app/Contents/Resources/app/public",
  "/opt/foundryvtt/resources/app/public"
].filter(Boolean);

const root = CANDIDATES.find(dir => fs.existsSync(path.join(dir, "icons")));

/** Every "icons/..." literal the module names. */
function referenced() {
  const found = new Map();
  (function walk(dir) {
    for (const f of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { walk(p); continue; }
      if (!/\.(js|json|css)$/.test(f.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/["'`](icons\/[^"'`\s]+\.(?:webp|svg|png|jpg|jpeg))["'`]/g)) {
        if (!found.has(m[1])) found.set(m[1], p);
      }
    }
  })(".");
  return found;
}

const paths = referenced();

if (!root) {
  console.log(`ICONS   SKIPPED (${paths.size} referenced): no Foundry installation found.`);
  console.log("        Pass one as an argument or set FOUNDRY_PUBLIC to check them.");
  process.exit(0);
}

const missing = [...paths].filter(([p]) => !fs.existsSync(path.join(root, p)));

console.log(`ICONS   ${paths.size} referenced, ${missing.length} missing (against ${root})`);
for (const [p, where] of missing) console.log(`  ✗ ${p}  — named in ${where}`);
if (missing.length) process.exit(1);
