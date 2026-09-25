"use server";

import { db, schema } from "@/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { generateShareSlug } from "@/lib/slug";
import { parseGuestList } from "@/lib/csv";
import { planReconcile, type ExistingPartySummary } from "@/lib/reconcile";
import {
  runAutoAssign as runAutoAssignPure,
  validateSplitCounts,
  type PartyInput,
  type PlacementInput,
  type TableInput,
} from "@/lib/assign";
import type { SectionKey, TableShape } from "@/lib/types";

const { events, parties, partyMembers, placements, venueTables } = schema;

// The parameter type of a db.transaction() callback — used so
// allocateToGroup (below) can run either standalone or as part of a larger
// transaction (auto-assign applies a whole plan in one transaction).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createEvent(venueId: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const expectedRaw = String(formData.get("expectedGuests") ?? "").trim();
  const expectedGuests = expectedRaw ? parseInt(expectedRaw, 10) : null;
  if (!name) throw new Error("Event name is required.");

  const shareSlug = generateShareSlug();
  const [event] = await db
    .insert(events)
    .values({ venueId, name, expectedGuests: Number.isFinite(expectedGuests) ? expectedGuests : null, shareSlug })
    .returning({ shareSlug: events.shareSlug });
  revalidatePath("/");
  revalidatePath(`/venues/${venueId}`);
  redirect(`/e/${event.shareSlug}`);
}

export async function renameEvent(eventId: string, name: string, expectedGuests: number | null) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Event name is required.");
  const [row] = await db
    .update(events)
    .set({ name: trimmed, expectedGuests, updatedAt: new Date() })
    .where(eq(events.id, eventId))
    .returning({ shareSlug: events.shareSlug });
  if (row) revalidatePath(`/e/${row.shareSlug}`);
  revalidatePath("/");
}

export async function deleteEvent(eventId: string, venueId: string) {
  await db.delete(events).where(eq(events.id, eventId));
  revalidatePath("/");
  revalidatePath(`/venues/${venueId}`);
}

// ---------------------------------------------------------------------------
// Guest list upload — parses the CSV, reconciles against existing active
// parties (see lib/reconcile.ts), and applies the resulting plan in one
// transaction. Returns parse errors/warnings plus reconciliation warnings so
// the page can show what changed.
// ---------------------------------------------------------------------------
export async function uploadGuestList(eventId: string, csvText: string) {
  const { groups, errors, warnings: parseWarnings } = parseGuestList(csvText);

  const existingRows = await db.query.parties.findMany({
    where: and(eq(parties.eventId, eventId), eq(parties.active, true)),
    with: { placements: true },
  });
  const existing: ExistingPartySummary[] = existingRows.map((p) => ({
    id: p.id,
    groupKey: p.groupKey,
    name: p.name,
    pref: p.pref,
    size: p.size,
    placements: p.placements.map((pl) => ({ id: pl.id, tableId: pl.tableId, count: pl.count, order: pl.order })),
  }));

  const plan = planReconcile(existing, groups);

  await db.transaction(async (tx) => {
    for (const group of plan.toCreate) {
      const [party] = await tx
        .insert(parties)
        .values({ eventId, groupKey: group.groupKey, name: group.name, pref: group.pref, size: group.size })
        .returning({ id: parties.id });
      await tx.insert(partyMembers).values(
        group.members.map((m, i) => ({ partyId: party.id, name: m.name, size: m.size, order: i })),
      );
      await tx.insert(placements).values({ partyId: party.id, tableId: null, count: group.size, order: 0, reason: null });
    }

    for (const update of plan.toUpdate) {
      await tx
        .update(parties)
        .set({ name: update.name, pref: update.pref, size: update.size, updatedAt: new Date() })
        .where(eq(parties.id, update.partyId));
      await tx.delete(partyMembers).where(eq(partyMembers.partyId, update.partyId));
      await tx.insert(partyMembers).values(
        update.members.map((m, i) => ({ partyId: update.partyId, name: m.name, size: m.size, order: i })),
      );
      for (const change of update.placementChanges) {
        if (change.kind === "trim") {
          await tx.update(placements).set({ count: change.newCount }).where(eq(placements.id, change.placementId));
        } else if (change.kind === "remove") {
          await tx.delete(placements).where(eq(placements.id, change.placementId));
        } else if (change.kind === "resizeUnassigned") {
          await tx
            .update(placements)
            .set({ count: change.newCount, reason: null })
            .where(eq(placements.id, change.placementId));
        } else if (change.kind === "createUnassigned") {
          await tx
            .insert(placements)
            .values({ partyId: update.partyId, tableId: null, count: change.count, order: change.order, reason: null });
        }
      }
    }

    if (plan.toDeactivateIds.length) {
      await tx.update(parties).set({ active: false }).where(inArray(parties.id, plan.toDeactivateIds));
    }
  });

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);

  return {
    errors,
    warnings: [...parseWarnings, ...plan.warnings],
    created: plan.toCreate.length,
    updated: plan.toUpdate.length,
    removed: plan.toDeactivateIds.length,
  };
}

