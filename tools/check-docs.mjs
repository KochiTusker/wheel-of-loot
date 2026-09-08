/**
 * Every relative link and image in the documentation resolves.
 *
 * The README is the module's shopfront and it is now mostly pictures and
 * cross-references. A broken image renders as a torn-page icon on the package
 * listing and a dead link goes nowhere quietly, and neither fails any other
 * check — the module works perfectly with a README full of holes.
 *
 * Only relative targets are checked. External URLs are somebody else's uptime.
 *
 *   node tools/check-docs.mjs
 *
 * Run from the module root.
 */
import fs from "node:fs";
import path from "node:path";

/** Every markdown file in the repository, excluding anything ignored. */
function markdown(dir = ".", found = []) {
  for (const f of fs.readdirSync(dir, {withFileTypes: true})) {
    if (f.name.startsWith(".") || f.name === "node_modules") continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) markdown(p, found);
    else if (f.name.endsWith(".md")) found.push(p);
  }
  return found;
}

const files = markdown();
const broken = [];
let checked = 0;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  // ![alt](target) and [text](target), skipping reference and inline-code forms.
  for (const m of src.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    checked++;
    // A link may carry an anchor; the file is what has to exist.
    const rel = decodeURIComponent(target.split("#")[0]);
    if (!rel) continue;
    const resolved = path.resolve(path.dirname(file), rel);
    if (!fs.existsSync(resolved)) broken.push({file, target});
  }
}

console.log(`DOCS    ${checked} relative link(s) across ${files.length} file(s), ${broken.length} broken`);
for (const b of broken) console.log(`  ✗ ${b.file} → ${b.target}`);
if (broken.length) process.exit(1);
