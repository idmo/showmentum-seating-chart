import Link from "next/link";
import { listVenuesWithEvents } from "@/server/queries";
import { createVenue } from "@/server/venue-actions";
import { Button, EmptyState, Input, Label, Panel, SectionHeading } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const venues = await listVenuesWithEvents();

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <p className="text-xs font-medium uppercase tracking-wide text-accent">Escort Chart</p>
        <h1 className="mt-1 text-2xl font-semibold text-ink">Venues &amp; events</h1>
        <p className="mt-1 text-sm text-ink-soft">
          This page lists every venue and event — it isn&apos;t shared with guests. Each event has its own
          private link for sharing.
        </p>
      </header>

      <div className="space-y-5">
        {venues.length === 0 && (
          <EmptyState
            title="No venues yet"
            subtitle="Create a venue below to start laying out tables and building a seating chart."
          />
        )}

        {venues.map((venue) => (
          <Panel key={venue.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <Link href={`/venues/${venue.id}`} className="text-base font-semibold text-ink hover:text-accent">
                  {venue.name}
                </Link>
                <p className="mt-0.5 text-xs text-ink-soft">{venue.tables.length} tables</p>
              </div>
              <Link href={`/venues/${venue.id}`}>
                <Button size="sm">Edit layout</Button>
              </Link>
            </div>

            {venue.events.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-t border-line">
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
          </Panel>
        ))}
      </div>

      <Panel className="mt-8">
        <SectionHeading title="New venue" subtitle="Give it a name — you'll add sections and tables next." />
        <form action={createVenue} className="flex items-end gap-2">
          <div className="flex-1">
            <Label htmlFor="name">Venue name</Label>
            <Input id="name" name="name" placeholder="Concannon Barrel Room" required />
          </div>
          <Button type="submit" variant="primary">
            Create venue
          </Button>
        </form>
      </Panel>
    </main>
  );
}
