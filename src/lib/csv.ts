// CSV parsing and guest-row grouping. Ported from the original single-file
// artifact tool, unchanged in behavior (including the normGroupKey fix for
// the party-collision bug found in that version).

import type { PartyPref } from "./types";

export interface ParsedMember {
  name: string;
  size: number;
}

export interface ParsedGroup {
  groupKey: string;
  name: string;
  pref: PartyPref;
  size: number;
  members: ParsedMember[];
}

export interface ParseResult {
  groups: ParsedGroup[];
  errors: string[];
  warnings: string[];
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const NAME_KEYS = [
  "name", "guestname", "guest", "purchaser", "buyer", "ticketholder",
  "contact", "host", "attendee", "lastname",
];
const PARTY_KEYS = [
  "party", "partyname", "seatwith", "seatedwith", "sitwith", "sittingwith",
  "group", "groupname", "tablewith", "withparty", "seatinggroup",
  "seatgroup", "tablename",
];
const SIZE_KEYS = [
  "size", "partysize", "count", "guests", "seats", "number", "num", "qty",
  "quantity", "headcount", "people", "pax", "tickets",
];
const SECTION_KEYS = [
  "section", "location", "area", "zone", "preference", "pref", "seating",
  "seatingpreference", "tablepreference", "placement", "placementpreference",
];

// Used only for matching CSV header names against the keyword lists above —
// safe to strip digits/punctuation there since header names are simple
// words. NOT used for party grouping (see normGroupKey).
function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

// Used for grouping rows into parties, and for reconciling parties across a
// re-uploaded CSV. Must NOT collapse distinct names together the way norm()
// does — it keeps letters and digits and just normalizes case/whitespace, so
// e.g. "Tom Lemmons" and "Tom Lemmons 2" stay separate groups.
export function normGroupKey(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

interface ColumnIndex {
  name: number;
  party: number;
  size: number;
  section: number;
}

function detectColumns(header: string[]): ColumnIndex {
  const idx: ColumnIndex = { name: -1, party: -1, size: -1, section: -1 };
  header.forEach((h, i) => {
    const n = norm(h);
    if (idx.name === -1 && NAME_KEYS.includes(n)) idx.name = i;
    if (idx.party === -1 && PARTY_KEYS.includes(n)) idx.party = i;
    if (idx.size === -1 && SIZE_KEYS.includes(n)) idx.size = i;
    if (idx.section === -1 && SECTION_KEYS.includes(n)) idx.section = i;
  });
  if (idx.name === -1) idx.name = 0;
  if (idx.size === -1) idx.size = 1;
  if (idx.section === -1) idx.section = 2;
  return idx;
}

export function normalizePref(raw: unknown): PartyPref {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "any";
  if (v[0] === "f") return "front";
  if (v[0] === "m") return "middle";
  if (v[0] === "b") return "back";
  return "any";
}

function capitalize(s: string): string {
  if (!s || s === "any") return "Any";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Parses rows, then groups them by party (who each row wants to sit with).
// Rows that share a party are merged into one seating group; if no party
// column is present, each row is its own group (its own name).
export function parseGuestList(text: string): ParseResult {
  const rows = parseCSV(text);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!rows.length) return { groups: [], errors, warnings };

  const cols = detectColumns(rows[0]);
  const hasPartyCol = cols.party !== -1;

  interface RawGroup {
    name: string;
    size: number;
    members: ParsedMember[];
    prefs: PartyPref[];
  }
  const groups: RawGroup[] = [];
  const groupByKey = new Map<string, RawGroup>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const name = (row[cols.name] || "").trim();
    const sizeRaw = (row[cols.size] || "").trim();
    const size = parseInt(sizeRaw, 10);
    const pref = normalizePref(row[cols.section]);
    const partyRaw = hasPartyCol ? (row[cols.party] || "").trim() : "";
    if (!name) {
      errors.push(`Row ${r + 1}: missing a name, skipped.`);
      continue;
    }
    if (!size || size < 1 || isNaN(size)) {
      errors.push(`Row ${r + 1} (“${name}”): couldn’t read a size, skipped.`);
      continue;
    }

    const displayName = partyRaw || name;
    const key = normGroupKey(displayName) || `row${r}`;

    let group = groupByKey.get(key);
    if (!group) {
      group = { name: displayName, size: 0, members: [], prefs: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.members.push({ name, size });
    group.size += size;
    if (pref !== "any") group.prefs.push(pref);
  }

  const result: ParsedGroup[] = groups.map((g, i) => {
    const counts: Partial<Record<PartyPref, number>> = {};
    g.prefs.forEach((p) => {
      counts[p] = (counts[p] || 0) + 1;
    });
    const distinct = Object.keys(counts) as PartyPref[];
    let resolved: PartyPref = "any";
    if (distinct.length === 1) {
      resolved = distinct[0];
    } else if (distinct.length > 1) {
      let max = -1;
      g.prefs.forEach((p) => {
        const c = counts[p] || 0;
        if (c > max) {
          max = c;
          resolved = p;
        }
      });
      warnings.push(
        `“${g.name}” had mixed section requests (${distinct.map(capitalize).join(", ")}) — used ${capitalize(resolved)}.`,
      );
    }
    return {
      groupKey: normGroupKey(g.name) || `row${i}`,
      name: g.name,
      size: g.size,
      pref: resolved,
      members: g.members,
    };
  });

  return { groups: result, errors, warnings };
}
