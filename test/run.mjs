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
import {installSettingsStub} from "./harness.mjs";

import {
  clampSlots, disperseSlots, labelBudget, labelFontSize, MAX_SLOTS, MIN_SLOTS,
  mulberry32, paletteCycle, sliceColours, SLOT_PRESETS, slotCount, validateTable, WHEEL_PALETTE
} from "../scripts/core/wheel-data.js";
import {distributeSlots, drawDistinct, planWheel, rarityWeight} from "../scripts/core/wheel-plan.js";
import {GENERIC_ADAPTER} from "../scripts/systems/adapter.js";
import {
  annotateDuplicates, completeness, duplicateStats, foldDuplicates,
  normaliseName, printingSignature, redundancySignature
} from "../scripts/core/dedupe.js";
import {
  PALETTES, allowGift, allowRefuse, autoClose, chatCardMode, coinDenomination, coinPresets,
  confettiEnabled, defaultSlots, gmNeedsCredit, hubIcon, palette, parseNumberList, parsePalette,
  registerSettings, spinDuration, spinTurns, tickVolume, ticksEnabled, winSound
} from "../scripts/core/settings.js";

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
/*  Settings parsing                            */
/* -------------------------------------------- */

check("parsePalette accepts what a GM would plausibly type", () => {
  eq(parsePalette("#C1272D, #F4EAD2, #1F3A93"), ["#C1272D", "#F4EAD2", "#1F3A93"]);
  eq(parsePalette("C1272D F4EAD2"), ["#C1272D", "#F4EAD2"], "hashes are optional");
  eq(parsePalette("#abc, #DEF"), ["#abc", "#DEF"], "three-digit hex is valid");
  eq(parsePalette("#C1272D\n#F4EAD2"), ["#C1272D", "#F4EAD2"], "newlines separate too");
  // One typo costs that colour, not the whole theme.
  eq(parsePalette("#C1272D, nonsense, #1F3A93"), ["#C1272D", "#1F3A93"]);
  eq(parsePalette(""), []);
  eq(parsePalette(undefined), []);
  eq(parsePalette("#12345"), [], "five digits is not a hex colour");
});

check("every built-in palette is usable", () => {
  for (const [name, colours] of Object.entries(PALETTES)) {
    assert(colours.length >= 2, name + " needs at least two colours");
    eq(parsePalette(colours.join(",")), colours, name + " round-trips through the parser");
  }
});

check("parseNumberList tolerates real input", () => {
  eq(parseNumberList("10, 25, 50"), [10, 25, 50]);
  eq(parseNumberList("50 10 25"), [10, 25, 50], "sorted ascending");
  eq(parseNumberList("10, 10, 25"), [10, 25], "deduplicated");
  eq(parseNumberList("10, -5, 0, abc, 25"), [10, 25], "junk and non-positives dropped");
  eq(parseNumberList(""), []);
  eq(parseNumberList("1 2 3 4 5 6 7 8 9 10 11 12 13 14").length, 12, "capped");
});

/* -------------------------------------------- */
/*  Duplicate handling                          */
/* -------------------------------------------- */

check("normaliseName folds the differences that do not mean anything", () => {
  eq(normaliseName("Potion of Healing"), normaliseName("  potion  of   healing "));
  eq(normaliseName("Mariner's Armor"), normaliseName("Mariner’s Armor"), "curly apostrophes");
  eq(normaliseName("Half-Plate"), normaliseName("Half‐Plate"), "different dashes");
  // But genuinely different names must stay different.
  assert(normaliseName("Potion of Healing") !== normaliseName("Potion of Greater Healing"));
  eq(normaliseName(undefined), "");
});

/** A world shaped like one with several imported books. */
function duplicateWorld() {
  return [
    // Four printings of one item, all genuinely different.
    {uuid: "a1", name: "Dust of Dryness", source: "DMG 2014", rarity: "uncommon", price: 200, itemType: "consumable", usesMax: 1,  img: "art.webp", packId: "ddb"},
    {uuid: "a2", name: "Dust of Dryness", source: "DMG 2024", rarity: "uncommon", price: 250, itemType: "consumable", usesMax: 1,  img: "art.webp", packId: "ddb"},
    {uuid: "a3", name: "Dust of Dryness", source: "SRD 5.1",  rarity: "uncommon", price: 200, itemType: "consumable", usesMax: 10, img: "art.webp", packId: "srd"},
    {uuid: "a4", name: "dust of dryness", source: "SRD 5.2",  rarity: "uncommon", price: 200, itemType: "consumable", usesMax: 10, img: "art.webp", packId: "srd2"},
    // A true redundant pair: same printing, same pack, listed twice.
    {uuid: "b1", name: "Potion of Healing", source: "SRD 5.1", rarity: "common", price: 50, itemType: "consumable", usesMax: 1, img: "art.webp", packId: "srd"},
    {uuid: "b2", name: "Potion of Healing", source: "SRD 5.1", rarity: "common", price: 50, itemType: "consumable", usesMax: 1, img: "art.webp", packId: "srd"},
    // A lone item with nothing to confuse it with.
    {uuid: "c1", name: "Boots of Speed", source: "DMG 2014", rarity: "rare", price: 4000, itemType: "equipment", usesMax: null, img: "art.webp", packId: "ddb"}
  ];
}

