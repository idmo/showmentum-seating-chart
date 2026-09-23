"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  deriveView,
  SECTION_LABELS,
  SECTION_ORDER,
  type PartyInput,
  type PlacementInput,
  type TableFragmentView,
  type TableInput,
  type TableStateView,
  type UnassignedFragmentView,
} from "@/lib/assign";
import { movePlacement, renameEvent, runAutoAssignAction, splitPlacement, uploadGuestList } from "@/server/event-actions";
import { Badge, Button, Input, Label, Panel, SectionHeading, StatTile, Textarea } from "@/components/ui";

type Props = {
  eventId: string;
  shareSlug: string;
  eventName: string;
  expectedGuests: number | null;
  venueName: string;
  tables: TableInput[];
  parties: PartyInput[];
  placements: PlacementInput[];
};

type UploadResult = { errors: string[]; warnings: string[]; created: number; updated: number; removed: number };

function memberList(members: { name: string; size: number }[]) {
  return members.map((m) => (m.size > 1 ? `${m.name} (${m.size})` : m.name)).join(", ");
}

export function EventBoard(props: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [csvText, setCsvText] = useState("");
  const [splitTarget, setSplitTarget] = useState<{ placementId: string; partyName: string; count: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const view = useMemo(
    () => deriveView(props.tables, props.parties, props.placements),
    [props.tables, props.parties, props.placements],
  );

  const totalGuests = props.parties.reduce((s, p) => s + p.size, 0);
  const seatedSeats = props.placements.filter((p) => p.tableId).reduce((s, p) => s + p.count, 0);
  const unassignedSeats = totalGuests - seatedSeats;
  const totalSeatsAvailable = props.tables.reduce((s, t) => s + t.capacity, 0);

  function refresh() {
    router.refresh();
  }

  function handleUpload() {
    if (!csvText.trim()) return;
    startTransition(async () => {
      const result = await uploadGuestList(props.eventId, csvText);
      setUploadResult(result);
      refresh();
    });
  }

  function handleFile(file: File) {
    file.text().then((text) => setCsvText(text));
  }

  function handleAutoAssign() {
    startTransition(async () => {
      await runAutoAssignAction(props.eventId);
      refresh();
    });
  }

  function handleDrop(targetTableId: string | null, placementId: string) {
    startTransition(async () => {
      await movePlacement(props.eventId, placementId, targetTableId);
      refresh();
    });
  }

  function handleSplitSubmit(counts: number[]) {
    if (!splitTarget) return;
    const id = splitTarget.placementId;
    startTransition(async () => {
      try {
        await splitPlacement(props.eventId, id, counts);
        setSplitTarget(null);
        refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Couldn't split that group.");
      }
    });
  }

  return (
    <div className="space-y-6">
      <EventHeader
        eventId={props.eventId}
        eventName={props.eventName}
        venueName={props.venueName}
        onRenamed={refresh}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 no-print">
        <StatTile label="Guests" value={totalGuests} tone="accent" />
        <StatTile label="Seated" value={seatedSeats} />
        <StatTile label="Unassigned" value={unassignedSeats} />
        <StatTile label="Seats available" value={totalSeatsAvailable} />
      </div>

      <Panel className="no-print">
        <SectionHeading
          title="Guest list"
          subtitle="Upload a CSV (guest name, party size, party name, placement). Re-uploading reconciles with what's already seated — matched parties keep their tables."
          action={
            <Button variant="primary" size="sm" onClick={handleUpload} disabled={isPending || !csvText.trim()}>
              Upload &amp; reconcile
            </Button>
          }
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex-1">
            <Textarea
              rows={4}
              placeholder="Paste CSV text here, or choose a file below…"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
          </label>
        </div>
        <input
          type="file"
          accept=".csv,text/csv"
          className="mt-2 text-xs text-ink-soft"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />

        {uploadResult && (
          <div className="mt-3 rounded-md border border-line bg-paper p-3 text-xs">
            <p className="font-medium text-ink">
              {uploadResult.created} added · {uploadResult.updated} updated · {uploadResult.removed} removed
            </p>
            {uploadResult.errors.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-state-danger">
                {uploadResult.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            {uploadResult.warnings.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-state-warn">
                {uploadResult.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      <Panel className="no-print">
        <SectionHeading
          title="Unassigned"
          subtitle="Drag a card onto a table below to seat it, or split it first to seat pieces separately."
          action={
            <Button size="sm" onClick={handleAutoAssign} disabled={isPending || view.unassigned.length === 0}>
              Auto-seat unassigned
            </Button>
          }
        />
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/plain");
            if (id) handleDrop(null, id);
          }}
          className="flex min-h-16 flex-wrap gap-2 rounded-md border border-dashed border-line p-2"
        >
          {view.unassigned.length === 0 && <p className="p-2 text-xs text-ink-faint">Nothing unassigned.</p>}
          {view.unassigned
            .slice()
            .sort((a, b) => b.count - a.count)
            .map((frag) => (
              <UnassignedCard
                key={frag.placementId}
                frag={frag}
                dragging={draggingId === frag.placementId}
                onDragStart={() => setDraggingId(frag.placementId)}
                onDragEnd={() => setDraggingId(null)}
                onSplit={() => setSplitTarget({ placementId: frag.placementId, partyName: frag.party.name, count: frag.count })}
              />
            ))}
        </div>
      </Panel>

      {SECTION_ORDER.map((section) => (
        <Panel key={section}>
          <SectionHeading title={SECTION_LABELS[section]} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...view.tableState.values()]
              .filter((t) => t.sectionKey === section)
              .sort((a, b) => a.order - b.order)
              .map((table) => (
                <TableDropCard
                  key={table.id}
                  table={table}
                  reassigned={view.reassigned}
                  onDrop={(placementId) => handleDrop(table.id, placementId)}
                  onDragStartFragment={setDraggingId}
                  onDragEndFragment={() => setDraggingId(null)}
                  draggingId={draggingId}
                  onSplit={(frag) => setSplitTarget({ placementId: frag.placementId, partyName: frag.party.name, count: frag.count })}
                />
              ))}
            {[...view.tableState.values()].filter((t) => t.sectionKey === section).length === 0 && (
              <p className="text-xs text-ink-faint">No tables in this section yet — add some from the venue editor.</p>
            )}
          </div>
        </Panel>
      ))}

      <GuestListTable parties={props.parties} view={view} />

      {splitTarget && (
        <SplitModal
          partyName={splitTarget.partyName}
          count={splitTarget.count}
          isPending={isPending}
          onCancel={() => setSplitTarget(null)}
          onSubmit={handleSplitSubmit}
        />
      )}
    </div>
  );
}

function EventHeader({
  eventId,
  eventName,
  venueName,
  onRenamed,
}: {
  eventId: string;
  eventName: string;
  venueName: string;
  onRenamed: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(eventName);

  function save() {
    setEditing(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === eventName) {
      setName(eventName);
      return;
    }
    startTransition(async () => {
      await renameEvent(eventId, trimmed, null);
      onRenamed();
    });
  }

  return (
    <header>
      <p className="text-xs font-medium uppercase tracking-wide text-accent">{venueName}</p>
      {editing ? (
        <Input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setName(eventName);
              setEditing(false);
            }
          }}
          className="mt-1 text-2xl font-semibold"
        />
      ) : (
        <h1
          className="mt-1 cursor-text text-2xl font-semibold text-ink hover:text-accent no-print"
          onClick={() => setEditing(true)}
          title="Click to rename"
        >
          {eventName}
        </h1>
      )}
      <h1 className="mt-1 hidden text-2xl font-semibold text-ink print:block">{eventName}</h1>
      {isPending && <p className="text-xs text-ink-faint">Saving…</p>}
    </header>
  );
}

function UnassignedCard({
  frag,
  dragging,
  onDragStart,
  onDragEnd,
  onSplit,
}: {
  frag: UnassignedFragmentView;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSplit: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", frag.placementId);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`w-56 cursor-grab rounded-md border px-2.5 py-2 text-xs shadow-sm active:cursor-grabbing ${
        dragging ? "opacity-40" : ""
      } ${frag.party.pref !== "any" ? "border-accent-soft-line bg-accent-soft" : "border-line bg-paper"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-ink">{frag.party.name}</span>
        <div className="flex items-center gap-1">
          <Badge tone={frag.party.pref !== "any" ? "accent" : "neutral"}>
            {frag.count} {frag.party.pref !== "any" ? `· ${frag.party.pref}` : ""}
          </Badge>
        </div>
      </div>
      {frag.members.length > 0 && <p className="mt-1 text-ink-soft">{memberList(frag.members)}</p>}
      {frag.reason && <p className="mt-1 text-state-warn">{frag.reason}</p>}
      <button onClick={onSplit} className="mt-1 text-[11px] font-medium text-accent hover:underline">
        Split…
      </button>
    </div>
  );
}

function TableDropCard({
  table,
  reassigned,
  onDrop,
  onDragStartFragment,
  onDragEndFragment,
  draggingId,
  onSplit,
}: {
  table: TableStateView;
  reassigned: (f: TableFragmentView) => boolean;
  onDrop: (placementId: string) => void;
  onDragStartFragment: (id: string) => void;
  onDragEndFragment: () => void;
  draggingId: string | null;
  onSplit: (f: TableFragmentView) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/plain");
        if (id) onDrop(id);
      }}
      className={`rounded-lg border p-2.5 transition-colors ${
        over ? "border-accent bg-accent-soft" : table.overCapacity ? "border-state-danger/40 bg-state-danger-soft" : "border-line bg-paper"
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-ink">
          {table.shape} · {table.capacity} seats
        </span>
        <div className="flex items-center gap-1">
          {table.isPrivate && <Badge tone="accent">private</Badge>}
          {table.overCapacity && <Badge tone="danger">over capacity</Badge>}
          <span className="font-mono-num text-ink-soft">
            {table.usedSeats}/{table.capacity}
          </span>
        </div>
      </div>
      <div className="space-y-1.5">
        {table.fragments.length === 0 && <p className="text-[11px] text-ink-faint">Empty</p>}
        {table.fragments
          .slice()
          .sort((a, b) => a.order - b.order)
          .map((frag) => (
            <div
              key={frag.placementId}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", frag.placementId);
                onDragStartFragment(frag.placementId);
              }}
              onDragEnd={onDragEndFragment}
              className={`cursor-grab rounded border border-line-strong/60 bg-paper-raised px-2 py-1 text-xs active:cursor-grabbing ${
                draggingId === frag.placementId ? "opacity-40" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">
                  {frag.party.name}
                  {frag.isPartial && <span className="text-ink-faint"> (part)</span>}
                </span>
                <div className="flex items-center gap-1">
                  {reassigned(frag) && <Badge tone="warn">moved from {frag.party.pref}</Badge>}
                  <span className="font-mono-num text-ink-soft">{frag.count}</span>
                </div>
              </div>
              {frag.members.length > 0 && <p className="mt-0.5 text-ink-soft">{memberList(frag.members)}</p>}
              <button
                onClick={() => onSplit(frag)}
                className="mt-0.5 text-[11px] font-medium text-accent hover:underline no-print"
              >
                Split…
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

function SplitModal({
  partyName,
  count,
  isPending,
  onCancel,
  onSubmit,
}: {
  partyName: string;
  count: number;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (counts: number[]) => void;
}) {
  const initial = count >= 2 ? [Math.ceil(count / 2), Math.floor(count / 2)] : [count, 0];
  const [parts, setParts] = useState<number[]>(initial);

  const sum = parts.reduce((a, b) => a + b, 0);
  const valid = parts.every((p) => Number.isInteger(p) && p >= 1) && sum === count && parts.length >= 2;

  function update(i: number, value: number) {
    setParts((prev) => prev.map((p, idx) => (idx === i ? value : p)));
  }
  function addPart() {
    setParts((prev) => [...prev, 0]);
  }
  function removePart(i: number) {
    setParts((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 no-print">
      <Panel className="w-full max-w-sm">
        <SectionHeading title={`Split ${partyName}`} subtitle={`Currently ${count} guests together — divide into pieces that add up to ${count}.`} />
        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <Label className="mb-0 w-16 shrink-0">Piece {i + 1}</Label>
              <Input type="number" min={1} max={count} value={p} onChange={(e) => update(i, Number(e.target.value))} />
              {parts.length > 2 && (
                <Button size="sm" variant="ghost" onClick={() => removePart(i)}>
                  ✕
                </Button>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <button onClick={addPart} className="font-medium text-accent hover:underline">
            + Add another piece
          </button>
          <span className={sum === count ? "text-state-ok" : "text-state-danger"}>
            {sum} / {count}
          </span>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || isPending} onClick={() => onSubmit(parts)}>
            Split
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function GuestListTable({
  parties,
  view,
}: {
  parties: PartyInput[];
  view: ReturnType<typeof deriveView>;
}) {
  const tableLabel = (tableId: string) => {
    const t = view.tableState.get(tableId);
    if (!t) return "—";
    return `${SECTION_LABELS[t.sectionKey]} · ${t.shape} (${t.capacity})`;
  };

  const rows = parties
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((party) => {
      const seated: string[] = [];
      const unassignedCount = view.unassigned.filter((u) => u.party.id === party.id).reduce((s, u) => s + u.count, 0);
      view.tableState.forEach((t) => {
        t.fragments
          .filter((f) => f.party.id === party.id)
          .forEach((f) => seated.push(`${tableLabel(t.id)} ×${f.count}`));
      });
      return { party, seated, unassignedCount };
    });

  return (
    <Panel>
      <SectionHeading title="Guest list" subtitle="Every party, where they're seated, and who's sitting with whom." />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
              <th className="py-1.5 pr-3">Party</th>
              <th className="py-1.5 pr-3">Guests</th>
              <th className="py-1.5 pr-3">Size</th>
              <th className="py-1.5 pr-3">Placement</th>
              <th className="py-1.5 pr-3">Seated at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ party, seated, unassignedCount }) => (
              <tr key={party.id} className="border-b border-line/60">
                <td className="py-1.5 pr-3 font-medium text-ink">{party.name}</td>
                <td className="py-1.5 pr-3 text-ink-soft">{memberList(party.members)}</td>
                <td className="py-1.5 pr-3 font-mono-num text-ink-soft">{party.size}</td>
                <td className="py-1.5 pr-3">
                  {party.pref === "any" ? (
                    <span className="text-ink-faint">no preference</span>
                  ) : (
                    <Badge tone="accent">{party.pref}</Badge>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-ink-soft">
                  {seated.length > 0 ? seated.join(", ") : ""}
                  {unassignedCount > 0 && (
                    <span className="text-state-warn"> {seated.length > 0 ? "+ " : ""}{unassignedCount} unassigned</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
