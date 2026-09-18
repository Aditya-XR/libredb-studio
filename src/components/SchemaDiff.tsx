"use client";

import { appFetch } from "@/lib/config/base-path";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  GitCompare,
  Plus,
  Minus,
  PenLine,
  Camera,
  FileCode,
  ChevronRight,
  ChevronDown,
  Clock,
  Database,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SchemaSnapshot, DatabaseType, DatabaseConnection } from "@/lib/types";
import { detailedObjects, type DetailedObject } from "@/lib/db/detailed-object";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { ProviderCapabilities } from "@/lib/db/types";
import { storage } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { useAllConnections } from "@/hooks/use-all-connections";
import { diffSchemas } from "@/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "@/lib/schema-diff/migration-generator";
import type { SchemaDiff as SchemaDiffType, TableDiff } from "@/lib/schema-diff/types";
import { SnapshotTimeline } from "@/components/SnapshotTimeline";

interface SchemaDiffProps {
  schema: readonly DetailedObject[];
  connection: DatabaseConnection | null;
}

/**
 * Read one connection's objects from the database.
 *
 * Two reads of the object surface, where this used to be one call to
 * `POST /api/db/schema-snapshot` (#789). That route read the flat schema, which no longer
 * exists, and the two things it hand-rolled around that read are things `getOrCreateProvider`
 * does for every object route already: it opens the SSH tunnel (#457), and it returns the
 * handle this connection already holds rather than opening a second one, which is what #498
 * needed on an engine that admits only one writer to its file.
 *
 * `provider-meta` decides which kinds are asked for, exactly as the object browser's own read
 * does, and for the same measured reason: a diff is over relations, and asking for every
 * declared kind would list routines and triggers this comparison cannot use.
 *
 * It sits outside the component because BOTH sides of a diff need it. The remote side always
 * called it; the "Current Schema" side read a prop instead, so a diff taken right after a DDL
 * change compared the database against a copy of itself from before the change and reported
 * no differences (#884).
 */
async function readLiveSchema(conn: DatabaseConnection): Promise<DetailedObject[]> {
  const payload = conn.managed && conn.seedId ? { connectionId: `seed:${conn.seedId}` } : { connection: conn };
  const post = (path: string, body: unknown) =>
    appFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const metaRes = await post("/api/db/provider-meta", payload);
  const meta = await metaRes.json();
  if (!metaRes.ok) throw new Error(meta.error);
  const kinds = relationKindIds(meta.capabilities as ProviderCapabilities);
  if (kinds.length === 0) throw new Error(`${conn.name} declares no object kinds a schema diff can compare`);

  const res = await post("/api/db/objects/inventory", { ...payload, kinds, includeColumns: true });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);

  return [...detailedObjects(data.objects ?? [], data.details ?? [])];
}