// Night-of guest check-in — independent of seating. Toggled from the guest
// list's per-row button.
export async function setCheckedIn(eventId: string, partyId: string, checkedIn: boolean) {
  await db
    .update(parties)
    .set({ checkedInAt: checkedIn ? new Date() : null })
    .where(eq(parties.id, partyId));

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);
}

// ---------------------------------------------------------------------------
// Loads the tables/parties/placements needed by the pure assign.ts helpers.
// Shared by runAutoAssignAction and the split/move actions below (each
// re-fetches fresh state rather than trusting client-supplied numbers, since
// this is a shared, no-login tool where more than one tab can be editing).
// ---------------------------------------------------------------------------
async function loadAssignState(eventId: string) {
  const eventRow = await db.query.events.findFirst({
    where: eq(events.id, eventId),
    with: { venue: { with: { tables: true } } },
  });
  if (!eventRow) throw new Error("Event not found.");

  const activeParties = await db.query.parties.findMany({
    where: and(eq(parties.eventId, eventId), eq(parties.active, true)),
    with: { members: { orderBy: asc(partyMembers.order) }, placements: true },
  });

  const tables: TableInput[] = eventRow.venue.tables.map((t) => ({
    id: t.id,
    sectionKey: t.sectionKey,
    shape: t.shape,
    capacity: t.capacity,
    order: t.order,
    groupId: t.groupId,
    tableNumber: t.tableNumber,
  }));
  const partyInputs: PartyInput[] = activeParties.map((p) => ({
    id: p.id,
    name: p.name,
    pref: p.pref,
    size: p.size,
    members: p.members.map((m) => ({ name: m.name, size: m.size })),
  }));
  const placementInputs: PlacementInput[] = activeParties.flatMap((p) =>
    p.placements.map((pl) => ({ id: pl.id, partyId: p.id, tableId: pl.tableId, count: pl.count, order: pl.order, reason: pl.reason })),
  );

  return { shareSlug: eventRow.shareSlug, tables, parties: partyInputs, placements: placementInputs };
}

// Only touches currently-unassigned placements (see lib/assign.ts) — manual
// seating from drags/splits is never disturbed by a re-run.
export async function runAutoAssignAction(eventId: string) {
  const state = await loadAssignState(eventId);
  const result = runAutoAssignPure(state.tables, state.parties, state.placements);

  await db.transaction(async (tx) => {
    for (const p of result.placed) {
      if ("tableId" in p) {
        await tx.update(placements).set({ tableId: p.tableId, reason: null }).where(eq(placements.id, p.placementId));
      } else {
        // Planned into a linked group — split across its member tables,
        // recomputed against live DB state (see allocateToGroup).
        await allocateToGroup(tx, p.groupId, p.placementId);
      }
    }
    for (const u of result.stillUnassigned) {
      await tx.update(placements).set({ reason: u.reason }).where(eq(placements.id, u.placementId));
    }
  });

  revalidatePath(`/e/${state.shareSlug}`);
  return { placedCount: result.placed.length, unassignedCount: result.stillUnassigned.length };
}

