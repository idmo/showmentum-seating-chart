import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAutoAssign,
  deriveView,
  distributeMembers,
  validateSplitCounts,
  type TableInput,
  type PartyInput,
  type PlacementInput,
  type AutoAssignResult,
} from "./assign";

function table(
  id: string,
  sectionKey: TableInput["sectionKey"],
  capacity: number,
  order = 0,
  groupId: string | null = null,
): TableInput {
  return { id, sectionKey, capacity, shape: "round", order, groupId };
}
function party(id: string, name: string, pref: PartyInput["pref"], size: number, members?: PartyInput["members"]): PartyInput {
  return { id, name, pref, size, members: members ?? [{ name, size }] };
}
function asTablePlacement(
  p: AutoAssignResult["placed"][number],
): { placementId: string; tableId: string } {
  if (!("tableId" in p)) {
    throw new Error(`expected a single-table placement for ${p.placementId}, got a group placement`);
  }
  return p;
}

function asGroupPlacement(
  p: AutoAssignResult["placed"][number],
): { placementId: string; groupId: string } {
  if (!("groupId" in p)) {
    throw new Error(`expected a group placement for ${p.placementId}, got a single-table placement`);
  }
  return p;
}

function unassignedPlacement(id: string, partyId: string, count: number, order = 0): PlacementInput {
  return { id, partyId, tableId: null, count, order, reason: null };
}

test("explicit section preference is a hard requirement: never bumped to another section", () => {
  // Front is full (an 8-top already fully occupied by someone else via a
  // seated placement), Middle has plenty of room, but this party asked for
  // Front specifically.
  const tables = [table("t-front", "front", 8), table("t-middle", "middle", 8)];
  const other = party("p-other", "Other Party", "front", 8);
  const requester = party("p-req", "Front Requesters", "front", 4);
  const placements: PlacementInput[] = [
    { id: "pl-other", partyId: "p-other", tableId: "t-front", count: 8, order: 0, reason: null },
    unassignedPlacement("pl-req", "p-req", 4),
  ];
  const result = runAutoAssign(tables, [other, requester], placements);
  assert.equal(result.placed.length, 0);
  assert.equal(result.stillUnassigned.length, 1);
  assert.equal(result.stillUnassigned[0].placementId, "pl-req");
  assert.match(result.stillUnassigned[0].reason, /Front/);
});

test("no-preference parties fill Front, then Middle, then Back", () => {
  const tables = [table("t-front", "front", 4), table("t-middle", "middle", 4), table("t-back", "back", 4)];
  const a = party("p-a", "A", "any", 4);
  const b = party("p-b", "B", "any", 4);
  const c = party("p-c", "C", "any", 4);
  const placements = [unassignedPlacement("pl-a", "p-a", 4), unassignedPlacement("pl-b", "p-b", 4), unassignedPlacement("pl-c", "p-c", 4)];
  const result = runAutoAssign(tables, [a, b, c], placements);
  const byPlacement = Object.fromEntries(result.placed.map((p) => [p.placementId, asTablePlacement(p).tableId]));
  assert.equal(byPlacement["pl-a"], "t-front");
  assert.equal(byPlacement["pl-b"], "t-middle");
  assert.equal(byPlacement["pl-c"], "t-back");
});

test("auto-assign never touches already-seated placements, only unassigned ones", () => {
  const tables = [table("t1", "front", 8)];
  // Seated party is under the private-table threshold, so it shares the
  // table rather than claiming it exclusively.
  const seatedParty = party("p1", "Seated", "any", 2);
  const newParty = party("p2", "New", "any", 4);
  const placements: PlacementInput[] = [
    { id: "pl1", partyId: "p1", tableId: "t1", count: 2, order: 0, reason: null },
    unassignedPlacement("pl2", "p2", 4),
  ];
  const result = runAutoAssign(tables, [seatedParty, newParty], placements);
  // Room for 6 more (8 cap, 2 used) — new party of 4 fits alongside it,
  // and the already-seated fragment is untouched (never appears in `placed`).
  assert.equal(result.placed.length, 1);
  assert.equal(result.placed[0].placementId, "pl2");
  assert.equal(asTablePlacement(result.placed[0]).tableId, "t1");
});

test("a party of >=4 claims its table exclusively even if seats are left over", () => {
  const tables = [table("t1", "front", 8)];
  const big = party("p1", "Big Party", "any", 4);
  const small = party("p2", "Small Party", "any", 2);
  const placements = [unassignedPlacement("pl1", "p1", 4), unassignedPlacement("pl2", "p2", 2)];
  const result = runAutoAssign(tables, [big, small], placements);
  // Big party (>=4) seated first (big-before-small ordering) and claims the
  // whole table exclusively, so the small party has nowhere to go.
  assert.equal(result.placed.length, 1);
  assert.equal(result.placed[0].placementId, "pl1");
  assert.equal(result.stillUnassigned.length, 1);
  assert.equal(result.stillUnassigned[0].placementId, "pl2");
});

test("distributeMembers can split a single CSV row across two allocations", () => {
  const members = [{ name: "Jordan Smith", size: 14 }];
  const result = distributeMembers(members, [
    { key: "a", count: 10 },
    { key: "b", count: 4 },
  ]);
  assert.equal(result[0].members.length, 1);
  assert.equal(result[0].members[0].size, 10);
  assert.equal(result[1].members[0].size, 4);
});