export function SchemaDiff({ schema, connection }: SchemaDiffProps) {
  const [snapshots, setSnapshots] = useState<SchemaSnapshot[]>(() => storage.getSchemaSnapshots());
  const [sourceId, setSourceId] = useState<string>("current");
  const [targetId, setTargetId] = useState<string>("");
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [showMigration, setShowMigration] = useState(false);
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [showLabelInput, setShowLabelInput] = useState(false);

  /**
   * The objects the database holds right now, read when this panel opens.
   *
   * `schema` is the prop the explorer already had, and it is what "Current Schema" used to
   * mean — so a diff taken right after a DDL change compared a copy of the schema from
   * before the change and answered "No differences found" (#884). The panel is mounted when
   * the user opens it, so reading here is the moment that matters for that sequence.
   *
   * `null` until the read lands, and the prop stands in meanwhile: an empty side would
   * report every object as removed, which is worse than being briefly out of date.
   */
  /**
   * The last read, and the connection it was a read OF.
   *
   * The connection is stored with the result rather than the result being cleared when the
   * connection changes, because the panel outlives a switch: `BottomPanel` keeps it mounted,
   * so holding the previous database's objects made "Current Schema" mean the OTHER
   * connection until the new read landed, and for good if that read failed. `takeSnapshot`
   * then wrote the new connection's id and type onto the old one's objects, which is the
   * stale-copy defect #884 is about, kept for as long as the snapshot is.
   *
   * Carrying the connection makes a stale read unusable rather than something a second
   * effect has to remember to clear, and it is keyed on the connection OBJECT — the same
   * thing the effect depends on — so a read can never outlive the exact render that asked
   * for it.
   *
   * `error` is the other half. The panel falls back to the explorer's copy, and that copy is
   * precisely what #884 is about, so the reason is state that reaches the screen rather than
   * a log line that reaches nobody standing in front of the panel.
   */
  const [liveRead, setLiveRead] = useState<{
    connection: DatabaseConnection;
    objects: readonly DetailedObject[] | null;
    error: string | null;
  } | null>(null);

  const readForThisConnection = liveRead?.connection === connection ? liveRead : null;

  /**
   * The objects the database holds right now, read when this panel opens.
   *
   * `schema` is the prop the explorer already had, and it is what "Current Schema" used to
   * mean — so a diff taken right after a DDL change compared a copy of the schema from
   * before the change and answered "No differences found" (#884). The panel is mounted when
   * the user opens it, so reading here is the moment that matters for that sequence.
   *
   * `null` until the read lands, and the prop stands in meanwhile: an empty side would
   * report every object as removed, which is worse than being briefly out of date.
   */
  const liveSchema = readForThisConnection?.objects ?? null;
  const liveSchemaError = readForThisConnection?.error ?? null;

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    readLiveSchema(connection)
      .then((objects) => {
        if (!cancelled) setLiveRead({ connection, objects, error: null });
      })
      .catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (!cancelled) setLiveRead({ connection, objects: null, error: reason });
        logger.warn("Failed to read the current schema for a diff; falling back to the explorer's copy", {
          route: "SchemaDiff",
          error: reason,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  /** What "Current Schema" means on both sides of the diff, and in a new snapshot. */
  const currentSchema = liveSchema ?? schema;

  // Take snapshot of current schema
  const takeSnapshot = useCallback(() => {
    if (!connection) return;
    const snapshot: SchemaSnapshot = {
      id: Date.now().toString(),
      connectionId: connection.id,
      connectionName: connection.name,
      databaseType: connection.type,
      // The live read, not the prop: a snapshot taken from a stale copy is stale for as
      // long as it is kept, and it is kept to be compared against later (#884).
      schema: JSON.parse(JSON.stringify(currentSchema)),
      createdAt: new Date(),
      label: snapshotLabel.trim() || undefined,
    };
    storage.saveSchemaSnapshot(snapshot);
    setSnapshots(storage.getSchemaSnapshots());
    setSnapshotLabel("");
    setShowLabelInput(false);
  }, [currentSchema, connection, snapshotLabel]);

  // Delete snapshot
  const deleteSnapshot = useCallback(
    (id: string) => {
      storage.deleteSchemaSnapshot(id);
      setSnapshots(storage.getSchemaSnapshots());
      if (sourceId === id) setSourceId("current");
      if (targetId === id) setTargetId("");
    },
    [sourceId, targetId],
  );

  // Compute diff
  const diff = useMemo<SchemaDiffType | null>(() => {
    if (!targetId) return null;

    const sourceSchema =
      sourceId === "current" ? currentSchema : snapshots.find((s) => s.id === sourceId)?.schema || [];

    const targetSchema =
      targetId === "current" ? currentSchema : snapshots.find((s) => s.id === targetId)?.schema || [];

    if (sourceId === targetId) return null;

    return diffSchemas(sourceSchema, targetSchema);
  }, [sourceId, targetId, currentSchema, snapshots]);

  // Generate migration SQL
  const migrationSQL = useMemo(() => {
    if (!diff || !diff.hasChanges) return "";
    const dialect = connection?.type || "postgres";
    return generateMigrationSQL(diff, dialect as DatabaseType);
  }, [diff, connection]);

  // Get all connections for cross-connection comparison
  const { connections: allConnections } = useAllConnections();
  const [fetchingRemote, setFetchingRemote] = useState(false);

  // Fetch schema from a remote connection
  const fetchRemoteSchema = useCallback(
    async (connId: string) => {
      const conn = allConnections.find((c) => c.id === connId);
      if (!conn) return;

      setFetchingRemote(true);
      try {
        const objects = await readLiveSchema(conn);

        // Auto-save as snapshot
        const snapshot: SchemaSnapshot = {
          id: `remote-${Date.now()}`,
          connectionId: conn.id,
          connectionName: conn.name,
          databaseType: conn.type,
          schema: objects,
          createdAt: new Date(),
          label: `Live: ${conn.name}`,
        };
        storage.saveSchemaSnapshot(snapshot);
        setSnapshots(storage.getSchemaSnapshots());
        setTargetId(snapshot.id);
      } catch (err) {
        logger.warn("Failed to fetch the remote schema for a diff", {
          route: "SchemaDiff",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setFetchingRemote(false);
      }
    },
    [allConnections],
  );

  const getActionBadge = (action: string) => {
    switch (action) {
      case "added":
        return (
          <Badge className="bg-hue-green-tint/20 text-hue-green border-hue-green-tint/30 text-xs">
            <Plus strokeWidth={1.5} className="w-2.5 h-2.5 mr-0.5" />
            {"Added"}
          </Badge>
        );
      case "removed":
        return (
          <Badge className="bg-hue-red-tint/20 text-hue-red border-hue-red-tint/30 text-xs">
            <Minus className="w-2.5 h-2.5 mr-0.5" />
            {"Removed"}
          </Badge>
        );
      case "modified":
        return (
          <Badge className="bg-hue-yellow-tint/20 text-hue-yellow border-hue-yellow-tint/30 text-xs">
            <PenLine strokeWidth={1.5} className="w-2.5 h-2.5 mr-0.5" />
            {"Modified"}
          </Badge>
        );
      default:
        return null;
    }
  };

  const formatSnapshotLabel = (s: SchemaSnapshot) => {
    const date = new Date(s.createdAt).toLocaleString();
    return `${s.label || s.connectionName} (${date})`;
  };

  return (
    <div className="h-full flex flex-col bg-sunken">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-hairline bg-surface flex-wrap">
        <GitCompare strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-rose" />
        <span className="text-xs font-medium text-fg-tertiary">Schema Diff</span>

        <div className="h-4 w-px bg-fill-strong" />

        {/* Source selector */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-fg-subtle">Source</span>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger className="h-7 w-[180px] text-xs bg-fill border-hairline-strong">
              <SelectValue placeholder="Select source" />
            </SelectTrigger>
            <SelectContent className="bg-overlay border-hairline-strong">
              <SelectItem value="current" className="text-xs">
                <div className="flex items-center gap-1">
                  <Database strokeWidth={1.5} className="w-3 h-3" /> Current Schema
                </div>
              </SelectItem>
              {snapshots.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <Clock strokeWidth={1.5} className="w-3 h-3" /> {formatSnapshotLabel(s)}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-fg-subtle text-xs">vs</span>

        {/* Target selector */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-fg-subtle">Target</span>
          <Select
            value={targetId}
            onValueChange={(v) => {
              if (v.startsWith("conn:")) {
                fetchRemoteSchema(v.replace("conn:", ""));
              } else {
                setTargetId(v);
              }
            }}
          >
            <SelectTrigger className="h-7 w-[180px] text-xs bg-fill border-hairline-strong">
              <SelectValue placeholder="Select target" />
            </SelectTrigger>
            <SelectContent className="bg-overlay border-hairline-strong">
              <SelectItem value="current" className="text-xs">
                <div className="flex items-center gap-1">
                  <Database strokeWidth={1.5} className="w-3 h-3" /> Current Schema
                </div>
              </SelectItem>
              {snapshots.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  <div className="flex items-center gap-1">
                    <Clock strokeWidth={1.5} className="w-3 h-3" /> {formatSnapshotLabel(s)}
                  </div>
                </SelectItem>
              ))}
              {allConnections.filter((c) => c.id !== connection?.id).length > 0 && (
                <>
                  <div className="px-2 py-1 text-[0.625rem] text-fg-subtle border-t border-hairline mt-1">
                    {"Fetch from connection"}
                  </div>
                  {allConnections
                    .filter((c) => c.id !== connection?.id)
                    .map((c) => (
                      <SelectItem key={`conn:${c.id}`} value={`conn:${c.id}`} className="text-xs">
                        <div className="flex items-center gap-1">
                          <Database strokeWidth={1.5} className="w-3 h-3 text-hue-blue" /> {c.name}
                          {c.environment === "production" && (
                            <TriangleAlert strokeWidth={1.5} className="w-3 h-3 text-danger" />
                          )}
                        </div>
                      </SelectItem>
                    ))}
                </>
              )}
            </SelectContent>
          </Select>
          {fetchingRemote && <span className="text-xs text-fg-muted animate-pulse">Fetching...</span>}
        </div>

        <div className="flex-1" />

        {/* Snapshot controls */}
        {showLabelInput ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              placeholder="Label (optional)..."
              value={snapshotLabel}
              onChange={(e) => setSnapshotLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && takeSnapshot()}
              className="h-7 px-2 text-xs bg-fill border border-hairline-strong rounded text-fg-secondary focus:outline-none focus:border-brand-tint w-32"
              autoFocus
            />
            <Button variant="ghost" size="sm" className="h-7 text-xs text-brand" onClick={takeSnapshot}>
              {"Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-fg-muted"
              onClick={() => setShowLabelInput(false)}
            >
              {"Cancel"}
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
            onClick={() => setShowLabelInput(true)}
            disabled={!connection}
          >
            <Camera className="w-3 h-3" /> Snapshot
          </Button>
        )}

        {diff?.hasChanges && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs font-medium text-fg-muted hover:text-fg-bright gap-1"
            onClick={() => setShowMigration(!showMigration)}
          >
            <FileCode className="w-3 h-3" /> {showMigration ? "Diff View" : "SQL Migration"}
          </Button>
        )}
      </div>

      {liveSchemaError && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline bg-warning-tint/10 text-warning">
          <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
          <span className="text-xs">
            {`Current Schema is the explorer's last copy, which may be out of date: ${liveSchemaError}`}
          </span>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {!targetId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-fg-subtle gap-3">
            <GitCompare strokeWidth={1.5} className="w-10 h-10 opacity-30" />
            <p className="text-xs">Select source and target to compare schemas</p>
            <p className="text-xs text-fg-faint">Take a snapshot first, then compare with the current schema</p>

            {/* Snapshot Timeline */}
            {snapshots.length > 0 && (
              <div className="mt-4 w-full max-w-2xl px-4">
                <SnapshotTimeline
                  snapshots={snapshots}
                  onCompare={(sourceId, targetId) => {
                    setSourceId(sourceId);
                    setTargetId(targetId);
                  }}
                  onDelete={deleteSnapshot}
                />
              </div>
            )}
          </div>
        ) : showMigration && migrationSQL ? (
          <div className="flex-1 overflow-auto p-4">
            <pre className="text-xs font-mono text-fg-secondary bg-raised border border-hairline-strong rounded-lg p-4 overflow-auto whitespace-pre-wrap">
              {migrationSQL}
            </pre>
          </div>
        ) : diff && diff.hasChanges ? (
          <>
            {/* Table List */}
            <div className="w-64 border-r border-hairline overflow-auto">
              <div className="p-2 border-b border-hairline">
                <div className="text-xs text-fg-muted px-2 mb-1">
                  {diff.summary.added} added, {diff.summary.removed} removed, {diff.summary.modified} modified
                </div>
              </div>
              {diff.tables.map((table) => (
                <button
                  key={table.tableName}
                  onClick={() => setSelectedTable(table.tableName)}
                  className={cn(
                    "w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-fill transition-colors",
                    selectedTable === table.tableName && "bg-fill-strong",
                  )}
                >
                  {selectedTable === table.tableName ? (
                    <ChevronDown strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                  ) : (
                    <ChevronRight strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                  )}
                  <span className="text-fg-secondary">{table.tableName}</span>
                  <span className="ml-auto">{getActionBadge(table.action)}</span>
                </button>
              ))}
            </div>

            {/* Table Detail */}
            <div className="flex-1 overflow-auto p-4">
              {selectedTable ? (
                <TableDiffDetail diff={diff.tables.find((t) => t.tableName === selectedTable)!} />
              ) : (
                <div className="h-full flex items-center justify-center text-fg-subtle text-xs">
                  {"Select a table to view diff details"}
                </div>
              )}
            </div>
          </>
        ) : diff && !diff.hasChanges ? (
          <div className="flex-1 flex items-center justify-center text-fg-subtle gap-2">
            <span className="text-xs">No differences found between source and target</span>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-fg-subtle gap-2">
            <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5" />
            <span className="text-xs">Cannot compare same schema with itself</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TableDiffDetail({ diff }: { diff: TableDiff }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Database strokeWidth={1.5} className="w-3.5 h-3.5 text-fg-tertiary" />
        <h3 className="text-xs font-medium text-fg">{diff.tableName}</h3>
        <Badge
          className={cn(
            "text-xs",
            diff.action === "added" && "bg-hue-green-tint/20 text-hue-green",
            diff.action === "removed" && "bg-hue-red-tint/20 text-hue-red",
            diff.action === "modified" && "bg-hue-yellow-tint/20 text-hue-yellow",
          )}
        >
          {diff.action}
        </Badge>
      </div>

      {/* Columns */}
      {diff.columns.length > 0 && (
        <div>
          <h4 className="text-xs text-fg-muted mb-2 font-medium">Columns</h4>
          <div className="space-y-1">
            {/* Keyed by the name the row is ABOUT, not by its position: the diff is
                recomputed whenever either side changes, and the rows come back in a
                different order, which had React reusing one column's row for another's.
                The inner `changes` lists are keyed by their own text — each entry names a
                different attribute ("Type changed:", "Nullable changed:", …), so the text
                is unique within a row and survives a reorder the way the index did not. */}
            {diff.columns.map((col) => (
              <div
                key={col.columnName}
                className={cn(
                  "px-3 py-2 rounded text-xs flex items-center gap-2",
                  col.action === "added" && "bg-hue-green-tint/5 border border-hue-green-tint/10",
                  col.action === "removed" && "bg-hue-red-tint/5 border border-hue-red-tint/10",
                  col.action === "modified" && "bg-hue-yellow-tint/5 border border-hue-yellow-tint/10",
                )}
              >
                <span className="font-mono text-fg-secondary min-w-[120px]">{col.columnName}</span>
                {col.action === "modified" && (
                  <div className="flex flex-col gap-0.5">
                    {col.changes.map((change) => (
                      <span key={change} className="text-xs text-fg-muted">
                        {change}
                      </span>
                    ))}
                  </div>
                )}
                {col.action === "added" && <span className="text-xs text-hue-green font-mono">{col.targetType}</span>}
                {col.action === "removed" && <span className="text-xs text-hue-red font-mono">{col.sourceType}</span>}
                <span className="ml-auto">{getActionIcon(col.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indexes */}
      {diff.indexes.length > 0 && (
        <div>
          <h4 className="text-xs text-fg-muted mb-2 font-medium">Indexes</h4>
          <div className="space-y-1">
            {diff.indexes.map((idx) => (
              <div
                key={idx.indexName}
                className={cn(
                  "px-3 py-2 rounded text-xs flex items-center gap-2",
                  idx.action === "added" && "bg-hue-green-tint/5 border border-hue-green-tint/10",
                  idx.action === "removed" && "bg-hue-red-tint/5 border border-hue-red-tint/10",
                  idx.action === "modified" && "bg-hue-yellow-tint/5 border border-hue-yellow-tint/10",
                )}
              >
                <span className="font-mono text-fg-secondary">{idx.indexName}</span>
                {idx.changes.map((change) => (
                  <span key={change} className="text-xs text-fg-muted">
                    {change}
                  </span>
                ))}
                <span className="ml-auto">{getActionIcon(idx.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Keys */}
      {diff.foreignKeys.length > 0 && (
        <div>
          <h4 className="text-xs text-fg-muted mb-2 font-medium">Foreign Keys</h4>
          <div className="space-y-1">
            {/* Keyed by the action as well as the column: a foreign key repointed at
                another table is TWO entries under one column name, because the diff
                engine keys an FK by `columnName→table.column` and reports the old one
                removed and the new one added. The column name alone gave React two
                children with the same key. */}
            {diff.foreignKeys.map((fk) => (
              <div
                key={`${fk.action}:${fk.columnName}`}
                className={cn(
                  "px-3 py-2 rounded text-xs flex items-center gap-2",
                  fk.action === "added" && "bg-hue-green-tint/5 border border-hue-green-tint/10",
                  fk.action === "removed" && "bg-hue-red-tint/5 border border-hue-red-tint/10",
                )}
              >
                <span className="font-mono text-fg-secondary">{fk.columnName}</span>
                {fk.changes.map((change) => (
                  <span key={change} className="text-xs text-fg-muted">
                    {change}
                  </span>
                ))}
                <span className="ml-auto">{getActionIcon(fk.action)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function getActionIcon(action: string) {
  switch (action) {
    case "added":
      return <Plus strokeWidth={1.5} className="w-3 h-3 text-hue-green" />;
    case "removed":
      return <Minus className="w-3 h-3 text-hue-red" />;
    case "modified":
      return <PenLine strokeWidth={1.5} className="w-3 h-3 text-hue-yellow" />;
    default:
      return null;
  }
}
