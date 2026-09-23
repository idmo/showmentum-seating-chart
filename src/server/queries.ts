import "server-only";
import { db, schema } from "@/db";
import { and, asc, eq } from "drizzle-orm";
import type { PartyInput, PlacementInput, TableInput } from "@/lib/assign";

export async function listVenuesWithEvents() {
  const venues = await db.query.venues.findMany({
    orderBy: asc(schema.venues.name),
    with: {
      tables: true,
      events: { orderBy: asc(schema.events.name) },
    },
  });
  return venues;
}

export async function getVenue(venueId: string) {
  return db.query.venues.findFirst({
    where: eq(schema.venues.id, venueId),
    with: { tables: { orderBy: asc(schema.venueTables.order) } },
  });
}

export async function getVenueDetail(venueId: string) {
  return db.query.venues.findFirst({
    where: eq(schema.venues.id, venueId),
    with: {
      tables: { orderBy: asc(schema.venueTables.order) },
      events: { orderBy: asc(schema.events.name) },
    },
  });
}

export async function getEventBySlug(shareSlug: string) {
  const event = await db.query.events.findFirst({
    where: eq(schema.events.shareSlug, shareSlug),
    with: {
      venue: { with: { tables: { orderBy: asc(schema.venueTables.order) } } },
    },
  });
  if (!event) return null;

  const activeParties = await db.query.parties.findMany({
    where: and(eq(schema.parties.eventId, event.id), eq(schema.parties.active, true)),
    with: {
      members: { orderBy: asc(schema.partyMembers.order) },
      placements: { orderBy: asc(schema.placements.order) },
    },
  });

  const tables: TableInput[] = event.venue.tables.map((t) => ({
    id: t.id,
    sectionKey: t.sectionKey,
    shape: t.shape,
    capacity: t.capacity,
    order: t.order,
    groupId: t.groupId,
  }));
  const parties: PartyInput[] = activeParties.map((p) => ({
    id: p.id,
    name: p.name,
    pref: p.pref,
    size: p.size,
    members: p.members.map((m) => ({ name: m.name, size: m.size })),
    checkedInAt: p.checkedInAt ? p.checkedInAt.toISOString() : null,
  }));
  const placements: PlacementInput[] = activeParties.flatMap((p) =>
    p.placements.map((pl) => ({
      id: pl.id,
      partyId: p.id,
      tableId: pl.tableId,
      count: pl.count,
      order: pl.order,
      reason: pl.reason,
    })),
  );

  return { event, tables, parties, placements };
}
