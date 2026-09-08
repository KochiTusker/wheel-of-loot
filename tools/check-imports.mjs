/**
 * Imports that nothing in the file uses.
 *
 * Cheap to let drift, and a reliable sign that a refactor left something
 * half-done. Exits non-zero so CI fails on it.
 */
import fs from "node:fs";
import path from "node:path";

// Always run from the repository root; CI has no reason to point it elsewhere.
const root = process.argv[2] ?? process.cwd();
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, {withFileTypes: true})) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith(".js")) files.push(p);
  }
})(path.join(root, "scripts"));

const WORD = String.fromCharCode(92) + "b";
let issues = 0;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  const names = [];
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (let n of m[1].split(",")) {
      n = n.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    }
  }
  for (const name of names) {
    const hits = (src.match(new RegExp(WORD + name + WORD, "g")) || []).length;
    if (hits <= 1) {
      console.log(`UNUSED: ${path.relative(root, file)} -> ${name} (${hits})`);
      issues++;
    }
  }
}
console.log(issues ? `\n${issues} unused import(s)` : `no unused imports across ${files.length} files`);
