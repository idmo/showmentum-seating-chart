import { NextResponse } from "next/server";
import { getEventBySlug } from "@/server/queries";
import { deriveView, SECTION_LABELS } from "@/lib/assign";

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function GET(_request: Request, context: { params: Promise<{ shareSlug: string }> }) {
  const { shareSlug } = await context.params;
  const data = await getEventBySlug(shareSlug);
  if (!data) return new NextResponse("Not found", { status: 404 });

  const { event, tables, parties, placements } = data;
  const view = deriveView(tables, parties, placements);

  const header = ["Party Name", "Guests", "Party Size", "Placement Preference", "Section", "Table", "Seats Here"];
  const rows: string[][] = [];

  view.tableState.forEach((table) => {
    table.fragments.forEach((frag) => {
      rows.push([
        frag.party.name,
        frag.members.map((m) => (m.size > 1 ? `${m.name} (${m.size})` : m.name)).join("; "),
        String(frag.party.size),
        frag.party.pref,
        SECTION_LABELS[table.sectionKey],
        `${table.shape} (${table.capacity})`,
        String(frag.count),
      ]);
    });
  });
  view.unassigned.forEach((frag) => {
    rows.push([
      frag.party.name,
      frag.members.map((m) => (m.size > 1 ? `${m.name} (${m.size})` : m.name)).join("; "),
      String(frag.party.size),
      frag.party.pref,
      "Unassigned",
      "",
      String(frag.count),
    ]);
  });

  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const filename = `${event.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "event"}-seating.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
