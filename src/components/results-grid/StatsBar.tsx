"use client";

import React from "react";
import { QueryResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  LayoutGrid,
  Table2,
  LoaderCircle,
  EyeOff,
  Eye,
  Save,
  X,
  Funnel,
  Lock,
  WrapText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CellChange } from "@/components/ResultsGrid";
import { describeWarning } from "@/components/results-grid/utils";

const MASKED_LABEL = "MASKED";
const LOADING_LABEL = "Loading...";
/**
 * The control's label, which names the size of the page the click will fetch.
 *
 * It was the literal "Load More (500 rows)" on a button below the grid. A table preview
 * asks for 50, so that label promised ten times what the click delivered from the moment
 * the preview cap stopped being written into the statement (#816). Lower case and no
 * parentheses because it is now a phrase in the stats strip, read as a continuation of
 * the row count beside it: "50 rows - load 50 more".
 */
const loadMoreLabel = (pageSize: number) => `load ${pageSize} more`;

/**
 * Criterion 7, beside the AUTO-LIMITED badge.
 *
 * A statement of fact and not a warning: an unordered query paginates, and this is what
 * paging it means. It is not styled as an error and it blocks nothing, because Studio
 * will not inject an `ORDER BY` to prevent the condition and the user may well not care
 * about it. `ResultsGrid` decides when it is shown and will not show it where no next
 * page can be asked for.
 *
 * A badge in the AUTO-LIMITED idiom rather than a sentence, with the sentence itself on
 * the `title` and in an `sr-only` span the way the warning badge below carries its
 * detail. A sentence of this length wraps the strip onto a second line on a narrow
 * results panel, and a strip whose height changes with the query is the thing the footer
 * was deleted to stop.
 */
const ORDER_BADGE = "ORDER NOT GUARANTEED";
const ORDER_NOTICE = "Without an ORDER BY the engine may return rows that repeat or are skipped between pages.";

export interface StatsBarProps {
  result: QueryResult;
  filteredRowCount: number;
  activeFilterCount: number;
  onClearFilters: () => void;
  viewMode: "card" | "table";
  onSetViewMode: (mode: "card" | "table") => void;
  wrapText: boolean;
  onToggleWrapText: () => void;
  // Masking props
  hasSensitive: boolean;
  effectiveMaskingEnabled: boolean;
  userCanToggle: boolean;
  onToggleMasking?: () => void;
  // Editing props
  editingEnabled?: boolean;
  pendingChanges?: CellChange[];
  onApplyChanges?: () => void;
  onDiscardChanges?: () => void;
  /**
   * Whether this result is pageable AND its statement carries no `ORDER BY` (#816).
   *
   * A decision, not the inputs to one. It is made once in `ResultsGrid`, from the same
   * value that decides whether the load-more control renders, so the notice cannot appear
   * beside a control that is not there.
   */
  orderAcrossPagesUnspecified?: boolean;
  /**
   * The offer of a next page, or absent where there is none (#816).
   *
   * A decision for the same reason `orderAcrossPagesUnspecified` is: `ResultsGrid` makes
   * it once, from the provider's `supportsResultPagination`, the route's `hasMore` and
   * whether this surface will fetch at all. Passing the three inputs here instead would
   * be a second place for them to be combined, and the notice above is the proof that
   * two copies of one condition drift.
   *
   * `pageSize` is `result.pagination.limit`, the size of the page already on screen, so
   * the label names what the click delivers.
   *
   * This replaces `onLoadMore` and `isLoadingMore`, which this interface declared and
   * neither destructured nor rendered: `ResultsGrid` passed neither and the footer took
   * them directly. Dead props that look wired are how the next reader binds a control to
   * a callback nothing supplies.
   */
  pageOffer?: { onLoadMore: () => void; pageSize: number };
  /** Whether a page asked for through `pageOffer` is in flight; the control is disabled and says so. */
  isLoadingMore?: boolean;
}

