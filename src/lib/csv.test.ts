import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGuestList, normGroupKey, normalizePref } from "./csv";

test("groups rows sharing a party name, sums size, collects members", () => {
  const csv = [
    "name,size,party,section",
    "Alice Chen,2,Chen Family,front",
    "Bob Chen,4,Chen Family,front",
    "Dara Osei,3,Osei,middle",
  ].join("\n");
  const { groups, errors, warnings } = parseGuestList(csv);
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 0);
  assert.equal(groups.length, 2);
  const chen = groups.find((g) => g.name === "Chen Family")!;
  assert.equal(chen.size, 6);
  assert.equal(chen.pref, "front");
  assert.deepEqual(
    chen.members.map((m) => m.name),
    ["Alice Chen", "Bob Chen"],
  );
});

test("rows with no party column are each their own group", () => {
  const csv = ["name,size,section", "Solo Guest,2,"].join("\n");
  const { groups } = parseGuestList(csv);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pref, "any");
});

test("distinct party names that share letters after digit/punctuation stripping stay separate (regression)", () => {
  // Historical bug: the old letters-only norm() collapsed "Tom Lemmons" and
  // "Tom Lemmons 2" into the same key, silently merging two unrelated
  // parties and producing a bogus "mixed section requests" warning.
  const csv = [
    "name,size,party,section",
    "Tom Lemmons,4,Tom Lemmons,middle",
    "Jane Lemmons,2,Tom Lemmons,middle",
    "Pat Lemmons,3,Tom Lemmons 2,back",
    "Sam Lemmons,2,Tom Lemmons 2,back",
  ].join("\n");
  const { groups, warnings } = parseGuestList(csv);
  assert.equal(warnings.length, 0);
  assert.equal(groups.length, 2);
  const tom = groups.find((g) => g.name === "Tom Lemmons")!;
  const tom2 = groups.find((g) => g.name === "Tom Lemmons 2")!;
  assert.equal(tom.size, 6);
  assert.equal(tom.pref, "middle");
  assert.equal(tom2.size, 5);
  assert.equal(tom2.pref, "back");
});

test("a header literally named 'Placement' is detected as the section column (regression)", () => {
  // The user's real-world CSVs use "Guest Name / Party Size / Party Name /
  // Placement" as headers — "Placement" must resolve to the section column,
  // not fall back to a positional guess.
  const csv = [
    "Guest Name,Party Size,Party Name,Placement",
    "Alice Chen,2,Chen Family,Front",
    "Bob Chen,4,Chen Family,Front",
    "Dara Osei,3,Osei,no preference",
  ].join("\n");
  const { groups, errors } = parseGuestList(csv);
  assert.equal(errors.length, 0);
  const chen = groups.find((g) => g.name === "Chen Family")!;
  const osei = groups.find((g) => g.name === "Osei")!;
  assert.equal(chen.pref, "front");
  assert.equal(osei.pref, "any");
});

test("mixed section requests within one party resolve by majority and warn", () => {
  const csv = [
    "name,size,party,section",
    "A,1,Group,front",
    "B,1,Group,front",
    "C,1,Group,back",
  ].join("\n");
  const { groups, warnings } = parseGuestList(csv);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].pref, "front");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /mixed section requests/);
});

test("rows missing a name or a valid size are skipped with an error, not silently dropped", () => {
  const csv = ["name,size,section", ",2,front", "Nony,abc,front", "Good,3,back"].join("\n");
  const { groups, errors } = parseGuestList(csv);
  assert.equal(groups.length, 1);
  assert.equal(errors.length, 2);
});

test("normGroupKey normalizes case/whitespace but preserves digits", () => {
  assert.equal(normGroupKey("  Tom   Lemmons "), "tom lemmons");
  assert.notEqual(normGroupKey("Tom Lemmons"), normGroupKey("Tom Lemmons 2"));
});

test("normalizePref reads the first letter, defaults to any", () => {
  assert.equal(normalizePref("Front"), "front");
  assert.equal(normalizePref("back row please"), "back");
  assert.equal(normalizePref(""), "any");
  assert.equal(normalizePref("no preference"), "any");
});
