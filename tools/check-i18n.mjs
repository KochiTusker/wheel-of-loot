/**
 * Localisation coverage, both ways: nothing referenced without a string, and no
 * string left behind that nothing references.
 *
 * Run from the module root.
 */
import fs from "node:fs";
import path from "node:path";

const lang = JSON.parse(fs.readFileSync("lang/en.json", "utf8"));
const have = new Set(Object.keys(lang).map(k => k.replace(/^WHEELOFLOOT\./, "")));

// Keys built by interpolation, which no static scan can see.
const dynamic = [
  "Use.", "Fault.", "Builder.Dupes.", "Setting.Tab.", "Palette.", "ChatCard.",
  "Theme.", "Motion.", "Undo.Fail.",
  "Builder.WarnRecharge", "Builder.WarnCharges", "Card.GiftedTo", "Card.ClaimedBy"
];

const used = new Set();

// Setting names and hints are derived from the LABELS map in settings.js rather
// than written out at each registration, so read that map and add both keys per
// entry. Deriving them here rather than ignoring "Setting.*" wholesale means a
// genuinely orphaned setting string is still reported.
{
  const src = fs.readFileSync("scripts/core/settings.js", "utf8");
  const from = src.indexOf("const LABELS = {");
  const map = src.slice(from, src.indexOf("};", from));
  for (const m of map.matchAll(/:\s*"([A-Za-z]+)"/g)) {
    used.add(`Setting.${m[1]}`);
    used.add(`Setting.${m[1]}Hint`);
  }
}

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, {withFileTypes: true})) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith(".js")) files.push(p);
  }
})("scripts");

for (const f of files) {
  const s = fs.readFileSync(f, "utf8");
  for (const m of s.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
  for (const m of s.matchAll(/"WHEELOFLOOT\.([^"]+)"/g)) used.add(m[1]);
  // Keys handed to a helper as a plain string argument.
  for (const m of s.matchAll(
    /"((?:Setting|Palette|ChatCard|Builder|Card|Control|Launcher|Notify|Wheel|Migrate|Fault|Use|Catalogue|Undo|Theme|Motion)\.[A-Za-z.]+)"/g
  )) used.add(m[1]);
}

const isDynamic = k => dynamic.some(d => k === d || k.startsWith(d));
const missing = [...used].filter(k => !have.has(k)).sort();
const unused = [...have].filter(k => !used.has(k) && !isDynamic(k)).sort();

console.log(`MISSING (${missing.length}): ${missing.join(", ") || "none"}`);
console.log(`UNUSED  (${unused.length}): ${unused.join(", ") || "none"}`);
console.log(`total keys: ${have.size}`);
process.exit(missing.length || unused.length ? 1 : 0);
