import { test } from "node:test";
import assert from "node:assert/strict";
import { planReconcile, isSuspiciousJump, type ExistingPartySummary } from "./reconcile";
import type { ParsedGroup } from "./csv";

test("a party present in both keeps its id and existing seated placement untouched", () => {
  const existing: ExistingPartySummary[] = [
    {
      id: "party-1",
      groupKey: "chen family",
      name: "Chen Family",
      pref: "front",
      size: 6,
      placements: [{ id: "pl-1", tableId: "t1", count: 6, order: 0 }],
    },
  ];
  const fresh: ParsedGroup[] = [
    { groupKey: "chen family", name: "Chen Family", pref: "front", size: 6, members: [{ name: "Alice Chen", size: 6 }] },
  ];
  const plan = planReconcile(existing, fresh);
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.toDeactivateIds.length, 0);
  assert.equal(plan.toUpdate.length, 1);
  assert.equal(plan.toUpdate[0].partyId, "party-1");
  // fully seated, no size change -> no placement changes needed
  assert.equal(plan.toUpdate[0].placementChanges.length, 0);
});

test("a new party in the CSV is created, unmatched existing parties are deactivated", () => {
  const existing: ExistingPartySummary[] = [
    { id: "party-1", groupKey: "old party", name: "Old Party", pref: "any", size: 2, placements: [] },
  ];
  const fresh: ParsedGroup[] = [
    { groupKey: "new party", name: "New Party", pref: "any", size: 3, members: [{ name: "New Party", size: 3 }] },
  ];
  const plan = planReconcile(existing, fresh);
  assert.equal(plan.toCreate.length, 1);
  assert.equal(plan.toCreate[0].name, "New Party");
  assert.deepEqual(plan.toDeactivateIds, ["party-1"]);
  assert.match(plan.warnings.join(" "), /Old Party.*no longer/);
});

test("guest count increase on a fully-seated party creates a new unassigned remainder", () => {
  const existing: ExistingPartySummary[] = [
    {
      id: "party-1",
      groupKey: "smith family",
      name: "Smith Family",
      pref: "any",
      size: 10,
      placements: [{ id: "pl-1", tableId: "t1", count: 10, order: 0 }],
    },
  ];
  const fresh: ParsedGroup[] = [
    { groupKey: "smith family", name: "Smith Family", pref: "any", size: 14, members: [{ name: "Smith Family", size: 14 }] },
  ];
  const plan = planReconcile(existing, fresh);
  const update = plan.toUpdate[0];
  assert.equal(update.size, 14);
  assert.deepEqual(update.placementChanges, [{ kind: "createUnassigned", count: 4, order: 1 }]);
});

test("guest count decrease trims the most recently placed (highest-order) seated fragment first", () => {
  const existing: ExistingPartySummary[] = [
    {
      id: "party-1",
      groupKey: "smith family",
      name: "Smith Family",
      pref: "any",
      size: 14,
      placements: [
        { id: "pl-1", tableId: "t1", count: 10, order: 0 },
        { id: "pl-2", tableId: "t2", count: 4, order: 1 },
      ],
    },
  ];
  const fresh: ParsedGroup[] = [
    { groupKey: "smith family", name: "Smith Family", pref: "any", size: 12, members: [{ name: "Smith Family", size: 12 }] },
  ];
  const plan = planReconcile(existing, fresh);
  const update = plan.toUpdate[0];
  // Only the later fragment (order 1, the 4-seat one at t2) is touched —
  // trimmed down to 2 — leaving the earlier 10-seat placement alone.
  assert.deepEqual(update.placementChanges, [{ kind: "trim", placementId: "pl-2", newCount: 2 }]);
  assert.match(plan.warnings.join(" "), /dropped from 14 to 12/);
});

test("guest count decrease that eliminates a whole fragment removes it and moves on", () => {
  const existing: ExistingPartySummary[] = [
    {
      id: "party-1",
      groupKey: "smith family",
      name: "Smith Family",
      pref: "any",
      size: 14,
      placements: [
        { id: "pl-1", tableId: "t1", count: 10, order: 0 },
        { id: "pl-2", tableId: "t2", count: 4, order: 1 },
      ],
    },
  ];
  const fresh: ParsedGroup[] = [
    { groupKey: "smith family", name: "Smith Family", pref: "any", size: 9, members: [{ name: "Smith Family", size: 9 }] },
  ];
  const plan = planReconcile(existing, fresh);
  const update = plan.toUpdate[0];
  assert.deepEqual(update.placementChanges, [
    { kind: "remove", placementId: "pl-2" },
    { kind: "trim", placementId: "pl-1", newCount: 9 },
  ]);
});

test("isSuspiciousJump flags a disproportionate size increase but not ordinary growth", () => {
  // Regression case: a CSV re-upload once turned a party of 4 into 42
  // because a source-data edit appended "2" instead of replacing "4".
  assert.equal(isSuspiciousJump(4, 42), true);
  // Ordinary growth (e.g. someone added a couple of guests) shouldn't trip it.
  assert.equal(isSuspiciousJump(4, 8), false);
  assert.equal(isSuspiciousJump(2, 10), false);
  // A shrink, or no change, is never "suspicious" in this sense.
  assert.equal(isSuspiciousJump(10, 4), false);
  assert.equal(isSuspiciousJump(4, 4), false);
  // No prior size to compare against -> nothing to flag.
  assert.equal(isSuspiciousJump(0, 42), false);
});

test("uploading a suspicious size jump for an existing party still applies it, but adds a warning", () => {
  const existing: ExistingPartySummary[] = [
    {
      id: "party-1",
      groupKey: "matt johnson",
      name: "Matt Johnson",
      pref: "front",
      size: 4,
      placements: [{ id: "pl-1", tableId: null, count: 4, order: 0 }],
    },
  ];
  const fresh: ParsedGroup[] = [
    { groupKey: "matt johnson", name: "Matt Johnson", pref: "front", size: 42, members: [{ name: "Matt Johnson", size: 42 }] },
  ];
  const plan = planReconcile(existing, fresh);
  assert.equal(plan.toUpdate[0].size, 42);
  assert.match(plan.warnings.join(" "), /jumped from 4 to 42/);
});