// Moves a placement (whole, or partially — leaving the remainder behind at
// its current location) to a different table, or back to the unassigned
// pool (targetTableId = null). This single action covers every drag-and-drop
// case: tray -> table, table -> table, table -> tray.
export async function movePlacement(
  eventId: string,
  placementId: string,
  targetTableId: string | null,
  moveCount?: number,
) {
  await db.transaction(async (tx) => {
    const current = await tx.query.placements.findFirst({ where: eq(placements.id, placementId) });
    if (!current) return;
    const amount = moveCount == null ? current.count : Math.min(Math.max(1, Math.floor(moveCount)), current.count);

    if (amount >= current.count) {
      // Full move.
      await tx.update(placements).set({ tableId: targetTableId, reason: null }).where(eq(placements.id, placementId));
      return;
    }

    // Partial move: shrink the original row, create a new one for the
    // moved chunk at its destination.
    const siblingMax = await tx
      .select({ order: placements.order })
      .from(placements)
      .where(eq(placements.partyId, current.partyId))
      .orderBy(asc(placements.order));
    const nextOrder = siblingMax.length ? siblingMax[siblingMax.length - 1].order + 1 : current.order + 1;

    await tx.update(placements).set({ count: current.count - amount }).where(eq(placements.id, placementId));
    await tx
      .insert(placements)
      .values({ partyId: current.partyId, tableId: targetTableId, count: amount, order: nextOrder, reason: null });
  });

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);
}

// Regroups a split party back together — the drag-one-fragment-onto-another
// counterpart to splitPlacement. Folds the source placement's count into
// the target's row (so the merged party lands wherever the target already
// was — a table, a group member, or the unassigned tray) and removes the
// source row. Both rows must belong to the SAME party; the UI only offers
// this when it can already tell they match, but it's re-checked here since
// this is the authoritative boundary.
export async function mergePlacements(eventId: string, sourcePlacementId: string, targetPlacementId: string) {
  await db.transaction(async (tx) => {
    if (sourcePlacementId === targetPlacementId) return;
    const [source, target] = await Promise.all([
      tx.query.placements.findFirst({ where: eq(placements.id, sourcePlacementId) }),
      tx.query.placements.findFirst({ where: eq(placements.id, targetPlacementId) }),
    ]);
    if (!source || !target) return;
    if (source.partyId !== target.partyId) {
      throw new Error("Only pieces of the same party can be regrouped together.");
    }
    await tx
      .update(placements)
      .set({ count: target.count + source.count, reason: null })
      .where(eq(placements.id, targetPlacementId));
    await tx.delete(placements).where(eq(placements.id, sourcePlacementId));
  });

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);
}

// Seats a placement into a LINKED group of tables (a "virtual table" —
// see linkTables in venue-actions.ts), splitting it across member tables
// when it's bigger than any single member's free capacity. Fills members in
// their section order, greedily. Anything that still doesn't fit (the
// group's combined free capacity was less than the placement) is left
// behind as a separate unassigned remainder with an explanatory reason,
// rather than silently dropped.
async function allocateToGroup(tx: Tx, groupId: string, placementId: string) {
  const current = await tx.query.placements.findFirst({ where: eq(placements.id, placementId) });
  if (!current || current.count <= 0) return;

  const members = await tx
    .select()
    .from(venueTables)
    .where(eq(venueTables.groupId, groupId))
    .orderBy(asc(venueTables.order));
  if (members.length === 0) return;

  const memberIds = members.map((m) => m.id);
  const usedByTable = new Map<string, number>();
  const existing = await tx
    .select({ tableId: placements.tableId, count: placements.count })
    .from(placements)
    .where(inArray(placements.tableId, memberIds));
  for (const row of existing) {
    if (!row.tableId || row.tableId === current.tableId) continue;
    // Exclude this placement's own current seat, if any, from "used" —
    // it's about to be reallocated, not double-counted.
    usedByTable.set(row.tableId, (usedByTable.get(row.tableId) ?? 0) + row.count);
  }

  let remaining = current.count;
  const allocations: { tableId: string; count: number }[] = [];
  for (const m of members) {
    if (remaining <= 0) break;
    const used = usedByTable.get(m.id) ?? 0;
    const free = m.capacity - used;
    if (free <= 0) continue;
    const take = Math.min(free, remaining);
    allocations.push({ tableId: m.id, count: take });
    remaining -= take;
  }

  if (allocations.length === 0) return;

  const siblingMax = await tx
    .select({ order: placements.order })
    .from(placements)
    .where(eq(placements.partyId, current.partyId))
    .orderBy(asc(placements.order));
  let nextOrder = siblingMax.length ? siblingMax[siblingMax.length - 1].order + 1 : current.order + 1;

  // Reuse the original row for the first allocation; insert new rows for
  // any further members needed, and one more for whatever didn't fit.
  await tx
    .update(placements)
    .set({ tableId: allocations[0].tableId, count: allocations[0].count, reason: null })
    .where(eq(placements.id, placementId));

  for (const alloc of allocations.slice(1)) {
    await tx.insert(placements).values({
      partyId: current.partyId,
      tableId: alloc.tableId,
      count: alloc.count,
      order: nextOrder++,
      reason: null,
    });
  }

  if (remaining > 0) {
    await tx.insert(placements).values({
      partyId: current.partyId,
      tableId: null,
      count: remaining,
      order: nextOrder++,
      reason: "didn't fit in the linked table — the rest is still unassigned",
    });
  }
}