check("redundancy is the same printing in the same pack, nothing wider", () => {
  const rows = annotateDuplicates(duplicateWorld());
  const by = id => rows.find(r => r.uuid === id);
  // The two SRD Potions of Healing are the only true redundancy here.
  assert(by("b1").redundant && by("b2").redundant, "the identical pair is redundant");
  // Reprints across books are NOT duplicates, even inside one compendium.
  assert(!by("a1").redundant && !by("a2").redundant, "different books are not redundant");
  assert(!by("a3").redundant && !by("a4").redundant, "different packs are not redundant");
  assert(!by("c1").redundant, "a lone item is never redundant");
});

check("case and whitespace differences still group as one item", () => {
  const rows = annotateDuplicates(duplicateWorld());
  eq(rows.find(r => r.uuid === "a4").variants, 4, "lowercase copy joins its group");
  eq(rows.find(r => r.uuid === "a1").variants, 4);
});

check("hiding exact duplicates removes one row and only one", () => {
  const rows = annotateDuplicates(duplicateWorld());
  const folded = foldDuplicates(rows, "redundant");
  eq(folded.length, rows.length - 1, "exactly the redundant copy goes");
  const kept = folded.map(r => r.uuid);
  for (const id of ["a1", "a2", "a3", "a4"]) {
    assert(kept.includes(id), "printing " + id + " must survive");
  }
  eq(folded.filter(r => normaliseName(r.name) === "potion of healing").length, 1);
});

check("one row per item collapses variants without losing them", () => {
  const rows = annotateDuplicates(duplicateWorld());
  const folded = foldDuplicates(rows, "name");
  eq(folded.length, 3, "three distinct items");
  const dust = folded.find(r => normaliseName(r.name) === "dust of dryness");
  eq(dust.group.length, 4, "all four printings are still reachable");
  // The representative is the most complete record, not an arbitrary one.
  eq(dust.group[0].score, Math.max(...dust.group.map(g => g.score)));
  eq(folded.find(r => normaliseName(r.name) === "potion of healing").group.length, 2);
});

check("showing every copy changes nothing", () => {
  const rows = annotateDuplicates(duplicateWorld());
  eq(foldDuplicates(rows, "all").length, rows.length);
  eq(foldDuplicates(rows, "all").map(r => r.uuid), rows.map(r => r.uuid), "order preserved");
});

check("folding works with no source or rarity data at all", () => {
  // A system with no rarities and no source books still has to group sensibly.
  const bare = annotateDuplicates([
    {uuid: "x1", name: "Rope", source: "", rarity: null, price: null, itemType: "gear", img: "", packId: "p"},
    {uuid: "x2", name: "Rope", source: "", rarity: null, price: null, itemType: "gear", img: "", packId: "p"},
    {uuid: "x3", name: "Torch", source: "", rarity: null, price: null, itemType: "gear", img: "", packId: "p"}
  ]);
  eq(foldDuplicates(bare, "redundant").length, 2, "the identical Rope pair collapses");
  eq(foldDuplicates(bare, "name").length, 2, "two distinct names");
});

check("completeness prefers the richer record", () => {
  const rich = {rarity: "rare", price: 100, source: "DMG", img: "art.webp", usesMax: 1};
  const stub = {rarity: null, price: null, source: "", img: "icons/svg/item-bag.svg", usesMax: null};
  assert(completeness(rich) > completeness(stub));
  eq(completeness(stub), 0);
});

check("printing and redundancy signatures differ only by pack", () => {
  const a = {name: "X", source: "B", rarity: "rare", price: 1, itemType: "t", packId: "p1"};
  const b = {...a, packId: "p2"};
  eq(printingSignature(a), printingSignature(b), "same printing, different shelf");
  assert(redundancySignature(a) !== redundancySignature(b), "but not redundant copies");
});

check("duplicateStats describes the world honestly", () => {
  const stats = duplicateStats(annotateDuplicates(duplicateWorld()));
  eq(stats.total, 7);
  eq(stats.distinct, 3, "three distinct items");
  eq(stats.multiSource, 2, "Dust and Potion both appear more than once");
  eq(stats.redundant, 1, "one row could be hidden with nothing lost");
});


/* -------------------------------------------- */
/*  Regression guard: v1 behaviour               */
/* -------------------------------------------- */

/**
 * Every setting added in 2.0 has a default that reproduces exactly what the
 * module did before it had any settings at all.
 *
 * This is the promise that upgrading changes nothing until you choose to change
 * something, so it is pinned here rather than left to inspection. A default
 * drifting is a silent behaviour change in somebody's live game.
 */
