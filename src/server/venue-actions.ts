"use server";

import { db, schema } from "@/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SECTION_KEYS, type SectionKey, type TableShape } from "@/lib/types";

const { venues, venueTables, placements, tableGroups } = schema;

export async function createVenue(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Venue name is required.");
  const [venue] = await db.insert(venues).values({ name }).returning({ id: venues.id });
  // Seed a starter layout so a brand-new venue isn't a blank slate — same
  // idea as the original tool's first-run default, easy to edit or clear.
  await db.insert(venueTables).values([
    { venueId: venue.id, sectionKey: "front", shape: "round", capacity: 8, order: 0 },
    { venueId: venue.id, sectionKey: "front", shape: "round", capacity: 8, order: 1 },
    { venueId: venue.id, sectionKey: "middle", shape: "round", capacity: 8, order: 0 },
    { venueId: venue.id, sectionKey: "middle", shape: "round", capacity: 8, order: 1 },
    { venueId: venue.id, sectionKey: "middle", shape: "round", capacity: 8, order: 2 },
    { venueId: venue.id, sectionKey: "back", shape: "rectangular", capacity: 6, order: 0 },
    { venueId: venue.id, sectionKey: "back", shape: "rectangular", capacity: 6, order: 1 },
  ]);
  revalidatePath("/");
  redirect(`/venues/${venue.id}`);
}

export async function renameVenue(venueId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Venue name is required.");
  await db.update(venues).set({ name: trimmed, updatedAt: new Date() }).where(eq(venues.id, venueId));
  revalidatePath("/");
  revalidatePath(`/venues/${venueId}`);
}

export async function deleteVenue(venueId: string) {
  // FK is ON DELETE RESTRICT for events.venueId, so this throws (and the
  // caller should show a friendly message) if any event still uses it.
  await db.delete(venues).where(eq(venues.id, venueId));
  revalidatePath("/");
}

export async function addTables(
  venueId: string,
  sectionKey: SectionKey,
  shape: TableShape,
  capacity: number,
  count: number,
) {
  if (!SECTION_KEYS.includes(sectionKey)) throw new Error("Invalid section.");
  if (!Number.isFinite(capacity) || capacity < 1) throw new Error("Capacity must be at least 1.");
  const n = Math.max(1, Math.min(50, Math.floor(count) || 1));

  await db.transaction(async (tx) => {
    const siblings = await tx
      .select({ order: venueTables.order })
      .from(venueTables)
      .where(and(eq(venueTables.venueId, venueId), eq(venueTables.sectionKey, sectionKey)))
      .orderBy(asc(venueTables.order));
    let nextOrder = siblings.length ? siblings[siblings.length - 1].order + 1 : 0;
    const rows = Array.from({ length: n }, () => ({
      venueId,
      sectionKey,
      shape,
      capacity: Math.floor(capacity),
      order: nextOrder++,
    }));
    await tx.insert(venueTables).values(rows);
  });
  revalidatePath(`/venues/${venueId}`);
}

export async function updateTable(
  tableId: string,
  venueId: string,
  changes: { shape?: TableShape; capacity?: number; tableNumber?: number | null },
) {
  const patch: Partial<typeof venueTables.$inferInsert> = {};
  if (changes.shape) patch.shape = changes.shape;
  if (changes.capacity !== undefined) {
    if (!Number.isFinite(changes.capacity) || changes.capacity < 1) {
      throw new Error("Capacity must be at least 1.");
    }
    patch.capacity = Math.floor(changes.capacity);
  }
  if (changes.tableNumber !== undefined) {
    if (changes.tableNumber !== null && (!Number.isFinite(changes.tableNumber) || changes.tableNumber < 1)) {
      throw new Error("Table number must be a positive number.");
    }
    patch.tableNumber = changes.tableNumber === null ? null : Math.floor(changes.tableNumber);
  }
  if (Object.keys(patch).length === 0) return;
  await db.update(venueTables).set(patch).where(eq(venueTables.id, tableId));
  revalidatePath(`/venues/${venueId}`);
}

// A linked group's table number is user-assigned the same way a standalone
// table's is, but since a group is several venueTables rows sharing a
// groupId, the number is written onto every member so the group reads as
// one consistently-numbered unit (see GroupedTableDropCard).
export async function setGroupTableNumber(groupId: string, venueId: string, tableNumber: number | null) {
  if (tableNumber !== null && (!Number.isFinite(tableNumber) || tableNumber < 1)) {
    throw new Error("Table number must be a positive number.");
  }
  const value = tableNumber === null ? null : Math.floor(tableNumber);
  await db.update(venueTables).set({ tableNumber: value }).where(eq(venueTables.groupId, groupId));
  revalidatePath(`/venues/${venueId}`);
}

export async function removeTable(tableId: string, venueId: string) {
  await db.transaction(async (tx) => {
    const row = await tx.query.venueTables.findFirst({ where: eq(venueTables.id, tableId) });
    // Attach a reason before the FK's ON DELETE SET NULL clears tableId, so
    // anyone seated there shows up in the tray with an explanation instead
    // of a blank one.
    await tx
      .update(placements)
      .set({ reason: "this table was removed from the venue" })
      .where(eq(placements.tableId, tableId));
    await tx.delete(venueTables).where(eq(venueTables.id, tableId));

    // A linked group left with fewer than 2 members isn't a group anymore.
    if (row?.groupId) {
      const remaining = await tx
        .select({ id: venueTables.id })
        .from(venueTables)
        .where(eq(venueTables.groupId, row.groupId));
      if (remaining.length < 2) {
        await tx.update(venueTables).set({ groupId: null }).where(eq(venueTables.groupId, row.groupId));
        await tx.delete(tableGroups).where(eq(tableGroups.id, row.groupId));
      }
    }
  });
  revalidatePath(`/venues/${venueId}`);
}