test("distributeMembers can split a multi-row party across a boundary that doesn't align with rows", () => {
  const members = [
    { name: "Alice", size: 2 },
    { name: "Bob", size: 4 },
  ];
  const result = distributeMembers(members, [
    { key: "a", count: 3 },
    { key: "b", count: 3 },
  ]);
  assert.deepEqual(result[0].members, [{ name: "Alice", size: 2 }, { name: "Bob", size: 1 }]);
  assert.deepEqual(result[1].members, [{ name: "Bob", size: 3 }]);
});

test("deriveView shows an unassigned fragment for each still-unassigned placement row, not merged", () => {
  const tables = [table("t1", "front", 20)];
  const p = party("p1", "Smith Family", "any", 14);
  // A manual "split first" before any table is chosen: two separate
  // unassigned fragments for the same party.
  const placements = [unassignedPlacement("pl1", "p1", 6, 0), unassignedPlacement("pl2", "p1", 8, 1)];
  const view = deriveView(tables, [p], placements);
  assert.equal(view.unassigned.length, 2);
  assert.ok(view.unassigned.every((u) => u.isPartial));
});

test("deriveView.reassigned flags a fragment seated outside its requested section", () => {
  const tables = [table("t1", "middle", 8)];
  const p = party("p1", "Party", "front", 4);
  const placements: PlacementInput[] = [{ id: "pl1", partyId: "p1", tableId: "t1", count: 4, order: 0, reason: null }];
  const view = deriveView(tables, [p], placements);
  const frag = view.tableState.get("t1")!.fragments[0];
  assert.equal(view.reassigned(frag), true);
});

test("validateSplitCounts requires at least 2 positive integer groups summing to the total", () => {
  assert.equal(validateSplitCounts(14, [6, 8]).ok, true);
  assert.equal(validateSplitCounts(14, [6, 7]).ok, false);
  assert.equal(validateSplitCounts(14, [14]).ok, false);
  assert.equal(validateSplitCounts(14, [0, 14]).ok, false);
});

test("auto-assign fits a party too big for any single table into a linked group's pooled capacity", () => {
  // Two 6-tops linked into one group in Front. No single table can seat 10,
  // but the group's pooled 12 seats can.
  const tables = [table("t1", "front", 6, 0, "g1"), table("t2", "front", 6, 1, "g1")];
  const big = party("p-big", "Big Party", "front", 10);
  const placements = [unassignedPlacement("pl-big", "p-big", 10)];
  const result = runAutoAssign(tables, [big], placements);
  assert.equal(result.stillUnassigned.length, 0);
  assert.equal(result.placed.length, 1);
  assert.equal(asGroupPlacement(result.placed[0]).groupId, "g1");
});

test("group pooled capacity accounts for seats already used by an existing placement on a member table", () => {
  // t1 already has 2 of its 6 seats used by a seated (non-auto-assign)
  // placement, so the group's true remaining capacity is (6-2)+6 = 10, not
  // the raw 12. A party of 8 should still fit; a party of 11 should not.
  // (2 is kept below the private-table-claim threshold so t1's own leftover
  // seats stay poolable rather than being reserved exclusively.)
  const tables = [table("t1", "front", 6, 0, "g1"), table("t2", "front", 6, 1, "g1")];
  const seated = party("p-seated", "Seated", "front", 2);
  const fitsParty = party("p-fits", "Fits", "front", 8);
  const placements: PlacementInput[] = [
    { id: "pl-seated", partyId: "p-seated", tableId: "t1", count: 2, order: 0, reason: null },
    unassignedPlacement("pl-fits", "p-fits", 8),
  ];
  const result = runAutoAssign(tables, [seated, fitsParty], placements);
  assert.equal(result.stillUnassigned.length, 0);
  assert.equal(result.placed.length, 1);
  assert.equal(asGroupPlacement(result.placed[0]).groupId, "g1");

  const tablesTight = [table("t1", "front", 6, 0, "g1"), table("t2", "front", 6, 1, "g1")];
  const tooBig = party("p-toobig", "Too Big", "front", 11);
  const placementsTight: PlacementInput[] = [
    { id: "pl-seated", partyId: "p-seated", tableId: "t1", count: 2, order: 0, reason: null },
    unassignedPlacement("pl-toobig", "p-toobig", 11),
  ];
  const resultTight = runAutoAssign(tablesTight, [seated, tooBig], placementsTight);
  assert.equal(resultTight.placed.length, 0);
  assert.equal(resultTight.stillUnassigned.length, 1);
  assert.equal(resultTight.stillUnassigned[0].placementId, "pl-toobig");
});

test("still-unassigned reason mentions linked tables when a party is bigger than every table AND every group", () => {
  const tables = [table("t1", "front", 6, 0, "g1"), table("t2", "front", 6, 1, "g1")];
  const huge = party("p-huge", "Huge Party", "front", 13);
  const placements = [unassignedPlacement("pl-huge", "p-huge", 13)];
  const result = runAutoAssign(tables, [huge], placements);
  assert.equal(result.placed.length, 0);
  assert.equal(result.stillUnassigned.length, 1);
  assert.match(result.stillUnassigned[0].reason, /linked table/);
  assert.match(result.stillUnassigned[0].reason, /12 seats/);
});
