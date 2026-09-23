"use server";

import { db, schema } from "@/db";
import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { SECTION_KEYS, type SectionKey, type TableShape } from "@/lib/types";

const { venues, venueTables, placements } = schema;

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
  changes: { shape?: TableShape; capacity?: number },
) {
  const patch: Partial<typeof venueTables.$inferInsert> = {};
  if (changes.shape) patch.shape = changes.shape;
  if (changes.capacity !== undefined) {
    if (!Number.isFinite(changes.capacity) || changes.capacity < 1) {
      throw new Error("Capacity must be at least 1.");
    }
    patch.capacity = Math.floor(changes.capacity);
  }
  if (Object.keys(patch).length === 0) return;
  await db.update(venueTables).set(patch).where(eq(venueTables.id, tableId));
  revalidatePath(`/venues/${venueId}`);
}

export async function removeTable(tableId: string, venueId: string) {
  await db.transaction(async (tx) => {
    // Attach a reason before the FK's ON DELETE SET NULL clears tableId, so
    // anyone seated there shows up in the tray with an explanation instead
    // of a blank one.
    await tx
      .update(placements)
      .set({ reason: "this table was removed from the venue" })
      .where(eq(placements.tableId, tableId));
    await tx.delete(venueTables).where(eq(venueTables.id, tableId));
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
