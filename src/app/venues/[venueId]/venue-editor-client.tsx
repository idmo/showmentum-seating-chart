"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addTables,
  deleteVenue,
  linkTables,
  moveGroupToSectionEnd,
  moveTableToSectionEnd,
  removeTable,
  renameVenue,
  unlinkGroup,
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
  groupId: string | null;
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
  const [linkMode, setLinkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const totalSeats = tables.reduce((sum, t) => sum + t.capacity, 0);

  const groups = new Map<string, VenueTable[]>();
  const standalone: VenueTable[] = [];
  tables.forEach((t) => {
    if (t.groupId) {
      const list = groups.get(t.groupId) ?? [];
      list.push(t);
      groups.set(t.groupId, list);
    } else {
      standalone.push(t);
    }
  });

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirmLink() {
    const ids = Array.from(selected);
    if (ids.length < 2) return;
    startTransition(async () => {
      await linkTables(venueId, ids);
      setSelected(new Set());
      setLinkMode(false);
      onChange();
    });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">{SECTION_LABELS[section]}</h3>
        <div className="flex items-center gap-2">
          <Badge>{tables.length} tables · {totalSeats} seats</Badge>
          {!linkMode && standalone.length >= 2 && (
            <Button size="sm" variant="ghost" onClick={() => setLinkMode(true)}>
              Link tables
            </Button>
          )}
        </div>
      </div>

      {linkMode && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-accent-soft-line bg-accent-soft p-2 text-xs">
          <span className="text-ink-soft">Check 2 or more tables below to combine them into one virtual table.</span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={selected.size < 2 || isPending} onClick={confirmLink}>
              Link {selected.size > 0 ? `${selected.size} ` : ""}tables
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setLinkMode(false);
                setSelected(new Set());
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {[...groups.entries()].map(([groupId, members]) => (
          <GroupedTableCard
            key={groupId}
            venueId={venueId}
            groupId={groupId}
            members={members.slice().sort((a, b) => a.order - b.order)}
            onChange={onChange}
          />
        ))}
        {standalone.map((table) =>
          linkMode ? (
            <SelectableTableRow
              key={table.id}
              table={table}
              selected={selected.has(table.id)}
              onToggle={() => toggleSelected(table.id)}
            />
          ) : (
            <TableCard key={table.id} venueId={venueId} table={table} onChange={onChange} />
          ),
        )}
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

function SelectableTableRow({
  table,
  selected,
  onToggle,
}: {
  table: VenueTable;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm text-ink ${
        selected ? "border-accent bg-accent-soft" : "border-line bg-paper"
      }`}
    >
      <input type="checkbox" checked={selected} onChange={onToggle} />
      {SHAPE_LABELS[table.shape]} · <span className="font-mono-num">{table.capacity}</span> seats
    </label>
  );
}

function GroupedTableCard({
  venueId,
  groupId,
  members,
  onChange,
}: {
  venueId: string;
  groupId: string;
  members: VenueTable[];
  onChange: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const totalCapacity = members.reduce((sum, t) => sum + t.capacity, 0);
  const section = members[0].sectionKey;

  function unlink() {
    if (!confirm("Unlink these tables? Each one goes back to being seated individually.")) return;
    startTransition(async () => {
      await unlinkGroup(venueId, groupId);
      onChange();
    });
  }

  function moveTo(target: SectionKey) {
    startTransition(async () => {
      await moveGroupToSectionEnd(venueId, groupId, target);
      onChange();
    });
  }

  return (
    <div className="rounded-md border border-accent-soft-line bg-accent-soft p-2 sm:col-span-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-ink">
          <span className="font-medium">Linked · {members.length} tables</span>{" "}
          <span className="font-mono-num text-ink-soft">· {totalCapacity} seats total</span>
        </div>
        <div className="flex items-center gap-1">
          {SECTION_KEYS.filter((s) => s !== section).map((s) => (
            <Button
              key={s}
              size="sm"
              variant="ghost"
              onClick={() => moveTo(s)}
              disabled={isPending}
              title={`Move the whole linked group to ${SECTION_LABELS[s]}`}
            >
              → {SECTION_LABELS[s]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={unlink} disabled={isPending}>
            Unlink
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {members.map((m) => (
          <TableCard key={m.id} venueId={venueId} table={m} onChange={onChange} hideMoveButtons />
        ))}
      </div>
    </div>
  );
}

function TableCard({
  venueId,
  table,
  onChange,
  hideMoveButtons = false,
}: {
  venueId: string;
  table: VenueTable;
  onChange: () => void;
  hideMoveButtons?: boolean;
}) {
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
        {!hideMoveButtons &&
          SECTION_KEYS.filter((s) => s !== table.sectionKey).map((s) => (
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
