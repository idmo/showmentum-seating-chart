// Table assignment engine: hard section-preference auto-assign, the
// derived render model (per-table fragments + unassigned pool), and the
// member-distribution helper that lets a party split across any number of
// tables while still showing named guests correctly at each one.
//
// Unlike the original single-file artifact, placements now persist in a
// database and a party can have MORE than one unassigned fragment at once
// (from a manual "split first" action) — so auto-assign only ever touches
// currently-unassigned fragments, never a party's already-seated ones.

import type { PartyPref, SectionKey, TableShape } from "./types";
import type { ParsedMember } from "./csv";

export const PRIVATE_TABLE_THRESHOLD = 4;
export const SECTION_ORDER: SectionKey[] = ["front", "middle", "back"];
export const SECTION_LABELS: Record<SectionKey, string> = {
  front: "Front",
  middle: "Middle",
  back: "Back",
};

export interface TableInput {
  id: string;
  sectionKey: SectionKey;
  shape: TableShape;
  capacity: number;
  order: number;
}

export interface PartyInput {
  id: string;
  name: string;
  pref: PartyPref;
  size: number;
  members: ParsedMember[];
}

export interface PlacementInput {
  id: string;
  partyId: string;
  tableId: string | null;
  count: number;
  order: number;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// distributeMembers — slices a party's named member rows across an ordered
// list of allocations (one per placement row, seated or unassigned). A
// single member row can itself be split across two allocations, which is
// what lets a party that came in as one CSV row (e.g. "Smith Family, 14")
// show up as "10" at one table and "4" at another with the same name.
// ---------------------------------------------------------------------------
export function distributeMembers(
  members: ParsedMember[],
  allocations: { key: string; count: number }[],
): { key: string; count: number; members: ParsedMember[] }[] {
  const result = allocations.map((a) => ({ key: a.key, count: a.count, members: [] as ParsedMember[] }));
  const queue = members.map((m) => ({ name: m.name, remaining: m.size }));
  let mi = 0;
  for (let ai = 0; ai < result.length; ai++) {
    let need = result[ai].count;
    while (need > 0 && mi < queue.length) {
      const m = queue[mi];
      const take = Math.min(need, m.remaining);
      if (take > 0) result[ai].members.push({ name: m.name, size: take });
      m.remaining -= take;
      need -= take;
      if (m.remaining <= 0) mi++;
    }
  }
  return result;
}

export function validateSplitCounts(total: number, counts: number[]): { ok: boolean; error?: string } {
  if (counts.length < 2) return { ok: false, error: "Split into at least 2 groups." };
  if (counts.some((c) => !Number.isInteger(c) || c < 1)) {
    return { ok: false, error: "Each group must have at least 1 guest." };
  }
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum !== total) {
    return { ok: false, error: `The groups must add up to ${total} (currently ${sum}).` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Auto-assign — only places fragments that are currently unassigned
// (tableId === null). Already-seated fragments (including from manual
// drags/splits) are left completely alone, so clicking "Auto-seat" again
// after manual edits never undoes them.
//
// Hard section requirement: a party with an explicit Front/Middle/Back
// request is ONLY ever placed within that section. If no table there fits,
// it stays unassigned with a reason — never bumped to another section.
// No-preference parties fill Front, then Middle, then Back.
// ---------------------------------------------------------------------------
export interface AutoAssignResult {
  // partyId+order -> {tableId, reason} for every placement that was touched
  placed: Array<{ placementId: string; tableId: string }>;
  stillUnassigned: Array<{ placementId: string; reason: string }>;
}

export function runAutoAssign(
  tables: TableInput[],
  parties: PartyInput[],
  placements: PlacementInput[],
): AutoAssignResult {
  const partyById = new Map(parties.map((p) => [p.id, p]));

  // Live remaining-capacity tracker, seeded from every ALREADY-seated
  // placement (auto-assign never touches these, but must respect them).
  const tableState = new Map(
    tables.map((t) => [t.id, { ...t, remaining: t.capacity, usedSeats: 0 }]),
  );
  placements.forEach((pl) => {
    if (pl.tableId && tableState.has(pl.tableId)) {
      const ts = tableState.get(pl.tableId)!;
      ts.usedSeats += pl.count;
      // A pre-existing large single occupant still holds the table
      // exclusively for capacity purposes (mirrors the claim() rule below).
      const party = partyById.get(pl.partyId);
      if (party && pl.count >= PRIVATE_TABLE_THRESHOLD && ts.remaining > 0) {
        ts.remaining = 0;
      } else {
        ts.remaining = Math.max(0, ts.remaining - pl.count);
      }
    }
  });

  const tablesBySection = (key: SectionKey) =>
    tables.filter((t) => t.sectionKey === key).map((t) => tableState.get(t.id)!);

  function bestFit(candidates: ReturnType<typeof tableState.get>[], size: number) {
    let best: ReturnType<typeof tableState.get> | null = null;
    for (const t of candidates) {
      if (!t) continue;
      if (t.remaining >= size) {
        if (!best || t.remaining - size < best.remaining - size) best = t;
      }
    }
    return best;
  }
  function claim(t: NonNullable<ReturnType<typeof tableState.get>>, size: number) {
    t.usedSeats += size;
    if (size >= PRIVATE_TABLE_THRESHOLD) t.remaining = 0;
    else t.remaining -= size;
  }

  const candidates = placements
    .filter((pl) => pl.tableId === null && pl.count > 0 && partyById.has(pl.partyId))
    .map((pl) => ({ placement: pl, party: partyById.get(pl.partyId)! }));

  const explicitCandidates = candidates.filter((c) => c.party.pref !== "any");
  const flexCandidates = candidates.filter((c) => c.party.pref === "any");

  const bigSmallSort = (a: (typeof candidates)[number], b: (typeof candidates)[number]) => {
    const aBig = a.placement.count >= PRIVATE_TABLE_THRESHOLD ? 1 : 0;
    const bBig = b.placement.count >= PRIVATE_TABLE_THRESHOLD ? 1 : 0;
    if (aBig !== bBig) return bBig - aBig;
    return b.placement.count - a.placement.count;
  };

  const placed: AutoAssignResult["placed"] = [];
  const stillUnassigned: AutoAssignResult["stillUnassigned"] = [];

  // Phase 1: explicit-preference parties, own section only, hard requirement.
  explicitCandidates.sort(bigSmallSort).forEach(({ placement, party }) => {
    const section = party.pref as SectionKey;
    const t = bestFit(tablesBySection(section), placement.count);
    if (t) {
      claim(t, placement.count);
      placed.push({ placementId: placement.id, tableId: t.id });
    } else {
      const maxCapInSection = Math.max(0, ...tablesBySection(section).map((x) => x!.capacity));
      const reason =
        placement.count > maxCapInSection
          ? `party of ${placement.count} is larger than the biggest table in ${SECTION_LABELS[section]} (${maxCapInSection} seats) — split it and place each piece separately`
          : `no open table in ${SECTION_LABELS[section]} has ${placement.count} free seats`;
      stillUnassigned.push({ placementId: placement.id, reason });
    }
  });

  // Phase 2: no-preference parties, fixed cascade Front -> Middle -> Back.
  flexCandidates.sort(bigSmallSort).forEach(({ placement }) => {
    let placedHere = false;
    for (const section of SECTION_ORDER) {
      const t = bestFit(tablesBySection(section), placement.count);
      if (t) {
        claim(t, placement.count);
        placed.push({ placementId: placement.id, tableId: t.id });
        placedHere = true;
        break;
      }
    }
    if (!placedHere) {
      const maxCapAnywhere = Math.max(0, ...tables.map((t) => t.capacity));
      const reason =
        placement.count > maxCapAnywhere
          ? `party of ${placement.count} is larger than the biggest table (${maxCapAnywhere} seats) — split it and place each piece separately`
          : `no section has ${placement.count} open seats left`;
      stillUnassigned.push({ placementId: placement.id, reason });
    }
  });

  return { placed, stillUnassigned };
}

// ---------------------------------------------------------------------------
// deriveView — the single source of truth for rendering: per-table
// fragments (with each fragment's slice of named members), the unassigned
// pool (one entry per still-unassigned placement row, since a manually
// split party can have several at once), and a reassigned() check.
// ---------------------------------------------------------------------------
export interface TableFragmentView {
  placementId: string;
  party: PartyInput;
  tableId: string;
  count: number;
  isPartial: boolean;
  members: ParsedMember[];
  order: number;
}
export interface UnassignedFragmentView {
  placementId: string;
  party: PartyInput;
  count: number;
  isPartial: boolean;
  members: ParsedMember[];
  reason: string | null;
  order: number;
}
export interface TableStateView {
  id: string;
  sectionKey: SectionKey;
  shape: TableShape;
  capacity: number;
  order: number;
  usedSeats: number;
  overCapacity: boolean;
  isPrivate: boolean;
  privateHolderName: string | null;
  fragments: TableFragmentView[];
}
export interface DerivedView {
  tableState: Map<string, TableStateView>;
  unassigned: UnassignedFragmentView[];
  reassigned: (fragment: TableFragmentView) => boolean;
}

export function deriveView(
  tables: TableInput[],
  parties: PartyInput[],
  placements: PlacementInput[],
): DerivedView {
  const tableState = new Map<string, TableStateView>(
    tables.map((t) => [
      t.id,
      {
        id: t.id,
        sectionKey: t.sectionKey,
        shape: t.shape,
        capacity: t.capacity,
        order: t.order,
        usedSeats: 0,
        overCapacity: false,
        isPrivate: false,
        privateHolderName: null,
        fragments: [],
      },
    ]),
  );
  const unassigned: UnassignedFragmentView[] = [];

  const placementsByParty = new Map<string, PlacementInput[]>();
  placements.forEach((pl) => {
    if (pl.count <= 0) return;
    const list = placementsByParty.get(pl.partyId) ?? [];
    list.push(pl);
    placementsByParty.set(pl.partyId, list);
  });

  parties.forEach((party) => {
    const partyPlacements = (placementsByParty.get(party.id) ?? []).slice().sort((a, b) => a.order - b.order);
    if (!partyPlacements.length) return;
    const frags = distributeMembers(
      party.members,
      partyPlacements.map((pl) => ({ key: pl.id, count: pl.count })),
    );
    const membersByKey = new Map(frags.map((f) => [f.key, f.members]));

    partyPlacements.forEach((pl) => {
      const members = membersByKey.get(pl.id) ?? [];
      const isPartial = pl.count < party.size;
      if (pl.tableId && tableState.has(pl.tableId)) {
        const ts = tableState.get(pl.tableId)!;
        ts.usedSeats += pl.count;
        ts.fragments.push({
          placementId: pl.id,
          party,
          tableId: pl.tableId,
          count: pl.count,
          isPartial,
          members,
          order: pl.order,
        });
      } else {
        unassigned.push({
          placementId: pl.id,
          party,
          count: pl.count,
          isPartial,
          members,
          reason: pl.reason,
          order: pl.order,
        });
      }
    });
  });

  tableState.forEach((ts) => {
    ts.overCapacity = ts.usedSeats > ts.capacity;
    ts.isPrivate =
      ts.fragments.length === 1 &&
      ts.fragments[0].party.size >= PRIVATE_TABLE_THRESHOLD &&
      ts.usedSeats < ts.capacity;
    ts.privateHolderName = ts.isPrivate ? ts.fragments[0].party.name : null;
  });

  function reassigned(fragment: TableFragmentView): boolean {
    return fragment.party.pref !== "any" && fragment.party.pref !== tableState.get(fragment.tableId)?.sectionKey;
  }

  return { tableState, unassigned, reassigned };
}
