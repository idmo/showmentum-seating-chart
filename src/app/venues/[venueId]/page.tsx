import Link from "next/link";
import { notFound } from "next/navigation";
import { getVenueDetail } from "@/server/queries";
import { createEvent } from "@/server/event-actions";
import { Button, Input, Label, Panel, SectionHeading } from "@/components/ui";
import { VenueEditorClient } from "./venue-editor-client";

export const dynamic = "force-dynamic";

export default async function VenuePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = await params;
  const venue = await getVenueDetail(venueId);
  if (!venue) notFound();

  const createEventForVenue = createEvent.bind(null, venue.id);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Link href="/" className="text-xs font-medium text-ink-soft hover:text-accent">
        ← All venues
      </Link>

      <VenueEditorClient venue={venue} />

      <Panel className="mt-6">
        <SectionHeading title="Events at this venue" subtitle="Each event gets its own private, shareable seating-chart link." />
        {venue.events.length > 0 && (
          <ul className="mb-4 divide-y divide-line border-y border-line">
            {venue.events.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 py-2">
                <span className="text-sm text-ink">{event.name}</span>
                <Link href={`/e/${event.shareSlug}`} className="text-xs font-medium text-accent hover:underline">
                  Open seating chart →
                </Link>
              </li>
            ))}
          </ul>
        )}
        <form action={createEventForVenue} className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="name">New event name</Label>
            <Input id="name" name="name" placeholder="Friday Night Show — Sept 26" required />
          </div>
          <div className="w-36">
            <Label htmlFor="expectedGuests">Expected guests</Label>
            <Input id="expectedGuests" name="expectedGuests" type="number" min={0} placeholder="Optional" />
          </div>
          <Button type="submit" variant="primary">
            Create event
          </Button>
        </form>
      </Panel>
    </main>
  );
}
