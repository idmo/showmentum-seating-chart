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
import {
  addTableAndSeat,
  mergePlacements,
  movePlacement,
  renameEvent,
  runAutoAssignAction,
  seatInGroup,
  setCheckedIn,
  splitPlacement,
  uploadGuestList,
} from "@/server/event-actions";
import {
  addTables,
  linkTables,
  moveGroupToSectionEnd,
  moveTableToSectionEnd,
  removeTable,
  setGroupTableNumber,
  unlinkGroup,
  updateTable,
} from "@/server/venue-actions";
import { Badge, Button, Input, Label, Panel, Select, SectionHeading, StatTile, Textarea } from "@/components/ui";
import { PARTY_PREFS, TABLE_SHAPES, type PartyPref, type SectionKey, type TableShape } from "@/lib/types";

const SHAPE_LABELS: Record<TableShape, string> = { round: "Round", square: "Square", rectangular: "Rectangular" };

// Distinct MIME type for table-level drags (moving a table between
// sections), kept separate from the plain "text/plain" placementId used by
// party-fragment drags so nested drop targets can tell them apart.
const TABLE_DRAG_TYPE = "application/x-venue-table";
// Separate type for dragging a whole LINKED GROUP between sections, so
// per-table and per-group drop handling never get confused with each other.
const GROUP_DRAG_TYPE = "application/x-venue-table-group";