// ---------------------------------------------------------------------------
// Linked tables — a "virtual table": two or more physical tables that pool
// their capacity and are seated as one unit (see seatInGroup in
// event-actions.ts). Managed from both the venue editor and the event page,
// since a venue's owner might pre-link tables ahead of time for a known
// physical constraint, or link two on the fly when a party turns out bigger
// than any single table.
// ---------------------------------------------------------------------------
export async function linkTables(venueId: string, tableIds: string[]) {
  const ids = Array.from(new Set(tableIds));
  if (ids.length < 2) throw new Error("Select at least two tables to link.");

  await db.transaction(async (tx) => {
    const rows = await tx.select().from(venueTables).where(inArray(venueTables.id, ids));
    if (rows.length !== ids.length) throw new Error("One of those tables no longer exists.");
    if (rows.some((r) => r.venueId !== venueId)) throw new Error("Those tables aren't all in this venue.");
    const section = rows[0].sectionKey;
    if (rows.some((r) => r.sectionKey !== section)) {
      throw new Error("Linked tables must all be in the same section.");
    }

    const staleGroupIds = Array.from(new Set(rows.map((r) => r.groupId).filter((g): g is string => g != null)));

    const [group] = await tx.insert(tableGroups).values({ venueId }).returning({ id: tableGroups.id });
    await tx.update(venueTables).set({ groupId: group.id }).where(inArray(venueTables.id, ids));

    // Clean up any groups these tables used to belong to that are now empty
    // (e.g. re-linking one table from a pair into a new trio).
    for (const staleId of staleGroupIds) {
      const remaining = await tx
        .select({ id: venueTables.id })
        .from(venueTables)
        .where(eq(venueTables.groupId, staleId));
      if (remaining.length === 0) {
        await tx.delete(tableGroups).where(eq(tableGroups.id, staleId));
      }
    }
  });

  revalidatePath(`/venues/${venueId}`);
}

// Dissolves a linked group back into separate, individually-capacitied
// tables. Guests already seated at the group's member tables are untouched
// — they just go back to being seated "at a table" rather than "in a group".
export async function unlinkGroup(venueId: string, groupId: string) {
  await db.transaction(async (tx) => {
    await tx.update(venueTables).set({ groupId: null }).where(eq(venueTables.groupId, groupId));
    await tx.delete(tableGroups).where(eq(tableGroups.id, groupId));
  });
  revalidatePath(`/venues/${venueId}`);
}

// Moves every member of a linked group to a section together, keeping them
// adjacent at the end of that section's order — the group-level counterpart
// to moveTableToSectionEnd.
export async function moveGroupToSectionEnd(venueId: string, groupId: string, sectionKey: SectionKey) {
  await db.transaction(async (tx) => {
    const members = await tx
      .select()
      .from(venueTables)
      .where(eq(venueTables.groupId, groupId))
      .orderBy(asc(venueTables.order));
    if (members.length === 0) return;

    const siblings = await tx
      .select()
      .from(venueTables)
      .where(and(eq(venueTables.venueId, venueId), eq(venueTables.sectionKey, sectionKey)))
      .orderBy(asc(venueTables.order));
    const memberIds = new Set(members.map((m) => m.id));
    const newList = [...siblings.filter((s) => !memberIds.has(s.id)), ...members];
    for (let i = 0; i < newList.length; i++) {
      await tx.update(venueTables).set({ sectionKey, order: i }).where(eq(venueTables.id, newList[i].id));
    }
  });
  revalidatePath(`/venues/${venueId}`);
}

export async function moveTableBefore(tableId: string, targetTableId: string, venueId: string) {
  await db.transaction(async (tx) => {
    const moved = await tx.query.venueTables.findFirst({ where: eq(venueTables.id, tableId) });
    const target = await tx.query.venueTables.findFirst({ where: eq(venueTables.id, targetTableId) });
    if (!moved || !target || moved.venueId !== target.venueId) return;
    const destSection = target.sectionKey;
    const siblings = await tx
      .select()
      .from(venueTables)
      .where(and(eq(venueTables.venueId, moved.venueId), eq(venueTables.sectionKey, destSection)))
      .orderBy(asc(venueTables.order));
    const withoutMoved = siblings.filter((s) => s.id !== tableId);
    const targetIdx = withoutMoved.findIndex((s) => s.id === targetTableId);
    const newList = [...withoutMoved.slice(0, targetIdx), moved, ...withoutMoved.slice(targetIdx)];
    for (let i = 0; i < newList.length; i++) {
      await tx.update(venueTables).set({ sectionKey: destSection, order: i }).where(eq(venueTables.id, newList[i].id));
    }
  });
  revalidatePath(`/venues/${venueId}`);
}

export async function moveTableToSectionEnd(tableId: string, sectionKey: SectionKey, venueId: string) {
  await db.transaction(async (tx) => {
    const moved = await tx.query.venueTables.findFirst({ where: eq(venueTables.id, tableId) });
    if (!moved) return;
    const siblings = await tx
      .select()
      .from(venueTables)
      .where(and(eq(venueTables.venueId, moved.venueId), eq(venueTables.sectionKey, sectionKey)))
      .orderBy(asc(venueTables.order));
    const newList = [...siblings.filter((s) => s.id !== tableId), moved];
    for (let i = 0; i < newList.length; i++) {
      await tx.update(venueTables).set({ sectionKey, order: i }).where(eq(venueTables.id, newList[i].id));
    }
  });
  revalidatePath(`/venues/${venueId}`);
}
