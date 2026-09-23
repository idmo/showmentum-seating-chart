import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventBySlug } from "@/server/queries";
import { deriveView, SECTION_LABELS, SECTION_ORDER } from "@/lib/assign";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

function memberList(members: { name: string; size: number }[]) {
  return members.map((m) => (m.size > 1 ? `${m.name} (${m.size})` : m.name)).join(", ");
}

export default async function PrintPage({ params }: { params: Promise<{ shareSlug: string }> }) {
  const { shareSlug } = await params;
  const data = await getEventBySlug(shareSlug);
  if (!data) notFound();

  const { event, tables, parties, placements } = data;
  const view = deriveView(tables, parties, placements);

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between no-print">
        <Link href={`/e/${event.shareSlug}`} className="text-xs font-medium text-ink-soft hover:text-accent">
          ← Back to seating chart
        </Link>
        <div className="flex items-center gap-2">
          <a href={`/e/${event.shareSlug}/export`} className="text-xs font-medium text-accent hover:underline">
            Export CSV
          </a>
          <PrintButton />
        </div>
      </div>

      <header className="mb-6 border-b border-line pb-4">
        <p className="text-xs uppercase tracking-wide text-accent">{event.venue.name}</p>
        <h1 className="text-2xl font-semibold text-ink">{event.name}</h1>
      </header>

      {SECTION_ORDER.map((section) => {
        const sectionTables = [...view.tableState.values()]
          .filter((t) => t.sectionKey === section)
          .sort((a, b) => a.order - b.order);
        if (sectionTables.length === 0) return null;
        return (
          <section key={section} className="mb-6 break-inside-avoid">
            <h2 className="mb-2 text-lg font-semibold text-ink">{SECTION_LABELS[section]}</h2>
            <div className="space-y-3">
              {sectionTables.map((table, idx) => (
                <div key={table.id} className="break-inside-avoid rounded border border-line p-3">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-soft">
                    Table {idx + 1} · {table.shape} · {table.capacity} seats
                  </p>
                  {table.fragments.length === 0 ? (
                    <p className="text-sm text-ink-faint">Empty</p>
                  ) : (
                    <ul className="text-sm text-ink">
                      {table.fragments
                        .slice()
                        .sort((a, b) => a.order - b.order)
                        .map((frag) => (
                          <li key={frag.placementId}>
                            <span className="font-medium">{frag.party.name}</span>
                            {frag.members.length > 0 && <span className="text-ink-soft"> — {memberList(frag.members)}</span>}
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}

      {view.unassigned.length > 0 && (
        <section className="break-inside-avoid">
          <h2 className="mb-2 text-lg font-semibold text-ink">Unassigned</h2>
          <ul className="text-sm text-ink">
            {view.unassigned.map((frag) => (
              <li key={frag.placementId}>
                <span className="font-medium">{frag.party.name}</span> — {frag.count} guests
                {frag.members.length > 0 && <span className="text-ink-soft"> ({memberList(frag.members)})</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
