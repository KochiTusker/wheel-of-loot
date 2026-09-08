/**
 * Node test gate for the parts of the wheel that are pure arithmetic.
 *
 *   node test/run.mjs
 *
 * Everything under test here is deliberately free of Foundry globals, which is
 * why the interesting decisions — how slots divide, how repeats are spread, how
 * a wheel is coloured, what counts as a broken table — live in `core/` rather
 * than inside an Application. Anything needing `game` or the DOM is out of
 * scope and has to be exercised in a live world.
 */

// Installs the Foundry globals the pure modules touch. Imports hoist, so this
// has to come first.
import "./harness.mjs";

import {
  clampSlots, disperseSlots, labelBudget, labelFontSize, MAX_SLOTS, MIN_SLOTS,
  mulberry32, paletteCycle, sliceColours, slotCount, validateTable, WHEEL_PALETTE
} from "../scripts/core/wheel-data.js";
import {distributeSlots, drawDistinct, planWheel, rarityWeight} from "../scripts/core/wheel-plan.js";
import {GENERIC_ADAPTER} from "../scripts/systems/adapter.js";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? "assertion failed");
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ?? "not equal"} — got ${a}, wanted ${b}`);
}

/** Minimal stand-in for a RollTable, enough for slotCount and validateTable. */
function fakeTable(ranges, formula) {
  const results = ranges.map(([lo, hi], i) => ({range: [lo, hi], id: `r${i}`}));
  results.size = results.length;
  return {results, formula};
}

/* -------------------------------------------- */
/*  Slot arithmetic                             */
/* -------------------------------------------- */

check("clampSlots holds the range", () => {
  eq(clampSlots(64), 64);
  eq(clampSlots(0), MIN_SLOTS);
  eq(clampSlots(-5), MIN_SLOTS);
  eq(clampSlots(9999), MAX_SLOTS);
  eq(clampSlots("32"), 32);
  eq(clampSlots(31.6), 32, "rounds rather than truncates");
  eq(clampSlots(NaN), MIN_SLOTS);
  eq(clampSlots(undefined), MIN_SLOTS);
});

check("distributeSlots sums exactly and never starves a wedge", () => {
  for (const total of [12, 16, 24, 32, 48, 64, 96, 7, 101]) {
    for (let n = 1; n <= Math.min(total, 20); n++) {
      const weights = Array.from({length: n}, (_, i) => (i % 5) + 1);
      const counts = distributeSlots(total, weights);
      eq(counts.length, n, `wedge count for ${total}/${n}`);
      eq(counts.reduce((a, b) => a + b, 0), total, `sum for ${total}/${n}`);
      assert(counts.every(c => c >= 1), `every wedge >= 1 for ${total}/${n}`);
      assert(counts.every(Number.isInteger), `integers for ${total}/${n}`);
    }
  }
});

check("distributeSlots honours proportions", () => {
  // 3:1 over 64 slots, one slot reserved each: 62 shared 3:1 => 46.5 / 15.5,
  // largest remainder gives the extra to the first.
  const counts = distributeSlots(64, [3, 1]);
  eq(counts.reduce((a, b) => a + b, 0), 64);
  assert(counts[0] > counts[1] * 2, `heavier wedge should dominate, got ${counts}`);
});

check("distributeSlots treats all-zero weights as equal", () => {
  const counts = distributeSlots(12, [0, 0, 0, 0]);
  eq(counts, [3, 3, 3, 3]);
});

check("distributeSlots refuses an impossible split", () => {
  let threw = false;
  try { distributeSlots(3, [1, 1, 1, 1]); } catch { threw = true; }
  assert(threw, "4 wedges cannot fit in 3 slots");
});

check("distributeSlots handles the degenerate cases", () => {
  eq(distributeSlots(0, []), []);
  eq(distributeSlots(5, [1]), [5]);
});

/* -------------------------------------------- */
/*  Rarity weighting                            */
/* -------------------------------------------- */

check("rarityWeight favours the commonplace", () => {
  const rarities = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];
  assert(rarityWeight("common", rarities) > rarityWeight("legendary", rarities));
  eq(rarityWeight("common", rarities), 6);
  eq(rarityWeight("artifact", rarities), 1);
  // Unknown rarity sits mid-table rather than skewing the wheel either way.
  eq(rarityWeight("nonsense", rarities), 3);
  eq(rarityWeight(null, rarities), 3);
  // A system with no rarities at all produces a flat wheel.
  eq(rarityWeight("common", []), 1);
  eq(rarityWeight(null, undefined), 1);
});

/* -------------------------------------------- */
/*  Drawing                                     */
/* -------------------------------------------- */

const pool = Array.from({length: 40}, (_, i) => ({uuid: `u${i}`, name: `Item ${i}`, rarity: "common"}));

check("drawDistinct never repeats and respects exclusions", () => {
  const rng = mulberry32(7);
  const picked = drawDistinct(pool, 10, rng);
  eq(picked.length, 10);
  eq(new Set(picked.map(p => p.uuid)).size, 10, "all distinct");

  const exclude = new Set(["u0", "u1", "u2"]);
  const rest = drawDistinct(pool, 40, mulberry32(7), exclude);
  eq(rest.length, 37, "excluded rows are unavailable");
  assert(rest.every(r => !exclude.has(r.uuid)), "no excluded row drawn");
});

check("drawDistinct caps at the pool size", () => {
  eq(drawDistinct(pool, 999, mulberry32(1)).length, 40);
  eq(drawDistinct([], 5, mulberry32(1)).length, 0);
});

check("drawDistinct is deterministic for a given seed", () => {
  const a = drawDistinct(pool, 12, mulberry32(99)).map(r => r.uuid);
  const b = drawDistinct(pool, 12, mulberry32(99)).map(r => r.uuid);
  eq(a, b);
  const c = drawDistinct(pool, 12, mulberry32(100)).map(r => r.uuid);
  assert(JSON.stringify(a) !== JSON.stringify(c), "different seeds should differ");
});

check("planWheel fills the wheel exactly", () => {
  for (const total of [12, 24, 64, 37]) {
    const plan = planWheel(pool, {wedges: 8, total, seed: 5});
    eq(plan.reduce((a, p) => a + p.weight, 0), total, `total for ${total}`);
    eq(plan.length, 8, `wedges for ${total}`);
    eq(new Set(plan.map(p => p.row.uuid)).size, 8, "distinct prizes");
  }
});

check("planWheel clamps impossible requests instead of throwing", () => {
  // More wedges than slots, and more wedges than prizes.
  const tight = planWheel(pool, {wedges: 50, total: 10, seed: 1});
  eq(tight.length, 10);
  eq(tight.reduce((a, p) => a + p.weight, 0), 10);

  const small = planWheel(pool.slice(0, 3), {wedges: 20, total: 64, seed: 1});
  eq(small.length, 3);
  eq(small.reduce((a, p) => a + p.weight, 0), 64);

  eq(planWheel([], {wedges: 5, total: 64}), []);
});

check("planWheel by rarity gives commons the bigger share", () => {
  const rarities = ["common", "uncommon", "rare", "veryRare", "legendary", "artifact"];
  const mixed = [
    {uuid: "a", rarity: "common"},
    {uuid: "b", rarity: "artifact"}
  ];
  const plan = planWheel(mixed, {wedges: 2, total: 64, byRarity: true, rarities, seed: 3});
  const common = plan.find(p => p.row.rarity === "common");
  const artifact = plan.find(p => p.row.rarity === "artifact");
  assert(common.weight > artifact.weight, `common ${common.weight} should beat artifact ${artifact.weight}`);
  eq(plan.reduce((a, p) => a + p.weight, 0), 64);
});

/* -------------------------------------------- */
/*  Dispersion                                  */
/* -------------------------------------------- */

/** Build the entry shape disperseSlots wants from a list of counts. */
function entriesOf(counts) {
  return counts.map((count, i) => ({count, name: `e${i}`}));
}

check("disperseSlots preserves every weight exactly", () => {
  const counts = [16, 8, 8, 4, 4, 4, 4, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1];
  const total = counts.reduce((a, b) => a + b, 0);
  const layout = disperseSlots(entriesOf(counts), total, 42);
  eq(layout.length, total);
  assert(layout.every(i => i >= 0), "every slot claimed");
  const tally = new Array(counts.length).fill(0);
  layout.forEach(i => tally[i]++);
  eq(tally, counts, "weights survive the layout");
});

check("disperseSlots is deterministic for a seed", () => {
  const counts = [10, 6, 6, 4, 4, 2, 2];
  const total = counts.reduce((a, b) => a + b, 0);
  eq(disperseSlots(entriesOf(counts), total, 1234), disperseSlots(entriesOf(counts), total, 1234));
  assert(
    JSON.stringify(disperseSlots(entriesOf(counts), total, 1)) !==
    JSON.stringify(disperseSlots(entriesOf(counts), total, 2)),
    "different seeds should produce different wheels"
  );
});

check("disperseSlots keeps repeats apart", () => {
  // The whole point of the layout: three copies of one prize must not read as
  // one fat wedge. Adjacency is checked around the wrap too.
  const counts = [8, 8, 8, 8, 8, 8, 8, 8];
  const total = 64;
  const layout = disperseSlots(entriesOf(counts), total, 2024);
  let adjacent = 0;
  for (let i = 0; i < total; i++) {
    if (layout[i] === layout[(i + 1) % total]) adjacent++;
  }
  eq(adjacent, 0, "no two neighbouring slices share a prize");
});

check("disperseSlots survives 200 random weight shapes", () => {
  const rng = mulberry32(7);
  for (let trial = 0; trial < 200; trial++) {
    const total = 8 + Math.floor(rng() * 113);
    const wedges = 1 + Math.floor(rng() * Math.min(total, 24));
    const counts = distributeSlots(total, Array.from({length: wedges}, () => 1 + Math.floor(rng() * 5)));
    const layout = disperseSlots(entriesOf(counts), total, Math.floor(rng() * 1e9));
    assert(layout.length === total, `length for trial ${trial}`);
    assert(layout.every(i => i >= 0 && i < wedges), `in-range indices for trial ${trial}`);
    const tally = new Array(wedges).fill(0);
    layout.forEach(i => tally[i]++);
    eq(tally, counts, `weights for trial ${trial}`);
  }
});

/* -------------------------------------------- */
/*  Colouring and labels                        */
/* -------------------------------------------- */

check("sliceColours never repeats across a boundary, at any size", () => {
  for (let total = MIN_SLOTS; total <= MAX_SLOTS; total++) {
    const colours = sliceColours(total);
    eq(colours.length, total, `length at ${total}`);
    for (let i = 0; i < total; i++) {
      const next = (i + 1) % total;
      if (total === 2 && i === 1) continue; // a two-slice wheel wraps onto itself
      assert(colours[i] !== colours[next], `adjacent match at ${total} slices, slot ${i}`);
    }
    assert(colours.every(c => WHEEL_PALETTE.includes(c)), `palette respected at ${total}`);
  }
});

check("paletteCycle picks the largest clean divisor", () => {
  eq(paletteCycle(64), 4);
  eq(paletteCycle(12), 4);
  eq(paletteCycle(18), 3);
  eq(paletteCycle(14), 2);
  eq(paletteCycle(13), 4, "a prime has no clean cycle; the seam is repaired instead");
});

check("label budget and type size shrink as the wheel fills", () => {
  const sizes = [12, 16, 24, 32, 48, 64, 96, 120];
  for (let i = 1; i < sizes.length; i++) {
    assert(labelBudget(sizes[i]) <= labelBudget(sizes[i - 1]), `budget at ${sizes[i]}`);
    assert(labelFontSize(sizes[i]) <= labelFontSize(sizes[i - 1]), `font at ${sizes[i]}`);
  }
  assert(labelFontSize(MAX_SLOTS) > 0, "type never vanishes");
});

/* -------------------------------------------- */
/*  Table validation                            */
/* -------------------------------------------- */

check("validateTable accepts a well-formed wheel", () => {
  eq(validateTable(fakeTable([[1, 32], [33, 64]], "1d64")), []);
});

check("validateTable catches an empty table", () => {
  const faults = validateTable(fakeTable([], "1d64"));
  eq(faults.map(f => f.code), ["Empty"]);
});

check("validateTable catches gaps and overlaps", () => {
  const gapped = validateTable(fakeTable([[1, 10], [12, 20]], "1d20"));
  eq(gapped.map(f => f.code), ["Gaps"]);
  eq(gapped[0].data, {count: 1, first: 11});

  const overlapped = validateTable(fakeTable([[1, 10], [10, 20]], "1d20"));
  eq(overlapped.map(f => f.code), ["Overlaps"]);
  eq(overlapped[0].data.first, 10);
});

check("validateTable catches a formula that does not match the slots", () => {
  eq(validateTable(fakeTable([[1, 64]], "1d100")).map(f => f.code), ["FormulaHigh"]);
  const low = validateTable(fakeTable([[1, 64]], "1d20"));
  eq(low.map(f => f.code), ["FormulaLow"]);
  eq(low[0].data, {faces: 20, slots: 64, from: 21});
});

check("slotCount reads the highest covered slot", () => {
  eq(slotCount(fakeTable([[1, 10], [11, 24]])), 24);
  eq(slotCount(fakeTable([])), 0);
});

/* -------------------------------------------- */
/*  Generic system adapter                      */
/* -------------------------------------------- */

check("generic parseCurrency reads coin wedges", () => {
  eq(GENERIC_ADAPTER.parseCurrency("250 gp"), {denom: "gp", amount: 250});
  eq(GENERIC_ADAPTER.parseCurrency("1,000 gold"), {denom: "gp", amount: 1000});
  eq(GENERIC_ADAPTER.parseCurrency("50 silver"), {denom: "sp", amount: 50});
  eq(GENERIC_ADAPTER.parseCurrency("  12  pp  "), {denom: "pp", amount: 12});
  eq(GENERIC_ADAPTER.parseCurrency("Potion of Healing"), null);
  eq(GENERIC_ADAPTER.parseCurrency("0 gp"), null, "a payout of nothing is not a payout");
  eq(GENERIC_ADAPTER.parseCurrency(""), null);
  eq(GENERIC_ADAPTER.parseCurrency(undefined), null);
});

check("generic adapter answers safely with no system knowledge", () => {
  eq(GENERIC_ADAPTER.rarityOf({system: {rarity: "rare"}}), null);
  eq(GENERIC_ADAPTER.useProfile({system: {uses: {max: 3}}}), "single");
  eq(GENERIC_ADAPTER.rarities, []);
  eq(GENERIC_ADAPTER.tracksUses, false);
  eq(GENERIC_ADAPTER.descriptionOf({system: {description: {value: "<p>Hi</p>"}}}), "<p>Hi</p>");
  eq(GENERIC_ADAPTER.descriptionOf({system: {notes: "plain"}}), "plain");
  eq(GENERIC_ADAPTER.descriptionOf({system: {}}), "");
});

/* -------------------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach(f => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`\n${passed} checks passed.\n`);
