"use client";

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Columns3, GripVertical, ArrowRight, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { DatabaseType, QueryResult } from "@/lib/types";
import { maskValueByPattern, maskingInForce, type MaskingConfig, type MaskingPattern } from "@/lib/data-masking";
import { splitMaskedColumns } from "@/lib/db/masking-exemption";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import type { ProviderCapabilities } from "@/lib/db/types";
import { quoteLiteral } from "@/lib/sql/values";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { downloadText } from "@/lib/export/download";
import { pivotTableText } from "@/lib/export/pivot-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface PivotTableProps {
  readonly result: QueryResult | null;
  readonly onLoadQuery?: (query: string) => void;
  /** The connected engine, so a generated literal is quoted the way it reads it. */
  readonly databaseType?: string;
  /**
   * Whether this connection can RUN the SQL this panel generates, or undefined while nobody knows.
   *
   * A browser pass on OPC UA pressed Generate SQL and watched it replace the reader's JSON read
   * request with a SELECT the engine cannot parse - the editor's contents gone, and the only way
   * back the undo stack. The engine's declared `queryLanguage` is the fact, so the control is drawn
   * where the answer is yes or not yet known and withheld where it is no.
   */
  readonly offersGeneratedSql?: boolean;
  /**
   * The grid's masking inputs, handed down the same way the graph view takes them
   * (#1939). While masking is in force the pivot's keys and its download show the
   * masked text the grid shows, and a masked column is never offered as a value source.
   * Undefined config means no masking, which is every caller that never heard of it.
   */
  readonly maskingEnabled?: boolean;
  readonly userRole?: string;
  readonly maskingConfig?: MaskingConfig;
  /** The provider's columns the masking rules must leave alone (`ProviderCapabilities.maskingExemptColumns`). */
  readonly maskingExemptColumns?: ProviderCapabilities["maskingExemptColumns"];
}

type AggFunction = "count" | "sum" | "avg" | "min" | "max";

const AGG_LABELS: Record<AggFunction, string> = {
  count: "COUNT",
  sum: "SUM",
  avg: "AVG",
  min: "MIN",
  max: "MAX",
};

export function aggregate(values: unknown[], fn: AggFunction): string {
  const nums = values.map((v) => Number(v)).filter((n) => !isNaN(n));

  switch (fn) {
    case "count":
      return String(values.length);
    case "sum":
      return nums.length ? nums.reduce((a, b) => a + b, 0).toFixed(2) : "0";
    case "avg":
      return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : "0";
    case "min":
      return nums.length ? String(Math.min(...nums)) : "-";
    case "max":
      return nums.length ? String(Math.max(...nums)) : "-";
  }
}

/**
 * A group key as the text it is DRAWN as, lowercased for a sort: a masked field's
 * keys order by their mask (#1491's rule in the grid), so the rank of the hidden
 * prefixes never leaks through the row order. Ties keep first-seen order
 * (Array#sort is stable).
 */
function maskedLabel(labels: Map<string, string>, key: string): string {
  return (labels.get(key) ?? key).toLowerCase();
}