check("every 2.0 default reproduces v1 behaviour", () => {
  const registered = new Map();
  const menus = [];
  installSettingsStub(registered, menus);

  registerSettings(function FakeMenu() {}, SLOT_PRESETS);

  // The wheel looked and behaved like this before any of it was configurable.
  eq(palette(), ["#C1272D", "#F4EAD2", "#1F3A93", "#E8B31F"], "v1 fairground palette");
  eq(hubIcon(), "icons/svg/chest.svg", "v1 hub art");
  eq(confettiEnabled(), true, "v1 always fired confetti");
  eq(spinDuration(), 6000, "v1 spun for 6 seconds");
  eq(spinTurns(), 6, "v1 TURNS constant");
  eq(ticksEnabled(), true, "v1 always ticked");
  // v1 set the oscillator gain to a fixed 0.035, and the wheel multiplies by 0.1.
  // Compared with a tolerance because 0.35 * 0.1 is not exactly 0.035 in binary
  // floating point - the difference is far below anything audible.
  assert(Math.abs((tickVolume() * 0.1) - 0.035) < 1e-9, "v1 tick loudness");
  eq(winSound(), "", "v1 played no landing sound");
  eq(allowGift(), true, "v1 always offered Gift");
  eq(allowRefuse(), true, "v1 always offered Refuse");
  eq(gmNeedsCredit(), false, "v1 let the GM spin freely");
  eq(autoClose(), true, "v1 closed the wheel once spins ran out");
  eq(chatCardMode(), "public", "v1 posted the card to everyone");
  eq(defaultSlots(), 64, "v1 was a 64-slot wheel");
  eq(coinPresets(), [10, 25, 50, 100, 250, 500, 1000], "v1 coin presets");
  eq(coinDenomination(), "gp", "v1 wrote coin wedges in gp");

  // The menu must be GM-only; these are world settings.
  eq(menus.length, 1, "one settings menu");
  eq(menus[0].restricted, true, "restricted to GMs");
});

check("a 64-slot wheel still draws exactly as it did in v1", () => {
  // v1 hard-coded a 4-colour cycle and a 15px label, and truncated at 34 chars.
  eq(labelFontSize(64), 15, "v1 wedge type size");
  eq(labelBudget(64), 34, "v1 truncation point");
  eq(paletteCycle(64), 4, "v1 four-colour alternation");
  const colours = sliceColours(64, ["#C1272D", "#F4EAD2", "#1F3A93", "#E8B31F"]);
  // v1 was literally WHEEL_PALETTE[slice % 4]; the new code must agree at 64.
  const v1 = Array.from({length: 64}, (_, i) => ["#C1272D", "#F4EAD2", "#1F3A93", "#E8B31F"][i % 4]);
  eq(colours, v1, "identical slice colours at 64");
});

check("a custom palette that cannot work falls back rather than breaking", () => {
  const registered = new Map();
  installSettingsStub(registered, []);
  registerSettings(function FakeMenu() {}, SLOT_PRESETS);

  registered.set("palette", "custom");
  registered.set("paletteCustom", "");
  eq(palette(), PALETTES.fairground, "empty custom falls back");

  registered.set("paletteCustom", "#ff0000");
  eq(palette(), PALETTES.fairground, "one colour cannot alternate");

  registered.set("paletteCustom", "not, a, colour");
  eq(palette(), PALETTES.fairground, "junk falls back");

  registered.set("paletteCustom", "#ff0000, #00ff00");
  eq(palette(), ["#ff0000", "#00ff00"], "two valid colours are honoured");

  registered.set("palette", "nonexistent-theme");
  eq(palette(), PALETTES.fairground, "an unknown named palette falls back");
});

check("coin and slot settings refuse to produce nonsense", () => {
  const registered = new Map();
  installSettingsStub(registered, []);
  registerSettings(function FakeMenu() {}, SLOT_PRESETS);

  registered.set("coinPresets", "");
  eq(coinPresets(), [10, 25, 50, 100, 250, 500, 1000], "empty list falls back to the default");

  registered.set("coinPresets", "junk, -4, 0");
  eq(coinPresets(), [10, 25, 50, 100, 250, 500, 1000], "all-invalid falls back too");

  registered.set("coinPresets", "5, 10");
  eq(coinPresets(), [5, 10], "a valid list is honoured");

  registered.set("coinDenomination", "  SP  ");
  eq(coinDenomination(), "sp", "trimmed and lowercased");

  registered.set("coinDenomination", "");
  eq(coinDenomination(), "gp", "blank falls back to gp");

  registered.set("tickVolume", 99);
  eq(tickVolume(), 1, "volume is clamped");
  registered.set("tickVolume", -5);
  eq(tickVolume(), 0, "volume is clamped");
  registered.set("tickVolume", "loud");
  eq(tickVolume(), 0.35, "unparseable volume falls back");
});

/* -------------------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach(f => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log(`\n${passed} checks passed.\n`);
