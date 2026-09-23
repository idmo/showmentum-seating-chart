// Reconciles a freshly-uploaded CSV against an event's existing active
// parties, matched by groupKey. The goal: re-uploading a corrected guest
// list should NOT throw away manual seating work.
//
// - A party still present keeps its id (and therefore its seated
//   placements). Its name/pref/members are refreshed from the new CSV.
// - If its guest count grew, the extra guests become a new (or larger)
//   unassigned fragment — nothing already seated is touched.
// - If its guest count shrank below what's currently seated, seats are
//   freed by trimming the LAST-added seated fragments first (in placement
//   order), on the theory that earlier placements represent more
//   deliberate/older seating decisions.
// - A party no longer in the CSV is deactivated (soft-deleted): its seats
//   free up, but its history isn't destroyed.
// - A party that's new to the CSV is created, fully unassigned.

import type { PartyPref } from "./types";
import type { ParsedGroup, ParsedMember } from "./csv";

export interface ExistingPlacementSummary {
  id: string;
  tableId: string | null;
  count: number;
  order: number;
}

export interface ExistingPartySummary {
  id: string;
  groupKey: string;
  name: string;
  pref: PartyPref;
  size: number;
  placements: ExistingPlacementSummary[];
}

export type PlacementChange =
  | { kind: "trim"; placementId: string; newCount: number }
  | { kind: "remove"; placementId: string }
  | { kind: "resizeUnassigned"; placementId: string; newCount: number }
  | { kind: "createUnassigned"; count: number; order: number };

export interface PartyUpdate {
  partyId: string;
  name: string;
  pref: PartyPref;
  size: number;
  members: ParsedMember[];
  placementChanges: PlacementChange[];
}

export interface ReconcilePlan {
  toCreate: ParsedGroup[];
  toUpdate: PartyUpdate[];
  toDeactivateIds: string[];
  warnings: string[];
}

export function planReconcile(
  existing: ExistingPartySummary[],
  fresh: ParsedGroup[],
): ReconcilePlan {
  const existingByKey = new Map(existing.map((p) => [p.groupKey, p]));
  const seenKeys = new Set<string>();
  const toCreate: ParsedGroup[] = [];
  const toUpdate: PartyUpdate[] = [];
  const warnings: string[] = [];

  fresh.forEach((group) => {
    seenKeys.add(group.groupKey);
    const match = existingByKey.get(group.groupKey);
    if (!match) {
      toCreate.push(group);
      return;
    }

    const seated = match.placements
      .filter((p) => p.tableId !== null)
      .slice()
      .sort((a, b) => a.order - b.order);
    const unassignedRows = match.placements
      .filter((p) => p.tableId === null)
      .slice()
      .sort((a, b) => a.order - b.order);
    const placedTotal = seated.reduce((s, p) => s + p.count, 0);
    const newSize = group.size;
    const changes: PlacementChange[] = [];
    const nextOrder = Math.max(-1, ...match.placements.map((p) => p.order)) + 1;

    if (newSize >= placedTotal) {
      const remainder = newSize - placedTotal;
      if (remainder === 0) {
        unassignedRows.forEach((row) => changes.push({ kind: "remove", placementId: row.id }));
      } else if (unassignedRows.length > 0) {
        changes.push({ kind: "resizeUnassigned", placementId: unassignedRows[0].id, newCount: remainder });
        unassignedRows.slice(1).forEach((row) => changes.push({ kind: "remove", placementId: row.id }));
      } else {
        changes.push({ kind: "createUnassigned", count: remainder, order: nextOrder });
      }
      if (newSize !== match.size) {
        warnings.push(
          `“${group.name}” updated from ${match.size} to ${newSize} guest${newSize === 1 ? "" : "s"}.`,
        );
      }
    } else {
      // Shrunk below what's already seated — free seats from the most
      // recently placed fragments first until it fits.
      let toRemove = placedTotal - newSize;
      let freedSeats = 0;
      for (let i = seated.length - 1; i >= 0 && toRemove > 0; i--) {
        const row = seated[i];
        if (row.count <= toRemove) {
          changes.push({ kind: "remove", placementId: row.id });
          toRemove -= row.count;
          freedSeats += row.count;
        } else {
          changes.push({ kind: "trim", placementId: row.id, newCount: row.count - toRemove });
          freedSeats += toRemove;
          toRemove = 0;
        }
      }
      unassignedRows.forEach((row) => changes.push({ kind: "remove", placementId: row.id }));
      warnings.push(
        `“${group.name}” dropped from ${match.size} to ${newSize} guests — freed ${freedSeats} seat${freedSeats === 1 ? "" : "s"}.`,
      );
    }

    toUpdate.push({
      partyId: match.id,
      name: group.name,
      pref: group.pref,
      size: newSize,
      members: group.members,
      placementChanges: changes,
    });
  });

  const toDeactivateIds: string[] = [];
  existing.forEach((p) => {
    if (!seenKeys.has(p.groupKey)) {
      toDeactivateIds.push(p.id);
      warnings.push(`“${p.name}” is no longer in the uploaded guest list — removed, seats freed.`);
    }
  });

  return { toCreate, toUpdate, toDeactivateIds, warnings };
}
