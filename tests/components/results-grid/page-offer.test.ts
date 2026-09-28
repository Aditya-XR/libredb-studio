import { describe, test, expect } from "bun:test";
import { pageOfferFor } from "@/components/results-grid/page-offer";
import type { QueryPagination } from "@/lib/types";

/**
 * The ONE definition of "another page can be fetched" (#816).
 *
 * Two surfaces ask it about the same rows: `ResultsGrid`, which renders the control, and
 * `BottomPanel`, which decides whether the export dialog tells the user to load more rows
 * first. Written out twice they drift silently, so it is written once and asserted here.
 */
const pagination = (overrides: Partial<QueryPagination> = {}): QueryPagination => ({
  limit: 50,
  offset: 0,
  hasMore: true,
  totalReturned: 50,
  wasLimited: true,
  ...overrides,
});

const fetchPage = () => {};

describe("pageOfferFor (#816)", () => {
  test("offers the page already on screen as the size of the next one", () => {
    // Not a constant: a table preview is 50 rows and a hand-run statement is 500, and a
    // hardcoded 500 made the second page ten times the first.
    expect(pageOfferFor(pagination({ limit: 500 }), true, fetchPage)).toEqual({
      onLoadMore: fetchPage,
      pageSize: 500,
    });
  });

  test.each([
    ["the provider cannot apply an offset", pagination(), false as boolean | undefined, fetchPage],
    ["the provider declared nothing at all", pagination(), undefined, fetchPage],
    ["the route says this is the last page", pagination({ hasMore: false }), true, fetchPage],
    ["there is no pagination metadata", undefined, true, fetchPage],
    ["this surface will not fetch", pagination(), true, undefined],
  ])("no offer when %s", (_label, meta, supported, onLoadMore) => {
    expect(pageOfferFor(meta, supported, onLoadMore)).toBeUndefined();
  });
});