export function PivotTable({
  result,
  onLoadQuery,
  databaseType,
  offersGeneratedSql,
  maskingEnabled,
  userRole,
  maskingConfig,
  maskingExemptColumns,
}: PivotTableProps) {
  const [rowField, setRowField] = useState<string | null>(null);
  const [colField, setColField] = useState<string | null>(null);
  const [valueField, setValueField] = useState<string | null>(null);
  const [aggFunction, setAggFunction] = useState<AggFunction>("count");
  const fields = result?.fields || [];
  const rows = useMemo(() => result?.rows || [], [result?.rows]);

  // The grid's own masking decision for THIS result, exemptions included, so the pivot
  // and the grid can never disagree about one column (#1421, #1939).
  const sensitiveColumns = useMemo(
    () =>
      maskingConfig === undefined || !maskingInForce(userRole, maskingConfig, maskingEnabled)
        ? new Map<string, MaskingPattern>()
        : splitMaskedColumns(fields, maskingConfig, maskingExemptColumns).masked,
    [fields, maskingConfig, userRole, maskingEnabled, maskingExemptColumns],
  );

  // The text a key is drawn and downloaded as, computed from the RAW value (so a real
  // string "NULL" is masked like any other value, and a null group keeps the grid's
  // "NULL"). Grouping below stays on the raw value, so two values that share one mask
  // keep their own groups and counts; the mask is only how the group is labelled.
  const labelFor = useCallback(
    (field: string, raw: unknown): string => {
      const pattern = sensitiveColumns.get(field);
      if (pattern !== undefined) return maskValueByPattern(raw, pattern);
      return String(raw ?? "NULL");
    },
    [sensitiveColumns],
  );

  // A masked column is never a value source while masking is in force: its mask text is
  // not numeric, and its raw numbers must not be summed into a cell anyone can read.
  const effectiveValueField = valueField !== null && !sensitiveColumns.has(valueField) ? valueField : null;

  // Auto-detect fields on first render
  useEffect(() => {
    if (fields.length >= 2 && !rowField) {
      const strCol = fields.find((f) => {
        const sample = rows[0]?.[f];
        return typeof sample === "string";
      });
      if (strCol) setRowField(strCol);

      const numCol = fields.find((f) => {
        const sample = rows[0]?.[f];
        return typeof sample === "number" && !sensitiveColumns.has(f);
      });
      if (numCol) setValueField(numCol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.length]);

  // Compute pivot data
  const pivotData = useMemo(() => {
    if (!rowField || !rows.length) return null;

    // Group rows
    const groups = new Map<string, Map<string, unknown[]>>();
    const colValues = new Set<string>();

    const rowKeyLabels = new Map<string, string>();
    const colKeyLabels = new Map<string, string>();

    for (const row of rows) {
      const rowKey = String(row[rowField] ?? "NULL");
      const colKey = colField ? String(row[colField] ?? "NULL") : "__all__";
      const value = effectiveValueField ? row[effectiveValueField] : 1;

      if (colField) {
        colValues.add(colKey);
        if (!colKeyLabels.has(colKey)) colKeyLabels.set(colKey, labelFor(colField, row[colField]));
      }

      if (!groups.has(rowKey)) groups.set(rowKey, new Map());
      if (!rowKeyLabels.has(rowKey)) rowKeyLabels.set(rowKey, labelFor(rowField, row[rowField]));
      const colMap = groups.get(rowKey)!;
      if (!colMap.has(colKey)) colMap.set(colKey, []);
      colMap.get(colKey)!.push(value);
    }

    // Masked keys sort by their masked label, as the grid's maskedSortFns do (#1491):
    // the raw-key sort leaks the rank of the hidden prefixes (ssn values 900-11-0001,
    // 100-22-0002, 500-33-0003 would read 0002, 0003, 0001). The label maps are already
    // built in the loop above; ties keep first-seen order. (#1939)
    const rowMasked = sensitiveColumns.has(rowField);
    const colMasked = colField !== null && sensitiveColumns.has(colField);
    const colKeys = colField
      ? Array.from(colValues).sort((a, b) =>
          colMasked ? maskedLabel(colKeyLabels, a).localeCompare(maskedLabel(colKeyLabels, b)) : a.localeCompare(b),
        )
      : ["__all__"];

    // Build pivot rows
    const pivotRows: { rowKey: string; values: Map<string, string> }[] = [];
    for (const [rowKey, colMap] of groups) {
      const values = new Map<string, string>();
      for (const ck of colKeys) {
        const vals = colMap.get(ck) || [];
        values.set(ck, aggregate(vals, aggFunction));
      }
      pivotRows.push({ rowKey, values });
    }

    // Sort by row key — by masked label when the row field is masked (see above).
    pivotRows.sort((a, b) =>
      rowMasked
        ? maskedLabel(rowKeyLabels, a.rowKey).localeCompare(maskedLabel(rowKeyLabels, b.rowKey))
        : a.rowKey.localeCompare(b.rowKey),
    );

    return { colKeys, pivotRows, rowKeyLabels, colKeyLabels };
  }, [rows, rowField, colField, effectiveValueField, aggFunction, labelFor, sensitiveColumns]);

  const exportPivot = useCallback(
    (format: "csv" | "json") => {
      if (!pivotData || !rowField) return;

      // The download carries exactly what the screen shows: masked keys, aggregate cells.
      // Two raw keys can share ONE mask, and the JSON form keys its records by these
      // headers - an unchecked duplicate would silently overwrite one group's column,
      // so repeats take the result's own "name (2)" spelling (#1939).
      const headers = uniqueFieldNames([
        rowField,
        ...pivotData.colKeys.map((ck) =>
          ck === "__all__"
            ? `${AGG_LABELS[aggFunction]}(${effectiveValueField || "*"})`
            : (pivotData.colKeyLabels.get(ck) ?? ck),
        ),
      ]);

      const rows = pivotData.pivotRows.map((row) => [
        pivotData.rowKeyLabels.get(row.rowKey) ?? row.rowKey,
        ...pivotData.colKeys.map((ck) => row.values.get(ck) || "0"),
      ]);

      downloadText(
        pivotTableText(headers, rows, format),
        format === "csv" ? "text/csv" : "application/json",
        `pivot_table_${Date.now()}.${format}`,
      );
    },
    [pivotData, rowField, colField, effectiveValueField, aggFunction],
  );

  // Generate SQL
  const generateSQL = useCallback(() => {
    if (!rowField) return "";
    // Every name here is arbitrary result data: a field is whatever the query
    // aliased it to, and a pivot key is a value the rows carried. Both are quoted
    // for the connected dialect rather than wrapped in a hard-coded `"` — that
    // form is not even an identifier on MySQL, and a name holding the closing
    // quote character would end the span and leave the rest to be parsed as SQL
    // (#290, PR #304 review).
    const dialect = databaseType as DatabaseType | undefined;
    const quote = (name: string) => quoteIdentifier(name, dialect);
    const select: string[] = [quote(rowField)];
    const groupBy: string[] = [quote(rowField)];

    if (colField) {
      // Use CASE WHEN for pivot columns
      const colKeys = pivotData?.colKeys || [];
      for (const ck of colKeys) {
        if (ck === "__all__") continue;
        const valExpr = effectiveValueField ? quote(effectiveValueField) : "1";
        // The same key is a VALUE on the left of the comparison and an IDENTIFIER
        // as the column's alias, so it is quoted both ways in the same line.
        select.push(
          `${AGG_LABELS[aggFunction]}(CASE WHEN ${quote(colField)} = ${quoteLiteral(ck, dialect)} THEN ${valExpr} END) AS ${quote(ck)}`,
        );
      }
    } else {
      const valExpr = effectiveValueField ? quote(effectiveValueField) : "*";
      select.push(`${AGG_LABELS[aggFunction]}(${valExpr}) AS ${quote(`${aggFunction}_value`)}`);
    }

    return `SELECT\n  ${select.join(",\n  ")}\nFROM your_table\nGROUP BY ${groupBy.join(", ")}\nORDER BY ${groupBy.join(", ")};`;
  }, [rowField, colField, effectiveValueField, aggFunction, pivotData, databaseType]);

  if (!result || rows.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center opacity-30">
        <Columns3 strokeWidth={1.5} className="w-8 h-8 mb-3" />
        <p className="text-xs font-medium">Pivot Table</p>
        <p className="text-xs text-fg-muted mt-1">Execute a query to create pivot tables</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-sunken">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-hairline bg-surface flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-fg-muted font-medium">Rows:</span>
          <select
            value={rowField || ""}
            onChange={(e) => setRowField(e.target.value || null)}
            className="bg-overlay border border-hairline-strong rounded px-2 py-1 text-xs text-fg-secondary outline-none"
          >
            <option value="">Select...</option>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-fg-muted font-medium">Columns:</span>
          <select
            value={colField || ""}
            onChange={(e) => setColField(e.target.value || null)}
            className="bg-overlay border border-hairline-strong rounded px-2 py-1 text-xs text-fg-secondary outline-none"
          >
            <option value="">None</option>
            {fields
              .filter((f) => f !== rowField)
              .map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-fg-muted font-medium">Values:</span>
          <select
            value={effectiveValueField || ""}
            onChange={(e) => setValueField(e.target.value || null)}
            className="bg-overlay border border-hairline-strong rounded px-2 py-1 text-xs text-fg-secondary outline-none"
          >
            <option value="">Count</option>
            {fields
              .filter((f) => f !== rowField && f !== colField && !sensitiveColumns.has(f))
              .map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          {(Object.keys(AGG_LABELS) as AggFunction[]).map((fn) => (
            <button
              key={fn}
              onClick={() => setAggFunction(fn)}
              className={cn(
                "px-1.5 py-0.5 rounded text-xs font-medium transition-colors",
                aggFunction === fn
                  ? "bg-brand-tint/20 text-brand border border-brand-tint/20"
                  : "text-fg-subtle hover:text-fg-tertiary",
              )}
            >
              {AGG_LABELS[fn]}
            </button>
          ))}
        </div>

        {/*
          Withheld while the COLUMN field is masked: its values are the CASE WHEN
          literals, and a masked literal silently matches nothing - the same reason the
          SQL INSERT export is withheld while a column is masked (#1433). A masked row
          field reaches the statement only as an identifier, so the control stays.
        */}
        {onLoadQuery &&
          rowField &&
          offersGeneratedSql !== false &&
          !(colField !== null && sensitiveColumns.has(colField)) && (
            <button
              onClick={() => {
                const sql = generateSQL();
                if (sql) onLoadQuery(sql);
              }}
              className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-fg-muted hover:text-brand hover:bg-brand-tint/10 transition-colors"
            >
              <ArrowRight strokeWidth={1.5} className="w-3 h-3" /> Generate SQL
            </button>
          )}
        {pivotData && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded-md hover:bg-surface-hover"
              >
                <Download className="w-3.5 h-3.5" />
                Export
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportPivot("csv")}>Export as CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportPivot("json")}>Export as JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {pivotData && pivotData.pivotRows.length > 0 && (
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10 bg-raised">
              <tr>
                <th className="text-left px-3 py-2 text-fg-muted border-b border-r border-hairline font-medium">
                  {rowField}
                </th>
                {pivotData.colKeys.map((ck) => (
                  <th
                    key={ck}
                    className="text-right px-3 py-2 text-fg-muted border-b border-r border-hairline font-medium"
                  >
                    {ck === "__all__"
                      ? `${AGG_LABELS[aggFunction]}(${effectiveValueField || "*"})`
                      : (pivotData.colKeyLabels.get(ck) ?? ck)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pivotData.pivotRows.map((row, i) => (
                <tr key={i} className="hover:bg-brand-tint/[0.03] border-b border-hairline">
                  <td className="px-3 py-1.5 text-fg-secondary border-r border-hairline font-medium">
                    {pivotData.rowKeyLabels.get(row.rowKey) ?? row.rowKey}
                  </td>
                  {pivotData.colKeys.map((ck) => (
                    <td key={ck} className="px-3 py-1.5 text-right text-hue-amber/90 border-r border-hairline">
                      {row.values.get(ck) || "0"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(!pivotData || pivotData.pivotRows.length === 0) && (
          <div className="flex flex-col items-center justify-center h-full opacity-30">
            <GripVertical strokeWidth={1.5} className="w-6 h-6 mb-2" />
            <p className="text-xs">Select row and value fields to build pivot</p>
          </div>
        )}
      </div>

      {pivotData && (
        <div className="px-4 py-1.5 border-t border-hairline bg-surface text-xs text-fg-muted font-mono">
          {`${pivotData.pivotRows.length} groups • ${pivotData.colKeys.length} columns • ${AGG_LABELS[aggFunction]} aggregation`}
        </div>
      )}
    </div>
  );
}
