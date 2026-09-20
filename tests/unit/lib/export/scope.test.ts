import { describe, test, expect } from "bun:test";
import { describeExportScope } from "@/lib/export/scope";

const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ id: i }));

describe("describeExportScope", () => {
  test("counts the rows the file will actually contain", () => {
    expect(describeExportScope({ rows: rows(3) }, false).rowCount).toBe(3);
  });

  test("groups the digits, so a large count is readable at a glance", () => {
    expect(describeExportScope({ rows: rows(1234) }, false).countLabel).toBe("1,234");
  });

  test("says the whole result is written when nothing was held back", () => {
    const scope = describeExportScope({ rows: rows(42) }, false);

    expect(scope.summary).toBe("Writes all 42 rows.");
    expect(scope.shortfall).toBeNull();
  });

  test("agrees with itself about a single row", () => {
    expect(describeExportScope({ rows: rows(1) }, false).summary).toBe("Writes all 1 row.");
  });

  test("says nothing is written for an empty result", () => {
    expect(describeExportScope({ rows: [] }, false).summary).toBe("Writes all 0 rows.");
  });

  // The grid holds one page. Exporting it produces a well-formed file with a
  // plausible number of rows in it, which is exactly why the shortfall has to be
  // stated rather than left for the user to discover downstream.
  test("says only the loaded rows are written when the engine held more back", () => {
    const scope = describeExportScope(
      {
        rows: rows(500),
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true },
      },
      true,
    );

    expect(scope.summary).toBe("Writes the 500 rows loaded here.");
    expect(scope.shortfall).toBe("More rows are still on the server — load them first to include them.");
  });

  /**
   * A bound the USER typed is not a shortfall either (#816).
   *
   * `SELECT * FROM t LIMIT 500` returning exactly 500 rows used to report
   * `hasMore: true` — 500 rows against an execution limit of 500 — and this dialog then
   * warned of rows on the server and told the user to "load them first". There is no
   * Load More on such a statement and there never was: the limiter returns it untouched
   * and drops the offset with it, which is the defect #816 fixed. The advice named an
   * action the UI does not offer.
   *
   * The route's `hasMore` now also requires `wasLimited`, so the case arrives here as
   * "nothing was held back", and the file really does contain every row the statement
   * returns. Widening the statement is the user's move, not ours.
   */
  test("a bound the statement carried itself is not a shortfall, even filled exactly", () => {
    const scope = describeExportScope(
      {
        rows: rows(500),
        pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 500, wasLimited: false },
      },
      false,
    );

    expect(scope.summary).toBe("Writes all 500 rows.");
    expect(scope.shortfall).toBeNull();
  });

  /**
   * AN ENGINE THAT CANNOT PAGE IS NOT A SHORTFALL EITHER (#816).
   *
   * Measured 2026-09-20 with an unconnected provider: a tree click on Cassandra now
   * generates `SELECT * FROM app.orders;`, the limiter bounds it at the preview page size
   * (`wasLimited: true`, `limit: 50`) and a table of 50 or more rows fills it exactly, so
   * the route answers `hasMore: true`. Elasticsearch measures identically. Both declare
   * `supportsResultPagination: false` — `prepareQuery` throws on any `offset > 0` — so the
   * grid correctly offers no control.
   *
   * `hasMore` alone would make this dialog say "load them first" about an action that
   * exists nowhere in the product, which is the standard the comment above applies to the
   * user-typed bound. The grid's own offer is what the sentence is bound to instead.
   */
  test("an engine that cannot page is not asked to load more first", () => {
    const scope = describeExportScope(
      {
        rows: rows(50),
        pagination: { limit: 50, offset: 0, hasMore: true, totalReturned: 50, wasLimited: true },
      },
      false,
    );

    expect(scope.summary).toBe("Writes all 50 rows.");
    expect(scope.shortfall).toBeNull();
  });

  test("a limit the result fit inside is not a shortfall", () => {
    const scope = describeExportScope(
      {
        rows: rows(12),
        pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 12, wasLimited: true },
      },
      true,
    );

    expect(scope.summary).toBe("Writes all 12 rows.");
    expect(scope.shortfall).toBeNull();
  });
});
