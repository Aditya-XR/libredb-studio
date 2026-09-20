import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { StatsBar } from "@/components/results-grid/StatsBar";
import type { QueryResult } from "@/lib/types";
import type { CellChange } from "@/components/ResultsGrid";

function makeResult(): QueryResult {
  return {
    rows: [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ],
    fields: ["id", "name"],
    rowCount: 2,
    executionTime: 14,
    pagination: {
      limit: 2,
      offset: 0,
      hasMore: true,
      totalReturned: 2,
      wasLimited: true,
    },
  };
}

describe("results-grid/StatsBar", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders stats and filter summary, clears filters", () => {
    const onClearFilters = mock(() => {});
    const { queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={1}
        activeFilterCount={2}
        onClearFilters={onClearFilters}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );

    expect(queryByText("2 rows")).not.toBeNull();
    expect(queryByText("2 columns")).not.toBeNull();
    expect(queryByText("AUTO-LIMITED")).not.toBeNull();
    expect(queryByText("2 filters • 1 shown")).not.toBeNull();

    fireEvent.click(queryByText("2 filters • 1 shown")!);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  test("supports masking toggle and view switch", () => {
    const onToggleMasking = mock(() => {});
    const onSetViewMode = mock((mode: "card" | "table") => {
      void mode;
    });
    const { container, queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="table"
        onSetViewMode={onSetViewMode}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive
        effectiveMaskingEnabled={false}
        userCanToggle
        onToggleMasking={onToggleMasking}
      />,
    );

    expect(queryByText("MASK")).not.toBeNull();
    fireEvent.click(queryByText("MASK")!);
    expect(onToggleMasking).toHaveBeenCalledTimes(1);

    const buttons = container.querySelectorAll("button");
    fireEvent.click(buttons[buttons.length - 2]!);
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(onSetViewMode).toHaveBeenCalledTimes(2);
  });

  // ── Icon-only controls announce their name (#919) ──────────────────────────
  //
  // The two view toggles are icons with no text, and the test above had to reach them by
  // counting from the end of the button list - which is what a screen reader user has to
  // do too, except they cannot. The issue names the sidebar and adds that the results bar
  // has the same shape and is worth checking while someone is in there.

  test("the view toggles have names, not just icons", () => {
    const onSetViewMode = mock((mode: "card" | "table") => {
      void mode;
    });
    const { getByRole } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="table"
        onSetViewMode={onSetViewMode}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Card view" }));
    fireEvent.click(getByRole("button", { name: "Table view" }));
    expect(onSetViewMode).toHaveBeenCalledTimes(2);
    expect((onSetViewMode.mock.calls as unknown[][]).map((c) => c[0])).toEqual(["card", "table"]);
  });

  test("supports text wrapping toggle", () => {
    const onToggleWrapText = mock(() => {});
    const { queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="table"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={onToggleWrapText}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );

    expect(queryByText("WRAP")).not.toBeNull();
    fireEvent.click(queryByText("WRAP")!);
    expect(onToggleWrapText).toHaveBeenCalledTimes(1);
  });

  test("shows locked masked label when user cannot toggle", () => {
    const { queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive
        effectiveMaskingEnabled
        userCanToggle={false}
      />,
    );
    expect(queryByText("MASKED")).not.toBeNull();
  });

  test("renders no warnings badge when the engine reported none", () => {
    const { container, rerender } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );
    expect(container.textContent).not.toContain("WARNING");

    // An empty array must not render an empty affordance either.
    rerender(
      <StatsBar
        result={{ ...makeResult(), warnings: [] }}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );
    expect(container.textContent).not.toContain("WARNING");
  });

  test("renders a warnings badge whose message is reachable by tooltip and by screen reader", () => {
    const { getByTitle } = render(
      <StatsBar
        result={{
          ...makeResult(),
          warnings: [{ message: "2 segments of the queried data were unavailable." }],
        }}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );

    const badge = getByTitle("2 segments of the queried data were unavailable.");
    expect(badge.textContent).toContain("1 WARNING");
    expect(badge.querySelector(".sr-only")?.textContent).toContain("2 segments of the queried data were unavailable.");
  });

  test("counts several warnings and carries every message", () => {
    const { getByTitle } = render(
      <StatsBar
        result={{
          ...makeResult(),
          warnings: [{ message: "index advice available", code: "01000" }, { message: "rows were sampled" }],
        }}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );

    // Matchers normalize whitespace, so the newline-separated tooltip is asserted
    // on the raw attribute.
    const badge = getByTitle(/index advice available/);
    expect(badge.getAttribute("title")).toBe("index advice available\nrows were sampled");
    expect(badge.textContent).toContain("2 WARNINGS");
  });

  test("falls back to the engine's code when a warning carries no message", () => {
    // `0` is a legal code, so absence must be tested as absence - not as falsiness.
    const { getByTitle } = render(
      <StatsBar
        result={{ ...makeResult(), warnings: [{ message: "", code: 0 }, { message: "" }] }}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />,
    );

    const badge = getByTitle(/Warning 0/);
    expect(badge.getAttribute("title")).toBe("Warning 0\nWarning");
    expect(badge.textContent).toContain("2 WARNINGS");
  });

  test("shows pending changes actions and executes callbacks", () => {
    const onApplyChanges = mock(() => {});
    const onDiscardChanges = mock(() => {});
    const pendingChanges: CellChange[] = [
      { rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alicia" },
    ];
    const { queryByText, getByLabelText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        wrapText={false}
        onToggleWrapText={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
        editingEnabled
        pendingChanges={pendingChanges}
        onApplyChanges={onApplyChanges}
        onDiscardChanges={onDiscardChanges}
      />,
    );

    expect(queryByText("1 change")).not.toBeNull();
    fireEvent.click(getByLabelText("Apply changes"));
    fireEvent.click(getByLabelText("Discard changes"));
    expect(onApplyChanges).toHaveBeenCalledTimes(1);
    expect(onDiscardChanges).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE LOAD MORE CONTROL (#816, and the UI ruling on top of it).
 *
 * These are the `load-more-footer` cases from `tests/components/ResultsGrid.test.tsx`,
 * MOVED rather than deleted. They could not stay: that file mock.module's this whole
 * module, so its assertions were against a stub footer of its own making and would have
 * gone on passing against a control that no longer exists. Here the real component
 * renders. What stays in `ResultsGrid.test.tsx` is the decision it makes - whether an
 * offer is handed down at all - which is that file's own subject.
 *
 * There is no chrome below the grid any more. The control is the `(more available)` text
 * that already sat beside the row count, so the grid is the same height whether or not
 * another page exists.
 */
describe("results-grid/StatsBar - the load-more control (#816)", () => {
  afterEach(() => {
    cleanup();
  });

  const statsBar = (pageOffer?: { onLoadMore: () => void; pageSize: number }, isLoadingMore?: boolean) => (
    <StatsBar
      result={makeResult()}
      filteredRowCount={2}
      activeFilterCount={0}
      onClearFilters={mock(() => {})}
      viewMode="table"
      onSetViewMode={mock(() => {})}
      wrapText={false}
      onToggleWrapText={mock(() => {})}
      hasSensitive={false}
      effectiveMaskingEnabled={false}
      userCanToggle={false}
      pageOffer={pageOffer}
      isLoadingMore={isLoadingMore}
    />
  );

  test("names the page size the click will actually fetch", () => {
    // It was the literal "Load More (500 rows)". A table preview asks for 50, so that
    // label promised ten times what the click delivered from the moment the preview cap
    // stopped being written into the statement text.
    const { queryByText } = render(statsBar({ onLoadMore: mock(() => {}), pageSize: 50 }));

    expect(queryByText("load 50 more")).not.toBeNull();
    expect(queryByText("load 500 more")).toBeNull();
  });

  test("the control is a button in the stats strip, beside the row count", () => {
    // The ruling in one assertion: no chrome below the grid. The control shares a parent
    // with "2 rows", which is the strip itself, so nothing was added under the table.
    const { getByText } = render(statsBar({ onLoadMore: mock(() => {}), pageSize: 50 }));
    const control = getByText("load 50 more");

    expect(control.tagName).toBe("BUTTON");
    expect(control.closest("span")!.textContent).toContain("2 rows");
  });

  test("clicking it asks for the next page", () => {
    const onLoadMore = mock(() => {});
    const { getByText } = render(statsBar({ onLoadMore, pageSize: 50 }));

    fireEvent.click(getByText("load 50 more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("a page in flight disables the control and says so", () => {
    const onLoadMore = mock(() => {});
    const { getByText, queryByText } = render(statsBar({ onLoadMore, pageSize: 50 }, true));

    expect(queryByText("load 50 more")).toBeNull();
    const control = getByText("Loading...");
    expect((control.closest("button") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(control);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  test("renders no control, and no leftover row-count aside, when there is no offer", () => {
    // `hasMore` alone is not the condition any more. `makeResult()` reports it true, and
    // the strip still says nothing about another page: the offer is `ResultsGrid`'s
    // three-way decision and it is the only thing this component reads.
    const { container, queryByText, getByText } = render(statsBar(undefined));

    expect(queryByText("load 2 more")).toBeNull();
    expect(container.textContent).not.toContain("more available");
    // And nothing clickable was left behind in the row-count span: that span is where
    // the control lives when there is an offer, so a control rendered unconditionally
    // fails here rather than only being mislabelled.
    expect(
      getByText(/2 rows/)
        .closest("span")!
        .querySelector("button"),
    ).toBeNull();
  });
});

/**
 * Criterion 7: the grid says ONCE, beside the AUTO-LIMITED badge, that order across pages
 * is not guaranteed. Whether it is said is `ResultsGrid`'s decision and is asserted there;
 * this is about the sentence itself.
 */
describe("results-grid/StatsBar — the ordering notice (#816)", () => {
  afterEach(() => {
    cleanup();
  });

  const statsBar = (orderAcrossPagesUnspecified?: boolean) => (
    <StatsBar
      result={makeResult()}
      filteredRowCount={2}
      activeFilterCount={0}
      onClearFilters={mock(() => {})}
      viewMode="table"
      onSetViewMode={mock(() => {})}
      wrapText={false}
      onToggleWrapText={mock(() => {})}
      hasSensitive={false}
      effectiveMaskingEnabled={false}
      userCanToggle={false}
      orderAcrossPagesUnspecified={orderAcrossPagesUnspecified}
    />
  );

  const BADGE = "ORDER NOT GUARANTEED";
  const NOTICE = "Without an ORDER BY the engine may return rows that repeat or are skipped between pages.";

  test("states the condition once, beside the auto-limited badge", () => {
    const { queryAllByText, queryByTitle, getByText } = render(statsBar(true));

    expect(queryAllByText(BADGE)).toHaveLength(1);
    // Beside the badge, in the same left-hand group, so the two read as one sentence
    // about the same bound rather than as a warning of their own.
    expect(getByText(BADGE).parentElement).toBe(getByText("AUTO-LIMITED").parentElement);
    // Terse in the strip, whole to anyone who hovers or listens: the sentence is on the
    // title and in an sr-only span, the idiom the warning badge beside it already uses.
    // A sentence of this length inline wraps the strip on a narrow panel, and a strip
    // that changes height with the query is what deleting the footer was for.
    expect(queryByTitle(NOTICE)).not.toBeNull();
    expect(getByText(BADGE).textContent).toBe(`${BADGE}: ${NOTICE}`);
  });

  test("says nothing when the grid did not ask for it", () => {
    const shown = render(statsBar(false));
    expect(shown.queryByText(BADGE)).toBeNull();
    expect(shown.queryByTitle(NOTICE)).toBeNull();
    cleanup();
    const absent = render(statsBar());
    expect(absent.queryByText(BADGE)).toBeNull();
    expect(absent.queryByTitle(NOTICE)).toBeNull();
  });
});
