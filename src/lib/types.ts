// Shared domain vocabulary. Kept independent of the database layer so the
// pure logic in this directory (csv/assign/reconcile) has zero dependency
// on Drizzle or Postgres and can be unit-tested with a plain test runner.

export const SECTION_KEYS = ["front", "middle", "back"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export const TABLE_SHAPES = ["round", "square", "rectangular"] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

export const PARTY_PREFS = ["front", "middle", "back", "any"] as const;
export type PartyPref = (typeof PARTY_PREFS)[number];
