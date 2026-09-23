import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventBySlug } from "@/server/queries";
import { EventBoard } from "./event-board";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ shareSlug: string }> }) {
  const { shareSlug } = await params;
  const data = await getEventBySlug(shareSlug);
  if (!data) notFound();

  const { event, tables, parties, placements } = data;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-4 flex items-center justify-between text-xs text-ink-soft no-print">
        <Link href={`/venues/${event.venueId}`} className="hover:text-accent">
          ← {event.venue.name}
        </Link>
        <div className="flex items-center gap-3">
          <a href={`/e/${event.shareSlug}/export`} className="hover:text-accent">
            Export CSV
          </a>
          <Link href={`/e/${event.shareSlug}/print`} className="hover:text-accent">
            Printable view →
          </Link>
        </div>
      </div>

      <EventBoard
        eventId={event.id}
        shareSlug={event.shareSlug}
        eventName={event.name}
        expectedGuests={event.expectedGuests}
        venueName={event.venue.name}
        venueId={event.venueId}
        tables={tables}
        parties={parties}
        placements={placements}
      />
    </main>
  );
}