export async function seatInGroup(eventId: string, groupId: string, placementId: string) {
  await db.transaction(async (tx) => {
    await allocateToGroup(tx, groupId, placementId);
  });

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);
}

// Creates a new table in the given section and seats the whole placement
// there in one transaction — used by the event page's "move to section"
// control when no existing table there has room, after the person confirms
// adding one.
export async function addTableAndSeat(
  eventId: string,
  venueId: string,
  sectionKey: SectionKey,
  shape: TableShape,
  capacity: number,
  placementId: string,
) {
  if (!Number.isFinite(capacity) || capacity < 1) throw new Error("Capacity must be at least 1.");

  await db.transaction(async (tx) => {
    const siblings = await tx
      .select({ order: venueTables.order })
      .from(venueTables)
      .where(and(eq(venueTables.venueId, venueId), eq(venueTables.sectionKey, sectionKey)))
      .orderBy(asc(venueTables.order));
    const nextOrder = siblings.length ? siblings[siblings.length - 1].order + 1 : 0;
    const [table] = await tx
      .insert(venueTables)
      .values({ venueId, sectionKey, shape, capacity: Math.floor(capacity), order: nextOrder })
      .returning({ id: venueTables.id });
    await tx.update(placements).set({ tableId: table.id, reason: null }).where(eq(placements.id, placementId));
  });

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);
  revalidatePath(`/venues/${venueId}`);
}

// The explicit "click a party to split it first" action: replaces one
// placement row with several, all at the SAME location (table or
// unassigned) as the original, each independently draggable afterward.
export async function splitPlacement(eventId: string, placementId: string, counts: number[]) {
  await db.transaction(async (tx) => {
    const current = await tx.query.placements.findFirst({ where: eq(placements.id, placementId) });
    if (!current) throw new Error("That group isn't there anymore — try refreshing.");
    const check = validateSplitCounts(current.count, counts);
    if (!check.ok) throw new Error(check.error);

    const siblings = await tx
      .select()
      .from(placements)
      .where(eq(placements.partyId, current.partyId))
      .orderBy(asc(placements.order));
    const idx = siblings.findIndex((s) => s.id === placementId);

    const newPieces = counts.map((count) => ({
      partyId: current.partyId,
      tableId: current.tableId,
      count,
      reason: current.reason,
    }));

    const rewritten = [...siblings.slice(0, idx), ...newPieces, ...siblings.slice(idx + 1)];
    await tx.delete(placements).where(eq(placements.partyId, current.partyId));
    await tx.insert(placements).values(
      rewritten.map((row, i) => ({
        partyId: current.partyId,
        tableId: row.tableId,
        count: row.count,
        reason: row.reason,
        order: i,
      })),
    );
  });

  const [eventRow] = await db.select({ shareSlug: events.shareSlug }).from(events).where(eq(events.id, eventId));
  if (eventRow) revalidatePath(`/e/${eventRow.shareSlug}`);
}
