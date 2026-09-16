import { describe, expect, test } from "bun:test";
import { DB_TYPES_PREVIEW } from "@/components/admin/tabs/OverviewTab";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { getDBConfig } from "@/lib/db-ui-config";

// No mock.module() on db-ui-config or compatibility here: the empty-state card's own test
// file mocks getDBConfig to return the label "PostgreSQL" for every type, which makes it
// blind to which real names are on screen. This file imports both modules unmocked so the
// preview list's actual labels and membership can be checked against the real catalog.

describe("OverviewTab DB_TYPES_PREVIEW", () => {
  test("every previewed type-id is a real external engine", () => {
    for (const type of DB_TYPES_PREVIEW) {
      expect(EXTERNAL_DATABASE_TYPES).toContain(type);
    }
  });

  test("spans relational, document, key-value, wide-column, search and analytics, not six flavours of one category", () => {
    const labels = DB_TYPES_PREVIEW.map((type) => getDBConfig(type).label);
    expect(labels).toContain("PostgreSQL");
    expect(labels).toContain("MongoDB");
    expect(labels).toContain("Redis");
    expect(labels).toContain("Apache Cassandra");
    expect(labels).toContain("Elasticsearch");
    expect(labels).toContain("ClickHouse");
  });

  test("stays shorter than the full catalog, so the card still names a hidden remainder", () => {
    expect(DB_TYPES_PREVIEW.length).toBeLessThan(EXTERNAL_DATABASE_TYPES.length);
  });
});
