import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { SectionKey, TableShape, PartyPref } from "../lib/types";
export { SECTION_KEYS, TABLE_SHAPES, PARTY_PREFS } from "../lib/types";
export type { SectionKey, TableShape, PartyPref } from "../lib/types";

// ---------------------------------------------------------------------------
// Venues — a reusable table layout (e.g. "Concannon Vineyard — Barrel Room").
// A venue owns its tables directly; sections are the fixed front/middle/back
// zones used by the seating algorithm's hard section-preference requirement.
// ---------------------------------------------------------------------------
export const venues = pgTable("venues", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A table_groups row is a "virtual table": two or more venue_tables linked
// together to act as one bigger unit (e.g. two 4-tops pushed together for a
// 7-top party). Capacity pools across the group's members; individual
// members keep their own row (own shape/capacity/order) for physical setup,
// print layout, and per-member editing. A group is always confined to one
// section — see the linkTables/unlinkGroup actions.
export const tableGroups = pgTable(
  "table_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("table_groups_venue_id_idx").on(t.venueId)],
);

export const venueTables = pgTable(
  "venue_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id, { onDelete: "cascade" }),
    sectionKey: text("section_key").$type<SectionKey>().notNull(),
    shape: text("shape").$type<TableShape>().notNull(),
    capacity: integer("capacity").notNull(),
    order: integer("order").notNull().default(0),
    groupId: uuid("group_id").references(() => tableGroups.id, { onDelete: "set null" }),
  },
  (t) => [
    index("venue_tables_venue_id_idx").on(t.venueId),
    index("venue_tables_group_id_idx").on(t.groupId),
  ],
);

// ---------------------------------------------------------------------------
// Events — one guest list + seating chart, bound to exactly one venue.
// shareSlug is a long unguessable token: the event's private, shareable URL.
// There is no login — the shareSlug IS the access control, by design (the
// dashboard listing all venues/events is a separate, unshared URL).
// ---------------------------------------------------------------------------
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  venueId: uuid("venue_id")
    .notNull()
    .references(() => venues.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  expectedGuests: integer("expected_guests"),
  shareSlug: text("share_slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Parties — one seating group within an event, reconciled by groupKey across
// CSV re-uploads so manual seating survives a corrected guest list. `active`
// is a soft-delete flag: a party dropped from a re-uploaded CSV is marked
// inactive (and its seats freed) rather than deleted outright.
// ---------------------------------------------------------------------------
export const parties = pgTable(
  "parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    name: text("name").notNull(),
    pref: text("pref").$type<PartyPref>().notNull().default("any"),
    size: integer("size").notNull(),
    active: boolean("active").notNull().default(true),
    // Night-of guest check-in — null until someone taps "Check in" on the
    // guest list; set back to null if it's toggled off. Distinct from
    // seating (placements): a party can be seated but not yet checked in,
    // or checked in before their table is finalized.
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("parties_event_id_idx").on(t.eventId),
    // Only one *active* party per group key within an event — an inactive
    // (soft-deleted) party doesn't block a new party from reusing the name.
    uniqueIndex("parties_event_group_key_active_idx")
      .on(t.eventId, t.groupKey)
      .where(sql`${t.active} = true`),
  ],
);

// Named members within a party (from CSV rows sharing that party name),
// kept in insertion order so a split can distribute them fragment-by-fragment.
export const partyMembers = pgTable(
  "party_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    order: integer("order").notNull().default(0),
  },
  (t) => [index("party_members_party_id_idx").on(t.partyId)],
);

// ---------------------------------------------------------------------------
// Placements — one row per seated (or unassigned) fragment of a party.
// tableId=null means "unassigned pool". A party normally has exactly one
// placement row; a manual or drag-triggered split replaces one row with
// several, all summing to the original row's count, so any party can be
// spread across any number of tables (or unassigned fragments).
// ---------------------------------------------------------------------------
export const placements = pgTable(
  "placements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partyId: uuid("party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    tableId: uuid("table_id").references(() => venueTables.id, { onDelete: "set null" }),
    count: integer("count").notNull(),
    order: integer("order").notNull().default(0),
    // Only meaningful when tableId is null: why auto-assign couldn't seat
    // this fragment (e.g. "front is full"). Cleared on any manual move.
    reason: text("reason"),
  },
  (t) => [
    index("placements_party_id_idx").on(t.partyId),
    index("placements_table_id_idx").on(t.tableId),
  ],
);

// ---------------------------------------------------------------------------
// Relations — power the db.query.* relational query API used by the read
// side (src/server/queries.ts).
// ---------------------------------------------------------------------------
export const venuesRelations = relations(venues, ({ many }) => ({
  tables: many(venueTables),
  events: many(events),
}));

export const tableGroupsRelations = relations(tableGroups, ({ one, many }) => ({
  venue: one(venues, { fields: [tableGroups.venueId], references: [venues.id] }),
  tables: many(venueTables),
}));

export const venueTablesRelations = relations(venueTables, ({ one, many }) => ({
  venue: one(venues, { fields: [venueTables.venueId], references: [venues.id] }),
  group: one(tableGroups, { fields: [venueTables.groupId], references: [tableGroups.id] }),
  placements: many(placements),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  venue: one(venues, { fields: [events.venueId], references: [venues.id] }),
  parties: many(parties),
}));

export const partiesRelations = relations(parties, ({ one, many }) => ({
  event: one(events, { fields: [parties.eventId], references: [events.id] }),
  members: many(partyMembers),
  placements: many(placements),
}));

export const partyMembersRelations = relations(partyMembers, ({ one }) => ({
  party: one(parties, { fields: [partyMembers.partyId], references: [parties.id] }),
}));

export const placementsRelations = relations(placements, ({ one }) => ({
  party: one(parties, { fields: [placements.partyId], references: [parties.id] }),
  table: one(venueTables, { fields: [placements.tableId], references: [venueTables.id] }),
}));