export function StatsBar({
  result,
  filteredRowCount,
  activeFilterCount,
  onClearFilters,
  viewMode,
  onSetViewMode,
  wrapText,
  onToggleWrapText,
  hasSensitive,
  effectiveMaskingEnabled,
  userCanToggle,
  onToggleMasking,
  editingEnabled,
  pendingChanges,
  onApplyChanges,
  onDiscardChanges,
  orderAcrossPagesUnspecified,
  pageOffer,
  isLoadingMore,
}: StatsBarProps) {
  const warnings = result.warnings ?? [];
  const warningDetail = warnings.map(describeWarning).join("\n");

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-hairline bg-surface text-xs text-fg-muted font-mono">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-success-tint/50" />
          {result.rows.length} rows
          {/*
            THE LOAD MORE CONTROL (#816). It stands where the "(more available)" text
            stood: the same fact, now the thing you click, so the grid gains no chrome
            and keeps its height whether or not another page exists.

            Gated on `pageOffer` alone and not on `result.pagination?.hasMore`, which is
            what the text read before. `hasMore` is one of the three conditions the offer
            already carries, and re-reading it here would let the strip announce a page
            on a surface that cannot fetch it.
          */}
          {pageOffer && (
            <>
              <span aria-hidden="true">&bull;</span>
              <button
                type="button"
                onClick={pageOffer.onLoadMore}
                disabled={isLoadingMore}
                className="flex items-center gap-1 text-brand bg-brand-tint/10 px-2 py-0.5 rounded hover:bg-brand-tint/20 disabled:opacity-60 disabled:hover:bg-brand-tint/10 transition-colors"
              >
                {isLoadingMore ? (
                  <>
                    <LoaderCircle strokeWidth={1.5} className="w-3 h-3 animate-spin" />
                    {LOADING_LABEL}
                  </>
                ) : (
                  <>
                    <ChevronDown strokeWidth={1.5} className="w-3 h-3" />
                    {loadMoreLabel(pageOffer.pageSize)}
                  </>
                )}
              </button>
            </>
          )}
        </span>
        <span className="hidden sm:inline">{result.fields.length} columns</span>
        {activeFilterCount > 0 && (
          <button
            className="flex items-center gap-1 text-brand text-xs bg-brand-tint/10 px-2 py-0.5 rounded hover:bg-brand-tint/20 transition-colors"
            onClick={onClearFilters}
            title="Clear all filters"
          >
            <Funnel strokeWidth={1.5} className="w-3 h-3" />
            {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""} &bull; {filteredRowCount} shown
            <X strokeWidth={1.5} className="w-3 h-3" />
          </button>
        )}
        {result.pagination?.wasLimited && (
          <span className="text-brand text-xs bg-brand-tint/10 px-2 py-0.5 rounded">AUTO-LIMITED</span>
        )}
        {orderAcrossPagesUnspecified && (
          <span className="text-fg-muted text-xs bg-fill px-2 py-0.5 rounded" title={ORDER_NOTICE}>
            {ORDER_BADGE}
            <span className="sr-only">: {ORDER_NOTICE}</span>
          </span>
        )}
        {warnings.length > 0 && (
          <span className="text-warning text-xs bg-warning-tint/10 px-2 py-0.5 rounded" title={warningDetail}>
            {warnings.length} WARNING{warnings.length > 1 ? "S" : ""}
            <span className="sr-only">: {warningDetail}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {hasSensitive &&
          (userCanToggle && onToggleMasking ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                "h-6 px-2 text-xs font-medium gap-1",
                effectiveMaskingEnabled ? "text-hue-purple bg-hue-purple-tint/10" : "text-fg-muted",
              )}
              onClick={onToggleMasking}
              title={effectiveMaskingEnabled ? "Show sensitive data" : "Mask sensitive data"}
            >
              {effectiveMaskingEnabled ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {effectiveMaskingEnabled ? "MASKED" : "MASK"}
            </Button>
          ) : effectiveMaskingEnabled ? (
            <span className="h-6 px-2 text-xs font-medium text-hue-purple bg-hue-purple-tint/10 rounded flex items-center gap-1">
              <Lock strokeWidth={1.5} className="w-3 h-3" />
              {MASKED_LABEL}
            </span>
          ) : null)}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-6 px-2 text-xs font-medium gap-1",
            wrapText ? "text-brand bg-brand-tint/10" : "text-fg-muted",
          )}
          onClick={onToggleWrapText}
          title={wrapText ? "Disable text wrapping" : "Enable text wrapping"}
        >
          <WrapText className="w-3 h-3" />
          {wrapText ? "WRAP ON" : "WRAP"}
        </Button>

        {editingEnabled && pendingChanges && pendingChanges.length > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-warning bg-warning-tint/10 px-1.5 py-0.5 rounded">
              {pendingChanges.length} change{pendingChanges.length > 1 ? "s" : ""}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-success hover:bg-success-tint/10"
              aria-label="Apply changes"
              onClick={onApplyChanges}
            >
              <Save strokeWidth={1.5} className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-danger hover:bg-danger-tint/10"
              aria-label="Discard changes"
              onClick={onDiscardChanges}
            >
              <X strokeWidth={1.5} className="w-3 h-3" />
            </Button>
          </div>
        )}

        <span className="hidden sm:flex px-2 py-0.5 rounded bg-fill border border-hairline">
          EXEC TIME: {result.executionTime || "0ms"}
        </span>

        <div className="flex md:hidden items-center bg-fill rounded-lg p-0.5">
          <button
            onClick={() => onSetViewMode("card")}
            aria-label="Card view"
            title="Card view"
            className={cn(
              "p-1.5 rounded transition-all",
              viewMode === "card" ? "bg-brand-solid text-white" : "text-fg-muted",
            )}
          >
            <LayoutGrid strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onSetViewMode("table")}
            aria-label="Table view"
            title="Table view"
            className={cn(
              "p-1.5 rounded transition-all",
              viewMode === "table" ? "bg-brand-solid text-white" : "text-fg-muted",
            )}
          >
            <Table2 strokeWidth={1.5} className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
