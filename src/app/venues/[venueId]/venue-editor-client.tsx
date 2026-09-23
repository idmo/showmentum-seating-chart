"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addTables,
  deleteVenue,
  moveTableToSectionEnd,
  removeTable,
  renameVenue,
  updateTable,
} from "@/server/venue-actions";
import { SECTION_KEYS, TABLE_SHAPES, type SectionKey, type TableShape } from "@/lib/types";
import { Badge, Button, Input, Label, Panel, Select } from "@/components/ui";

const SECTION_LABELS: Record<SectionKey, string> = { front: "Front", middle: "Middle", back: "Back" };
const SHAPE_LABELS: Record<TableShape, string> = { round: "Round", square: "Square", rectangular: "Rectangular" };

type VenueTable = {
  id: string;
  sectionKey: SectionKey;
  shape: TableShape;
  capacity: number;
  order: number;
};
type Venue = { id: string; name: string; tables: VenueTable[] };

export function VenueEditorClient({ venue }: { venue: Venue }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(venue.name);
  const [editingName, setEditingName] = useState(false);

  function saveName() {
    const trimmed = name.trim();
    setEditingName(false);
    if (!trimmed || trimmed === venue.name) {
      setName(venue.name);
      return;
    }
    startTransition(async () => {
      await renameVenue(venue.id, trimmed);
      router.refresh();
    });
  }

  function handleDelete() {
    if (venue.tables.length > 0 && !confirm(`Delete "${venue.name}"? This can't be undone.`)) return;
    startTransition(async () => {
      try {
        await deleteVenue(venue.id);
        router.push("/");
      } catch {
        alert("Couldn't delete this venue — it may still have events using it. Delete those first.");
      }
    });
  }

  return (
    <Panel className="mt-4">
      <div className="mb-5 flex items-start justify-between gap-3">
        {editingName ? (
          <div className="flex items-center gap-2">
            <Input
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
                if (e.key === "Escape") {
                  setName(venue.name);
                  setEditingName(false);
                }
              }}
              className="text-lg font-semibold"
            />
          </div>
        ) : (
          <h1
            className="cursor-text text-xl font-semibold text-ink hover:text-accent"
            onClick={() => setEditingName(true)}
            title="Click to rename"
          >
            {venue.name}
          </h1>
        )}
        <Button variant="danger" size="sm" onClick={handleDelete} disabled={isPending}>
          Delete venue
        </Button>
      </div>

      <div className="space-y-6">
        {SECTION_KEYS.map((section) => (
          <SectionEditor
            key={section}
            venueId={venue.id}
            section={section}
            tables={venue.tables.filter((t) => t.sectionKey === section).sort((a, b) => a.order - b.order)}
            onChange={() => router.refresh()}
          />
        ))}
      </div>
    </Panel>
  );
}

function SectionEditor({
  venueId,
  section,
  tables,
  onChange,
}: {
  venueId: string;
  section: SectionKey;
  tables: VenueTable[];
  onChange: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const totalSeats = tables.reduce((sum, t) => sum + t.capacity, 0);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{SECTION_LABELS[section]}</h3>
        <Badge>{tables.length} tables · {totalSeats} seats</Badge>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {tables.map((table) => (
          <TableCard key={table.id} venueId={venueId} table={table} onChange={onChange} />
        ))}
      </div>

      <form
        className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-dashed border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          // Capture the form element synchronously — e.currentTarget is
          // nulled out by React once the event handler returns, so it can't
          // be read from inside the async startTransition callback below.
          const formEl = e.currentTarget;
          const form = new FormData(formEl);
          const shape = String(form.get("shape")) as TableShape;
          const capacity = Number(form.get("capacity"));
          const count = Number(form.get("count"));
          startTransition(async () => {
            await addTables(venueId, section, shape, capacity, count);
            formEl.reset();
            onChange();
          });
        }}
      >
        <div className="w-32">
          <Label>Shape</Label>
          <Select name="shape" defaultValue="round">
            {TABLE_SHAPES.map((s) => (
              <option key={s} value={s}>
                {SHAPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-24">
          <Label>Seats</Label>
          <Input name="capacity" type="number" min={1} defaultValue={8} required />
        </div>
        <div className="w-20">
          <Label>Count</Label>
          <Input name="count" type="number" min={1} defaultValue={1} required />
        </div>
        <Button type="submit" size="sm" disabled={isPending}>
          Add tables
        </Button>
      </form>
    </div>
  );
}

function TableCard({ venueId, table, onChange }: { venueId: string; table: VenueTable; onChange: () => void }) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [shape, setShape] = useState(table.shape);
  const [capacity, setCapacity] = useState(table.capacity);

  function save() {
    setEditing(false);
    startTransition(async () => {
      await updateTable(table.id, venueId, { shape, capacity });
      onChange();
    });
  }

  function remove() {
    if (!confirm("Remove this table? Anyone seated there moves to the unassigned tray.")) return;
    startTransition(async () => {
      await removeTable(table.id, venueId);
      onChange();
    });
  }

  function moveTo(section: SectionKey) {
    startTransition(async () => {
      await moveTableToSectionEnd(table.id, section, venueId);
      onChange();
    });
  }

  if (editing) {
    return (
      <div className="flex items-end gap-2 rounded-md border border-accent-soft-line bg-accent-soft p-2">
        <div className="w-28">
          <Label>Shape</Label>
          <Select value={shape} onChange={(e) => setShape(e.target.value as TableShape)}>
            {TABLE_SHAPES.map((s) => (
              <option key={s} value={s}>
                {SHAPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-20">
          <Label>Seats</Label>
          <Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
        </div>
        <Button size="sm" variant="primary" onClick={save} disabled={isPending}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-line bg-paper px-3 py-2">
      <div className="text-sm text-ink">
        {SHAPE_LABELS[table.shape]} · <span className="font-mono-num">{table.capacity}</span> seats
      </div>
      <div className="flex items-center gap-1">
        {SECTION_KEYS.filter((s) => s !== table.sectionKey).map((s) => (
          <Button key={s} size="sm" variant="ghost" onClick={() => moveTo(s)} disabled={isPending} title={`Move to ${SECTION_LABELS[s]}`}>
            → {SECTION_LABELS[s]}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={remove} disabled={isPending}>
          Remove
        </Button>
      </div>
    </div>
  );
}