type Props = {
  eventId: string;
  shareSlug: string;
  eventName: string;
  expectedGuests: number | null;
  venueName: string;
  venueId: string;
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
  const [draggingTableId, setDraggingTableId] = useState<string | null>(null);
  const [prefFilter, setPrefFilter] = useState<PartyPref | null>(null);
  const [linkModeSection, setLinkModeSection] = useState<SectionKey | null>(null);
  const [selectedForLink, setSelectedForLink] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"chart" | "guests">("chart");

  const view = useMemo(
    () => deriveView(props.tables, props.parties, props.placements),
    [props.tables, props.parties, props.placements],
  );

  // Tables sharing a groupId render as one merged "linked table" card
  // instead of separately — see GroupedTableDropCard below.
  const groups = useMemo(() => {
    const map = new Map<string, TableStateView[]>();
    view.tableState.forEach((t) => {
      if (!t.groupId) return;
      const list = map.get(t.groupId) ?? [];
      list.push(t);
      map.set(t.groupId, list);
    });
    return map;
  }, [view]);

  const totalGuests = props.parties.reduce((s, p) => s + p.size, 0);
  const seatedSeats = props.placements.filter((p) => p.tableId).reduce((s, p) => s + p.count, 0);
  const unassignedSeats = totalGuests - seatedSeats;
  const totalSeatsAvailable = props.tables.reduce((s, t) => s + t.capacity, 0);

  function refresh() {
    router.refresh();
  }

  function togglePrefFilter(pref: PartyPref) {
    setPrefFilter((current) => (current === pref ? null : pref));
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

  function handleToggleCheckedIn(partyId: string, checkedIn: boolean) {
    startTransition(async () => {
      await setCheckedIn(props.eventId, partyId, checkedIn);
      refresh();
    });
  }

  function handleDrop(targetTableId: string | null, placementId: string) {
    startTransition(async () => {
      await movePlacement(props.eventId, placementId, targetTableId);
      refresh();
    });
  }

  // Regroup a split party by dragging one fragment on top of another.
  // Looked up once per render so the drop handler on each fragment card can
  // decide synchronously (during the native drop event) whether the two
  // pieces belong to the same party, without an extra render round-trip.
  const partyIdByPlacement = useMemo(() => {
    const map = new Map<string, string>();
    view.tableState.forEach((t) => t.fragments.forEach((f) => map.set(f.placementId, f.party.id)));
    view.unassigned.forEach((f) => map.set(f.placementId, f.party.id));
    return map;
  }, [view]);

  // Returns true when it handled the drop (same party — merge them), so the
  // fragment's onDrop can stop the event there; false means "not a merge",
  // so the event should keep bubbling to the table/unassigned-tray drop
  // handler and behave like an ordinary move.
  function handleFragmentDrop(sourceId: string, targetId: string): boolean {
    if (sourceId === targetId) return false;
    const sourceParty = partyIdByPlacement.get(sourceId);
    const targetParty = partyIdByPlacement.get(targetId);
    if (!sourceParty || !targetParty || sourceParty !== targetParty) return false;
    startTransition(async () => {
      await mergePlacements(props.eventId, sourceId, targetId);
      refresh();
    });
    return true;
  }

  // Click-to-move alternative to dragging (a long seating chart page makes
  // drag-and-drop awkward). Tries, in order: (1) a single standalone table
  // in the target section with enough free capacity, (2) a linked group
  // there whose COMBINED free capacity fits (splitting across members as
  // needed), (3) offering to add a new table and seat them there.
  function handleMoveToSection(placementId: string, count: number, targetSection: SectionKey) {
    const tablesInSection = [...view.tableState.values()].filter((t) => t.sectionKey === targetSection);

    const singleCandidate = tablesInSection
      .filter((t) => !t.groupId)
      .sort((a, b) => a.order - b.order)
      .find((t) => t.capacity - t.usedSeats >= count);
    if (singleCandidate) {
      startTransition(async () => {
        await movePlacement(props.eventId, placementId, singleCandidate.id);
        refresh();
      });
      return;
    }

    const groupsInSection = new Map<string, TableStateView[]>();
    tablesInSection
      .filter((t) => t.groupId)
      .forEach((t) => {
        const list = groupsInSection.get(t.groupId!) ?? [];
        list.push(t);
        groupsInSection.set(t.groupId!, list);
      });
    for (const [groupId, members] of groupsInSection) {
      const totalFree = members.reduce((sum, t) => sum + Math.max(0, t.capacity - t.usedSeats), 0);
      if (totalFree >= count) {
        startTransition(async () => {
          await seatInGroup(props.eventId, groupId, placementId);
          refresh();
        });
        return;
      }
    }

    const defaultCapacity = Math.max(count, 8);
    const ok = window.confirm(
      `No open table in ${SECTION_LABELS[targetSection]} has room for ${count} seat${count === 1 ? "" : "s"}. Add a new round table there (${defaultCapacity} seats) and seat them there?`,
    );
    if (!ok) return;
    startTransition(async () => {
      await addTableAndSeat(props.eventId, props.venueId, targetSection, "round", defaultCapacity, placementId);
      refresh();
    });
  }

  function handleMoveToUnassigned(placementId: string) {
    startTransition(async () => {
      await movePlacement(props.eventId, placementId, null);
      refresh();
    });
  }

  function handleTableDrop(tableId: string, targetSection: SectionKey) {
    const table = view.tableState.get(tableId);
    if (!table || table.sectionKey === targetSection) return;
    const preferredFragments = table.fragments.filter((f) => f.party.pref !== "any");
    if (preferredFragments.length > 0) {
      const names = preferredFragments.map((f) => f.party.name).join(", ");
      const ok = window.confirm(
        `${names} ${preferredFragments.length > 1 ? "are" : "is"} seated at this table with a ${SECTION_LABELS[table.sectionKey]} placement preference. Move the table to ${SECTION_LABELS[targetSection]} anyway?`,
      );
      if (!ok) return;
    }
    startTransition(async () => {
      await moveTableToSectionEnd(tableId, targetSection, props.venueId);
      refresh();
    });
  }

  function handleRemoveTable(tableId: string) {
    const table = view.tableState.get(tableId);
    if (!table || table.fragments.length > 0) return;
    const ok = window.confirm(
      "Remove this empty table? It's removed from the venue entirely, so it disappears from every event that uses this venue — if another event has guests seated here, they'll be moved to that event's unassigned tray.",
    );
    if (!ok) return;
    startTransition(async () => {
      await removeTable(tableId, props.venueId);
      refresh();
    });
  }

  // Occasional capacity squeeze — e.g. a 10-top that needs to seat an
  // 11th guest. Bumps the physical table's capacity by 1 via the same
  // updateTable action the venue editor uses.
  function handleAddSeat(tableId: string, currentCapacity: number) {
    startTransition(async () => {
      await updateTable(tableId, props.venueId, { capacity: currentCapacity + 1 });
      refresh();
    });
  }

  // Undo of the above, or just shrinking a table back down. The button is
  // disabled (see TableDropCard) once capacity would drop to 0 or below the
  // seats already in use, so this doesn't need to re-check that itself.
  function handleRemoveSeat(tableId: string, currentCapacity: number) {
    startTransition(async () => {
      await updateTable(tableId, props.venueId, { capacity: currentCapacity - 1 });
      refresh();
    });
  }

  // User-assignable table numbers (e.g. matching a printed floor plan) —
  // a standalone table sets its own; a linked group writes the same number
  // onto every member so it reads as one consistently-numbered unit.
  function handleSetTableNumber(tableId: string, tableNumber: number | null) {
    startTransition(async () => {
      await updateTable(tableId, props.venueId, { tableNumber });
      refresh();
    });
  }
  function handleSetGroupTableNumber(groupId: string, tableNumber: number | null) {
    startTransition(async () => {
      await setGroupTableNumber(groupId, props.venueId, tableNumber);
      refresh();
    });
  }

  // Drag-the-whole-group-between-sections counterpart to handleTableDrop.
  function handleGroupDrop(groupId: string, targetSection: SectionKey) {
    const members = groups.get(groupId) ?? [];
    if (members.length === 0 || members[0].sectionKey === targetSection) return;
    const preferredFragments = members.flatMap((m) => m.fragments).filter((f) => f.party.pref !== "any");
    if (preferredFragments.length > 0) {
      const names = preferredFragments.map((f) => f.party.name).join(", ");
      const ok = window.confirm(
        `${names} ${preferredFragments.length > 1 ? "are" : "is"} seated at this linked table with a ${SECTION_LABELS[members[0].sectionKey]} placement preference. Move the linked table to ${SECTION_LABELS[targetSection]} anyway?`,
      );
      if (!ok) return;
    }
    startTransition(async () => {
      await moveGroupToSectionEnd(props.venueId, groupId, targetSection);
      refresh();
    });
  }

  // Drag-a-party-onto-the-merged-card handler — splits across member tables
  // automatically when the party is bigger than any single member.
  function handleSeatInGroup(groupId: string, placementId: string) {
    startTransition(async () => {
      await seatInGroup(props.eventId, groupId, placementId);
      refresh();
    });
  }

  function handleUnlinkGroup(groupId: string) {
    const ok = window.confirm("Unlink these tables? Each one goes back to being seated individually.");
    if (!ok) return;
    startTransition(async () => {
      await unlinkGroup(props.venueId, groupId);
      refresh();
    });
  }

  function toggleLinkSelect(tableId: string) {
    setSelectedForLink((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  function confirmLink() {
    const ids = Array.from(selectedForLink);
    if (ids.length < 2) return;
    startTransition(async () => {
      await linkTables(props.venueId, ids);
      setSelectedForLink(new Set());
      setLinkModeSection(null);
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

      <div className="flex gap-1 border-b border-line no-print">
        <button
          onClick={() => setActiveTab("chart")}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === "chart"
              ? "border-accent text-ink"
              : "border-transparent text-ink-soft hover:text-ink"
          }`}
        >
          Seating chart
        </button>
        <button
          onClick={() => setActiveTab("guests")}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
            activeTab === "guests"
              ? "border-accent text-ink"
              : "border-transparent text-ink-soft hover:text-ink"
          }`}
        >
          Guest list
        </button>
      </div>

      {activeTab === "chart" && (
      <>
      <Panel className="no-print">
        <SectionHeading
          title="Preference check"
          subtitle="Click a placement to dim everyone else — a quick way to see who asked for it and where they ended up."
        />
        <div className="flex flex-wrap items-center gap-2">
          {PARTY_PREFS.map((pref) => (
            <Button
              key={pref}
              size="sm"
              variant={prefFilter === pref ? "primary" : "ghost"}
              onClick={() => togglePrefFilter(pref)}
            >
              {pref === "any" ? "No preference" : SECTION_LABELS[pref]}
            </Button>
          ))}
          {prefFilter && (
            <button
              onClick={() => setPrefFilter(null)}
              className="text-[11px] font-medium text-ink-faint hover:text-accent hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </Panel>

      <Panel className="no-print">
        <SectionHeading
          title="Ticket Orders"
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
                prefFilter={prefFilter}
                onMoveToSection={(section) => handleMoveToSection(frag.placementId, frag.count, section)}
                onFragmentDrop={handleFragmentDrop}
              />
            ))}
        </div>
      </Panel>

      {SECTION_ORDER.map((section) => {
        const sectionTables = [...view.tableState.values()]
          .filter((t) => t.sectionKey === section)
          .sort((a, b) => a.order - b.order);
        const standaloneCount = sectionTables.filter((t) => !t.groupId).length;
        const inLinkMode = linkModeSection === section;
        const renderedGroups = new Set<string>();

        return (
          <Panel key={section}>
            <SectionHeading
              title={SECTION_LABELS[section]}
              action={
                !inLinkMode && standaloneCount >= 2 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLinkModeSection(section);
                      setSelectedForLink(new Set());
                    }}
                  >
                    Link tables
                  </Button>
                ) : undefined
              }
            />
            {inLinkMode && (
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-accent-soft-line bg-accent-soft p-2 text-xs no-print">
                <span className="text-ink-soft">Check 2 or more tables below to combine them into one virtual table.</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="primary" disabled={selectedForLink.size < 2 || isPending} onClick={confirmLink}>
                    Link {selectedForLink.size > 0 ? `${selectedForLink.size} ` : ""}tables
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLinkModeSection(null);
                      setSelectedForLink(new Set());
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <SectionDropZone section={section} onDropTable={handleTableDrop} onDropGroup={handleGroupDrop}>
              {sectionTables.map((table) => {
                if (table.groupId) {
                  if (renderedGroups.has(table.groupId)) return null;
                  renderedGroups.add(table.groupId);
                  const groupId = table.groupId;
                  const members = (groups.get(groupId) ?? []).slice().sort((a, b) => a.order - b.order);
                  return (
                    <GroupedTableDropCard
                      key={groupId}
                      groupId={groupId}
                      tableNumber={members[0]?.tableNumber ?? null}
                      members={members}
                      onSetTableNumber={(n) => handleSetGroupTableNumber(groupId, n)}
                      reassigned={view.reassigned}
                      onSplit={(frag) => setSplitTarget({ placementId: frag.placementId, partyName: frag.party.name, count: frag.count })}
                      onDragStartFragment={setDraggingId}
                      onDragEndFragment={() => setDraggingId(null)}
                      draggingId={draggingId}
                      prefFilter={prefFilter}
                      onSeat={(placementId) => handleSeatInGroup(groupId, placementId)}
                      onDragStartGroup={() => setDraggingTableId(`group:${groupId}`)}
                      onDragEndGroup={() => setDraggingTableId(null)}
                      groupDragging={draggingTableId === `group:${groupId}`}
                      onUnlink={() => handleUnlinkGroup(groupId)}
                      onMoveToSection={handleMoveToSection}
                      onMoveToUnassigned={handleMoveToUnassigned}
                      onFragmentDrop={handleFragmentDrop}
                    />
                  );
                }
                if (inLinkMode) {
                  return (
                    <SelectableTableChip
                      key={table.id}
                      table={table}
                      selected={selectedForLink.has(table.id)}
                      onToggle={() => toggleLinkSelect(table.id)}
                    />
                  );
                }
                return (
                  <TableDropCard
                    key={table.id}
                    table={table}
                    tableNumber={table.tableNumber}
                    onSetTableNumber={(n) => handleSetTableNumber(table.id, n)}
                    reassigned={view.reassigned}
                    onDrop={(placementId) => handleDrop(table.id, placementId)}
                    onDragStartFragment={setDraggingId}
                    onDragEndFragment={() => setDraggingId(null)}
                    draggingId={draggingId}
                    onSplit={(frag) => setSplitTarget({ placementId: frag.placementId, partyName: frag.party.name, count: frag.count })}
                    onDragStartTable={() => setDraggingTableId(table.id)}
                    onDragEndTable={() => setDraggingTableId(null)}
                    tableDragging={draggingTableId === table.id}
                    prefFilter={prefFilter}
                    onRemove={() => handleRemoveTable(table.id)}
                    onMoveToSection={handleMoveToSection}
                    onMoveToUnassigned={handleMoveToUnassigned}
                    onAddSeat={() => handleAddSeat(table.id, table.capacity)}
                    onRemoveSeat={() => handleRemoveSeat(table.id, table.capacity)}
                    onFragmentDrop={handleFragmentDrop}
                  />
                );
              })}
              {sectionTables.length === 0 && <p className="text-xs text-ink-faint">No tables in this section yet.</p>}
            </SectionDropZone>
            <AddTableForm venueId={props.venueId} section={section} onAdded={refresh} />
          </Panel>
        );
      })}
      </>
      )}

      {activeTab === "guests" && (
        <GuestListTable parties={props.parties} view={view} onToggleCheckedIn={handleToggleCheckedIn} />
      )}

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
  prefFilter,
  onMoveToSection,
  onFragmentDrop,
}: {
  frag: UnassignedFragmentView;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onSplit: () => void;
  prefFilter: PartyPref | null;
  onMoveToSection: (section: SectionKey) => void;
  onFragmentDrop: (sourcePlacementId: string, targetPlacementId: string) => boolean;
}) {
  const dimmed = prefFilter !== null && frag.party.pref !== prefFilter;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", frag.placementId);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/plain")) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("text/plain")) return;
        const sourceId = e.dataTransfer.getData("text/plain");
        if (sourceId && onFragmentDrop(sourceId, frag.placementId)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      title="Drop another piece of the same party here to regroup them"
      className={`w-56 cursor-grab rounded-md border px-2.5 py-2 text-xs shadow-sm transition-opacity active:cursor-grabbing ${
        dragging ? "opacity-40" : dimmed ? "opacity-25" : ""
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
      <div className="mt-1 flex items-center justify-between gap-2 no-print">
        <button onClick={onSplit} className="text-[11px] font-medium text-accent hover:underline">
          Split…
        </button>
        <MoveToSelect currentSection={null} onMoveToSection={onMoveToSection} />
      </div>
    </div>
  );
}

function MoveToSelect({
  currentSection,
  onMoveToSection,
  onMoveToUnassigned,
}: {
  currentSection: SectionKey | null;
  onMoveToSection: (section: SectionKey) => void;
  onMoveToUnassigned?: () => void;
}) {
  return (
    <select
      value=""
      title="Move to a section"
      onChange={(e) => {
        const value = e.target.value;
        if (!value) return;
        e.target.value = "";
        if (value === "unassigned") {
          onMoveToUnassigned?.();
        } else {
          onMoveToSection(value as SectionKey);
        }
      }}
      className="rounded border border-line bg-paper px-1 py-0.5 text-[11px] text-ink-soft"
    >
      <option value="">Move to…</option>
      {currentSection !== null && onMoveToUnassigned && <option value="unassigned">Unassigned</option>}
      {SECTION_ORDER.filter((s) => s !== currentSection).map((s) => (
        <option key={s} value={s}>
          {SECTION_LABELS[s]}
        </option>
      ))}
    </select>
  );
}

function SectionDropZone({
  section,
  onDropTable,
  onDropGroup,
  children,
}: {
  section: SectionKey;
  onDropTable: (tableId: string, section: SectionKey) => void;
  onDropGroup: (groupId: string, section: SectionKey) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TABLE_DRAG_TYPE) && !e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) {
          e.preventDefault();
          setOver(false);
          const groupId = e.dataTransfer.getData(GROUP_DRAG_TYPE);
          if (groupId) onDropGroup(groupId, section);
          return;
        }
        if (!e.dataTransfer.types.includes(TABLE_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(false);
        const tableId = e.dataTransfer.getData(TABLE_DRAG_TYPE);
        if (tableId) onDropTable(tableId, section);
      }}
      className={`grid grid-cols-1 gap-3 rounded-md p-1 transition-colors sm:grid-cols-2 lg:grid-cols-3 ${
        over ? "bg-accent-soft ring-2 ring-accent" : ""
      }`}
    >
      {children}
    </div>
  );
}

// A small always-editable field for a user-assigned table number (see
// setTableNumber/setGroupTableNumber). Keeps its own draft text so typing
// doesn't fight the server round-trip, and only commits — via onSave — on
// blur or Enter, reverting on Escape or on an invalid value.
function TableNumberField({
  value,
  onSave,
}: {
  value: number | null;
  onSave: (tableNumber: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onSave(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    if (n !== value) onSave(n);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      draggable={false}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value === null ? "" : String(value));
      }}
      placeholder="#"
      title="Table number — set your own, blank to clear"
      aria-label="Table number"
      className="no-print w-9 rounded border border-line-strong/60 bg-paper px-1 py-0.5 text-center font-mono-num text-[11px] text-ink-soft focus:border-accent focus:outline-none"
    />
  );
}

function TableDropCard({
  table,
  tableNumber,
  reassigned,
  onDrop,
  onDragStartFragment,
  onDragEndFragment,
  draggingId,
  onSplit,
  onDragStartTable,
  onDragEndTable,
  tableDragging,
  prefFilter,
  onRemove,
  onMoveToSection,
  onMoveToUnassigned,
  onAddSeat,
  onRemoveSeat,
  onFragmentDrop,
  onSetTableNumber,
}: {
  table: TableStateView;
  tableNumber: number | null;
  reassigned: (f: TableFragmentView) => boolean;
  onDrop: (placementId: string) => void;
  onDragStartFragment: (id: string) => void;
  onDragEndFragment: () => void;
  draggingId: string | null;
  onSplit: (f: TableFragmentView) => void;
  onDragStartTable: () => void;
  onDragEndTable: () => void;
  tableDragging: boolean;
  prefFilter: PartyPref | null;
  onRemove: () => void;
  onMoveToSection: (placementId: string, count: number, section: SectionKey) => void;
  onMoveToUnassigned: (placementId: string) => void;
  onAddSeat: () => void;
  onRemoveSeat: () => void;
  onFragmentDrop: (sourcePlacementId: string, targetPlacementId: string) => boolean;
  onSetTableNumber: (tableNumber: number | null) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TABLE_DRAG_TYPE) || e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(TABLE_DRAG_TYPE) || e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/plain");
        if (id) onDrop(id);
      }}
      className={`rounded-lg border p-2.5 transition-colors ${tableDragging ? "opacity-40" : ""} ${
        over ? "border-accent bg-accent-soft" : table.overCapacity ? "border-state-danger/40 bg-state-danger-soft" : "border-line bg-paper"
      }`}
    >
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TABLE_DRAG_TYPE, table.id);
          e.dataTransfer.effectAllowed = "move";
          onDragStartTable();
        }}
        onDragEnd={onDragEndTable}
        title="Drag to move this table to another section"
        className="mb-1.5 flex cursor-grab items-center justify-between text-xs active:cursor-grabbing"
      >
        <span className="flex items-center gap-1 font-medium text-ink">
          <TableNumberField key={tableNumber ?? "none"} value={tableNumber} onSave={onSetTableNumber} />
          {table.shape} · {table.capacity} seats
        </span>
        <div className="flex items-center gap-1">
          {table.isPrivate && <Badge tone="accent">private</Badge>}
          {table.overCapacity && <Badge tone="danger">over capacity</Badge>}
          <span className="font-mono-num text-ink-soft">
            {table.usedSeats}/{table.capacity}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemoveSeat();
            }}
            disabled={table.capacity <= 1 || table.capacity <= table.usedSeats}
            title={
              table.capacity <= table.usedSeats
                ? "Can't remove a seat that's currently occupied — move or unseat a guest first"
                : "Remove a seat from this table"
            }
            className="no-print rounded border border-line-strong/60 px-1 text-[11px] font-medium text-ink-soft hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-strong/60 disabled:hover:text-ink-soft"
          >
            −1 seat
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAddSeat();
            }}
            title="Squeeze in one more seat at this table"
            className="no-print rounded border border-line-strong/60 px-1 text-[11px] font-medium text-ink-soft hover:border-accent hover:text-accent"
          >
            +1 seat
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        {table.fragments.length === 0 && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-ink-faint">Empty</p>
            <button
              onClick={onRemove}
              className="text-[11px] font-medium text-state-danger hover:underline no-print"
            >
              Remove table
            </button>
          </div>
        )}
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
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("text/plain")) return;
                e.preventDefault();
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes("text/plain")) return;
                const sourceId = e.dataTransfer.getData("text/plain");
                if (sourceId && onFragmentDrop(sourceId, frag.placementId)) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
              title="Drop another piece of the same party here to regroup them"
              className={`cursor-grab rounded border border-line-strong/60 bg-paper-raised px-2 py-1 text-xs transition-opacity active:cursor-grabbing ${
                draggingId === frag.placementId
                  ? "opacity-40"
                  : prefFilter !== null && frag.party.pref !== prefFilter
                    ? "opacity-25"
                    : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">
                  {frag.party.name}
                  {frag.isPartial && <span className="text-ink-faint"> (part)</span>}
                </span>
                <div className="flex items-center gap-1">
                  {frag.party.pref !== "any" && <Badge tone="accent">{frag.party.pref}</Badge>}
                  {reassigned(frag) && <Badge tone="warn">moved from {frag.party.pref}</Badge>}
                  <span className="font-mono-num text-ink-soft">{frag.count}</span>
                </div>
              </div>
              {frag.members.length > 0 && <p className="mt-0.5 text-ink-soft">{memberList(frag.members)}</p>}
              <div className="mt-0.5 flex items-center justify-between gap-2 no-print">
                <button
                  onClick={() => onSplit(frag)}
                  className="text-[11px] font-medium text-accent hover:underline"
                >
                  Split…
                </button>
                <MoveToSelect
                  currentSection={table.sectionKey}
                  onMoveToUnassigned={() => onMoveToUnassigned(frag.placementId)}
                  onMoveToSection={(section) => onMoveToSection(frag.placementId, frag.count, section)}
                />
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function SelectableTableChip({
  table,
  selected,
  onToggle,
}: {
  table: TableStateView;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-xs ${
        selected ? "border-accent bg-accent-soft" : "border-line bg-paper"
      }`}
    >
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="font-medium text-ink">
        {table.shape} · {table.capacity} seats
      </span>
      <span className="ml-auto font-mono-num text-ink-soft">
        {table.usedSeats}/{table.capacity}
      </span>
    </label>
  );
}

// One merged card for a linked group of tables (a "virtual table" — see
// linkTables/seatInGroup). Capacity and the seated-party list are pooled
// across every member; dropping a party here or picking a section from
// MoveToSelect can split them across members automatically.
function GroupedTableDropCard({
  groupId,
  tableNumber,
  members,
  reassigned,
  onSplit,
  onDragStartFragment,
  onDragEndFragment,
  draggingId,
  prefFilter,
  onSeat,
  onDragStartGroup,
  onDragEndGroup,
  groupDragging,
  onUnlink,
  onMoveToSection,
  onMoveToUnassigned,
  onFragmentDrop,
  onSetTableNumber,
}: {
  groupId: string;
  tableNumber: number | null;
  members: TableStateView[];
  reassigned: (f: TableFragmentView) => boolean;
  onSplit: (f: TableFragmentView) => void;
  onDragStartFragment: (id: string) => void;
  onDragEndFragment: () => void;
  draggingId: string | null;
  prefFilter: PartyPref | null;
  onSeat: (placementId: string) => void;
  onDragStartGroup: () => void;
  onDragEndGroup: () => void;
  groupDragging: boolean;
  onUnlink: () => void;
  onMoveToSection: (placementId: string, count: number, section: SectionKey) => void;
  onMoveToUnassigned: (placementId: string) => void;
  onFragmentDrop: (sourcePlacementId: string, targetPlacementId: string) => boolean;
  onSetTableNumber: (tableNumber: number | null) => void;
}) {
  const [over, setOver] = useState(false);
  const capacity = members.reduce((sum, m) => sum + m.capacity, 0);
  const usedSeats = members.reduce((sum, m) => sum + m.usedSeats, 0);
  const overCapacity = usedSeats > capacity;
  const section = members[0]?.sectionKey;
  const fragments = members
    .flatMap((m) => m.fragments)
    .slice()
    .sort((a, b) => a.order - b.order);

  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TABLE_DRAG_TYPE) || e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(TABLE_DRAG_TYPE) || e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData("text/plain");
        if (id) onSeat(id);
      }}
      className={`rounded-lg border p-2.5 transition-colors sm:col-span-2 ${groupDragging ? "opacity-40" : ""} ${
        over
          ? "border-accent bg-accent-soft"
          : overCapacity
            ? "border-state-danger/40 bg-state-danger-soft"
            : "border-accent-soft-line bg-accent-soft/40"
      }`}
    >
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(GROUP_DRAG_TYPE, groupId);
          e.dataTransfer.effectAllowed = "move";
          onDragStartGroup();
        }}
        onDragEnd={onDragEndGroup}
        title="Drag to move this whole linked table to another section"
        className="mb-1.5 flex cursor-grab items-center justify-between text-xs active:cursor-grabbing"
      >
        <span className="flex items-center gap-1 font-medium text-ink">
          <TableNumberField key={tableNumber ?? "none"} value={tableNumber} onSave={onSetTableNumber} />
          Linked · {members.length} tables ({members.map((m) => m.shape).join(" + ")})
        </span>
        <div className="flex items-center gap-1">
          {overCapacity && <Badge tone="danger">over capacity</Badge>}
          <span className="font-mono-num text-ink-soft">
            {usedSeats}/{capacity}
          </span>
          <button
            onClick={onUnlink}
            className="text-[11px] font-medium text-ink-faint hover:text-accent hover:underline no-print"
          >
            Unlink
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        {fragments.length === 0 && <p className="text-[11px] text-ink-faint">Empty</p>}
        {fragments.map((frag) => (
          <div
            key={frag.placementId}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", frag.placementId);
              onDragStartFragment(frag.placementId);
            }}
            onDragEnd={onDragEndFragment}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("text/plain")) return;
              e.preventDefault();
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes("text/plain")) return;
              const sourceId = e.dataTransfer.getData("text/plain");
              if (sourceId && onFragmentDrop(sourceId, frag.placementId)) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            title="Drop another piece of the same party here to regroup them"
            className={`cursor-grab rounded border border-line-strong/60 bg-paper-raised px-2 py-1 text-xs transition-opacity active:cursor-grabbing ${
              draggingId === frag.placementId
                ? "opacity-40"
                : prefFilter !== null && frag.party.pref !== prefFilter
                  ? "opacity-25"
                  : ""
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">
                {frag.party.name}
                {frag.isPartial && <span className="text-ink-faint"> (part)</span>}
              </span>
              <div className="flex items-center gap-1">
                {frag.party.pref !== "any" && <Badge tone="accent">{frag.party.pref}</Badge>}
                {reassigned(frag) && <Badge tone="warn">moved from {frag.party.pref}</Badge>}
                <span className="font-mono-num text-ink-soft">{frag.count}</span>
              </div>
            </div>
            {frag.members.length > 0 && <p className="mt-0.5 text-ink-soft">{memberList(frag.members)}</p>}
            <div className="mt-0.5 flex items-center justify-between gap-2 no-print">
              <button
                onClick={() => onSplit(frag)}
                className="text-[11px] font-medium text-accent hover:underline"
              >
                Split…
              </button>
              <MoveToSelect
                currentSection={section ?? null}
                onMoveToUnassigned={() => onMoveToUnassigned(frag.placementId)}
                onMoveToSection={(s) => onMoveToSection(frag.placementId, frag.count, s)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddTableForm({
  venueId,
  section,
  onAdded,
}: {
  venueId: string;
  section: SectionKey;
  onAdded: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 text-[11px] font-medium text-accent hover:underline no-print"
      >
        + Add empty table
      </button>
    );
  }

  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-dashed border-line p-2 no-print"
      onSubmit={(e) => {
        e.preventDefault();
        // Capture the form element synchronously — e.currentTarget is nulled
        // out by React once the handler returns, so it can't be read from
        // inside the async startTransition callback below.
        const formEl = e.currentTarget;
        const form = new FormData(formEl);
        const shape = String(form.get("shape")) as TableShape;
        const capacity = Number(form.get("capacity"));
        const count = Number(form.get("count"));
        startTransition(async () => {
          await addTables(venueId, section, shape, capacity, count);
          formEl.reset();
          setOpen(false);
          onAdded();
        });
      }}
    >
      <div className="w-28">
        <Label>Shape</Label>
        <Select name="shape" defaultValue="round">
          {TABLE_SHAPES.map((s) => (
            <option key={s} value={s}>
              {SHAPE_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>
      <div className="w-20">
        <Label>Seats</Label>
        <Input name="capacity" type="number" min={1} defaultValue={8} required />
      </div>
      <div className="w-16">
        <Label>Count</Label>
        <Input name="count" type="number" min={1} defaultValue={1} required />
      </div>
      <Button type="submit" size="sm" disabled={isPending}>
        Add
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </form>
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

type GuestListSortKey = "name" | "guests" | "size" | "pref" | "seated" | "checkedIn";
type GuestListStatusFilter = "all" | "unassigned" | "seated" | "checked-in" | "not-checked-in";

function GuestListTable({
  parties,
  view,
  onToggleCheckedIn,
}: {
  parties: PartyInput[];
  view: ReturnType<typeof deriveView>;
  onToggleCheckedIn: (partyId: string, checkedIn: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<GuestListStatusFilter>("all");
  const [sortKey, setSortKey] = useState<GuestListSortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  function toggleSort(key: GuestListSortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortArrow(key: GuestListSortKey) {
    if (sortKey !== key) return null;
    return <span className="text-[10px] text-ink-faint">{sortDir === "asc" ? "▲" : "▼"}</span>;
  }

  const tableLabel = (tableId: string) => {
    const t = view.tableState.get(tableId);
    if (!t) return "—";
    const prefix = t.tableNumber !== null ? `Table ${t.tableNumber} — ` : "";
    return `${prefix}${SECTION_LABELS[t.sectionKey]} · ${t.shape} (${t.capacity})`;
  };

  const allRows = parties.map((party) => {
    const seated: string[] = [];
    const unassignedCount = view.unassigned.filter((u) => u.party.id === party.id).reduce((s, u) => s + u.count, 0);
    view.tableState.forEach((t) => {
      t.fragments
        .filter((f) => f.party.id === party.id)
        .forEach((f) => seated.push(`${tableLabel(t.id)} ×${f.count}`));
    });
    const seatedCount = party.size - unassignedCount;
    const guestsLabel = memberList(party.members);
    return { party, seated, unassignedCount, seatedCount, guestsLabel, checkedIn: Boolean(party.checkedInAt) };
  });

  const q = search.trim().toLowerCase();
  const filteredRows = allRows.filter(({ party, unassignedCount, checkedIn }) => {
    if (q) {
      const matchesName = party.name.toLowerCase().includes(q);
      const matchesMember = party.members.some((m) => m.name.toLowerCase().includes(q));
      if (!matchesName && !matchesMember) return false;
    }
    if (statusFilter === "unassigned" && unassignedCount === 0) return false;
    if (statusFilter === "seated" && unassignedCount > 0) return false;
    if (statusFilter === "checked-in" && !checkedIn) return false;
    if (statusFilter === "not-checked-in" && checkedIn) return false;
    return true;
  });

  const rows = filteredRows.slice().sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.party.name.localeCompare(b.party.name);
        break;
      case "guests":
        cmp = a.guestsLabel.localeCompare(b.guestsLabel);
        break;
      case "size":
        cmp = a.party.size - b.party.size;
        break;
      case "pref":
        cmp = a.party.pref.localeCompare(b.party.pref);
        break;
      case "seated":
        cmp = a.seatedCount - b.seatedCount;
        break;
      case "checkedIn":
        cmp = Number(a.checkedIn) - Number(b.checkedIn);
        break;
    }
    if (cmp === 0) cmp = a.party.name.localeCompare(b.party.name);
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <Panel>
      <SectionHeading title="Guest list" subtitle="Every party, where they're seated, and who's sitting with whom." />
      <div className="mb-3 flex flex-wrap items-center gap-2 no-print">
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a guest by name…"
          className="w-56"
        />
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as GuestListStatusFilter)}
          className="w-auto"
        >
          <option value="all">All parties</option>
          <option value="unassigned">Has unassigned seats</option>
          <option value="seated">Fully seated</option>
          <option value="checked-in">Checked in</option>
          <option value="not-checked-in">Not checked in</option>
        </Select>
        <span className="text-xs text-ink-faint">
          {rows.length} of {parties.length} parties
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
              <th className="py-1.5 pr-3">
                <button onClick={() => toggleSort("name")} className="inline-flex items-center gap-1 hover:text-accent">
                  Party {sortArrow("name")}
                </button>
              </th>
              <th className="py-1.5 pr-3">
                <button onClick={() => toggleSort("guests")} className="inline-flex items-center gap-1 hover:text-accent">
                  Guests {sortArrow("guests")}
                </button>
              </th>
              <th className="py-1.5 pr-3">
                <button onClick={() => toggleSort("size")} className="inline-flex items-center gap-1 hover:text-accent">
                  Size {sortArrow("size")}
                </button>
              </th>
              <th className="py-1.5 pr-3">
                <button onClick={() => toggleSort("pref")} className="inline-flex items-center gap-1 hover:text-accent">
                  Placement {sortArrow("pref")}
                </button>
              </th>
              <th className="py-1.5 pr-3">
                <button onClick={() => toggleSort("seated")} className="inline-flex items-center gap-1 hover:text-accent">
                  Seated at {sortArrow("seated")}
                </button>
              </th>
              <th className="py-1.5 pr-3 no-print">
                <button onClick={() => toggleSort("checkedIn")} className="inline-flex items-center gap-1 hover:text-accent">
                  Check-in {sortArrow("checkedIn")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-3 text-center text-xs text-ink-faint">
                  No parties match {q ? `"${search.trim()}"` : "this filter"}.
                </td>
              </tr>
            )}
            {rows.map(({ party, seated, unassignedCount, guestsLabel, checkedIn }) => (
              <tr key={party.id} className="border-b border-line/60">
                <td className="py-1.5 pr-3 font-medium text-ink">{party.name}</td>
                <td className="py-1.5 pr-3 text-ink-soft">{guestsLabel}</td>
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
                <td className="py-1.5 pr-3 no-print">
                  <button
                    onClick={() => onToggleCheckedIn(party.id, !checkedIn)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      checkedIn
                        ? "border-state-ok/30 bg-state-ok-soft text-state-ok hover:border-state-ok/60"
                        : "border-line-strong/60 text-ink-soft hover:border-accent hover:text-accent"
                    }`}
                  >
                    {checkedIn ? "✓ Checked in" : "Check in"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
