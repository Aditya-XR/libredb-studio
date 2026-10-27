import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import React from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, fireEvent } from "@testing-library/react";

const mockDownloadText = mock((_content: string, _mimeType: string, _fileName: string) => {});
mock.module("@/lib/export/download", () => ({
  downloadText: mockDownloadText,
}));

mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

import { PivotTable, aggregate } from "@/components/PivotTable";
import { DEFAULT_MASKING_CONFIG, maskValueByPattern } from "@/lib/data-masking";
import type { QueryResult } from "@/lib/types";

const result: QueryResult = {
  rows: [
    { dept: "Engineering", status: "active", salary: 90000 },
    { dept: "Engineering", status: "inactive", salary: 85000 },
    { dept: "Sales", status: "active", salary: 70000 },
    { dept: "Sales", status: "active", salary: 75000 },
  ],
  fields: ["dept", "status", "salary"],
  rowCount: 4,
  executionTime: 5,
};

describe("PivotTable", () => {
  afterEach(() => {
    cleanup();
    mockDownloadText.mockClear();
  });

  test("exports the configured pivot table as CSV", () => {
    const { getByText } = render(<PivotTable result={result} />);

    fireEvent.click(getByText("Export as CSV"));

    expect(mockDownloadText).toHaveBeenCalledTimes(1);

    const [content, mimeType, fileName] = mockDownloadText.mock.calls[0];

    expect(mimeType).toBe("text/csv");
    expect(fileName).toMatch(/^pivot_table_\d+\.csv$/);
    expect(content).toContain("dept");
    expect(content).toContain("COUNT(salary)");
    expect(content).toContain("Engineering");
    expect(content).toContain("Sales");
    expect(content).toContain("2");
  });

  test("exports the configured pivot table as JSON", () => {
    const { getByText } = render(<PivotTable result={result} />);

    fireEvent.click(getByText("Export as JSON"));

    expect(mockDownloadText).toHaveBeenCalledTimes(1);

    const [content, mimeType, fileName] = mockDownloadText.mock.calls[0];

    expect(mimeType).toBe("application/json");
    expect(fileName).toMatch(/^pivot_table_\d+\.json$/);

    const exported = JSON.parse(content);

    expect(exported).toEqual([
      { dept: "Engineering", "COUNT(salary)": "2" },
      { dept: "Sales", "COUNT(salary)": "2" },
    ]);
  });

  test("exports the column field and aggregation the screen shows, not the defaults", () => {
    const { container, getByText } = render(<PivotTable result={result} />);
    fireEvent.change(container.querySelectorAll("select")[1]!, { target: { value: "status" } });
    fireEvent.click(getByText("SUM"));

    fireEvent.click(getByText("Export as CSV"));
    fireEvent.click(getByText("Export as JSON"));

    expect(mockDownloadText.mock.calls[0][0]).toBe(
      ["dept,active,inactive", "Engineering,90000.00,85000.00", "Sales,145000.00,0"].join("\n"),
    );
    expect(JSON.parse(mockDownloadText.mock.calls[1][0])).toEqual([
      { dept: "Engineering", active: "90000.00", inactive: "85000.00" },
      { dept: "Sales", active: "145000.00", inactive: "0" },
    ]);
  });

  test("shows empty state when result is null", () => {
    const { queryByText } = render(<PivotTable result={null} />);
    expect(queryByText("Pivot Table")).not.toBeNull();
    expect(queryByText("Execute a query to create pivot tables")).not.toBeNull();
  });

  test("shows empty state when result has no rows", () => {
    const empty: QueryResult = { rows: [], fields: ["id"], rowCount: 0, executionTime: 1 };
    const { queryByText } = render(<PivotTable result={empty} />);
    expect(queryByText("Pivot Table")).not.toBeNull();
  });

  test("renders config bar and auto-detects fields", () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText("COUNT")).not.toBeNull();
    expect(queryByText("SUM")).not.toBeNull();
    expect(queryByText("AVG")).not.toBeNull();
    expect(queryByText("MIN")).not.toBeNull();
    expect(queryByText("MAX")).not.toBeNull();
  });

  test("renders pivot data with row field detected", () => {
    const { container } = render(<PivotTable result={result} />);
    const text = container.textContent || "";
    expect(text).toContain("groups");
  });

  test("shows row/column/value labels", () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText("Rows:")).not.toBeNull();
    expect(queryByText("Columns:")).not.toBeNull();
    expect(queryByText("Values:")).not.toBeNull();
  });

  test("auto-detects string column as rowField and numeric as valueField", () => {
    const { container } = render(<PivotTable result={result} />);
    const selects = container.querySelectorAll("select");
    // First select is rowField — should have dept auto-selected
    expect(selects[0]?.value).toBe("dept");
    // Third select is valueField — should have salary auto-selected
    expect(selects[2]?.value).toBe("salary");
  });

  test("changing row field select updates pivot", () => {
    const { container } = render(<PivotTable result={result} />);
    const rowSelect = container.querySelectorAll("select")[0];
    fireEvent.change(rowSelect!, { target: { value: "status" } });
    const text = container.textContent || "";
    // After selecting 'status', should show groups based on active/inactive
    expect(text).toContain("active");
  });

  test("changing column field adds pivot columns", () => {
    const { container } = render(<PivotTable result={result} />);
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    const text = container.textContent || "";
    // Column headers should include status values
    expect(text).toContain("active");
    expect(text).toContain("inactive");
  });

  test("changing value field select updates pivot", () => {
    const { container } = render(<PivotTable result={result} />);
    const valSelect = container.querySelectorAll("select")[2];
    fireEvent.change(valSelect!, { target: { value: "" } });
    // Cleared value field — pivot uses count
    const text = container.textContent || "";
    expect(text).toContain("groups");
  });

  test("clicking SUM button changes aggregation", () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    const sumBtn = queryByText("SUM");
    fireEvent.click(sumBtn!);
    const text = container.textContent || "";
    // SUM aggregation should show in status footer
    expect(text).toContain("SUM aggregation");
  });

  test("clicking AVG button changes aggregation", () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    fireEvent.click(queryByText("AVG")!);
    expect(container.textContent).toContain("AVG aggregation");
  });

  test("clicking MIN button changes aggregation", () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    fireEvent.click(queryByText("MIN")!);
    expect(container.textContent).toContain("MIN aggregation");
  });

  test("clicking MAX button changes aggregation", () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    fireEvent.click(queryByText("MAX")!);
    expect(container.textContent).toContain("MAX aggregation");
  });

  test("Generate SQL button appears when onLoadQuery provided and row selected", () => {
    const onLoadQuery = mock(() => {});
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    expect(queryByText("Generate SQL")).not.toBeNull();
  });

  test("Generate SQL button not shown when onLoadQuery not provided", () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText("Generate SQL")).toBeNull();
  });

  /*
   * AND NOT ON AN ENGINE THAT CANNOT RUN SQL. Measured in a browser on OPC UA, whose request shape
   * is JSON: pressing it replaced the reader's own read request in the editor with a SELECT the
   * engine cannot parse, and the only way back was the undo stack. `undefined` means nobody has
   * said yet, and the control is drawn, which is what every engine did before this prop existed.
   */
  test("Generate SQL is withheld where the engine does not read SQL", () => {
    const onLoadQuery = mock(() => {});
    const json = render(<PivotTable result={result} onLoadQuery={onLoadQuery} offersGeneratedSql={false} />);
    expect(json.queryByText("Generate SQL")).toBeNull();
    json.unmount();

    const sql = render(<PivotTable result={result} onLoadQuery={onLoadQuery} offersGeneratedSql={true} />);
    expect(sql.queryByText("Generate SQL")).not.toBeNull();
    sql.unmount();

    const unknown = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    expect(unknown.queryByText("Generate SQL")).not.toBeNull();
  });

  test("clicking Generate SQL calls onLoadQuery with SQL", () => {
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    fireEvent.click(queryByText("Generate SQL")!);
    expect(onLoadQuery).toHaveBeenCalledTimes(1);
    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain("SELECT");
    expect(sql).toContain("GROUP BY");
    expect(sql).toContain("dept");
  });

  test("Generate SQL with column field uses CASE WHEN", () => {
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { container, queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    // Set column field
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    fireEvent.click(queryByText("Generate SQL")!);
    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain("CASE WHEN");
  });

  // A pivot column key is a VALUE read back from the result, so it carries
  // whatever the table holds and reaches the generated statement as a literal. The
  // SQL is loaded into the editor a click away from running (#290).

  test("Generate SQL quotes a column key for the dialect the result came from", () => {
    const hostile: QueryResult = {
      rows: [
        { dept: "Engineering", status: "a\\' OR 1=1 -- ", salary: 90000 },
        { dept: "Sales", status: "active", salary: 70000 },
      ],
      fields: ["dept", "status", "salary"],
      rowCount: 2,
      executionTime: 5,
    };
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { container, queryByText } = render(
      <PivotTable result={hostile} onLoadQuery={onLoadQuery} databaseType="mysql" />,
    );
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    fireEvent.click(queryByText("Generate SQL")!);

    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain("= 'a\\\\'' OR 1=1 -- '");
  });

  test("Generate SQL quotes the identifiers it builds from result data", () => {
    // The same key is also written as the column's ALIAS, and a field name is
    // whatever the query aliased it to. Both reach the statement as identifiers,
    // so a value carrying the closing quote character would end the quoted span
    // and leave the rest to be parsed as SQL (PR #304 review).
    const hostile: QueryResult = {
      rows: [
        { 'de"pt': "Engineering", status: 'a" , 1 AS x --', salary: 90000 },
        { 'de"pt': "Sales", status: "active", salary: 70000 },
      ],
      fields: ['de"pt', "status", "salary"],
      rowCount: 2,
      executionTime: 5,
    };
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { container, queryByText } = render(<PivotTable result={hostile} onLoadQuery={onLoadQuery} />);
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    fireEvent.click(queryByText("Generate SQL")!);

    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain('AS "a"" , 1 AS x --"');
    expect(sql).toContain('"de""pt"');
    // The `--` and the comma are inside the alias and the literal, and nowhere
    // else: each appears exactly as many times as the values that carry them.
    expect(sql.match(/--/g)).toHaveLength(2);
  });

  test("Generate SQL quotes identifiers the way the connected dialect spells them", () => {
    // MySQL does not read `"name"` as an identifier at all: without ANSI_QUOTES it
    // is a string literal, so a generated alias in that form is not just unsafe,
    // it is wrong.
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { container, queryByText } = render(
      <PivotTable result={result} onLoadQuery={onLoadQuery} databaseType="mysql" />,
    );
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    fireEvent.click(queryByText("Generate SQL")!);

    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain("`dept`");
    expect(sql).toContain("AS `active`");
    expect(sql).not.toContain('"');
  });

  test("Generate SQL emits the standard form when no dialect is known", () => {
    const withBackslash: QueryResult = {
      rows: [
        { dept: "Engineering", status: "C:\\Users", salary: 90000 },
        { dept: "Sales", status: "active", salary: 70000 },
      ],
      fields: ["dept", "status", "salary"],
      rowCount: 2,
      executionTime: 5,
    };
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { container, queryByText } = render(<PivotTable result={withBackslash} onLoadQuery={onLoadQuery} />);
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    fireEvent.click(queryByText("Generate SQL")!);

    expect(onLoadQuery.mock.calls[0][0]).toContain("= 'C:\\Users'");
  });

  test("status footer shows group and column counts", () => {
    const { container } = render(<PivotTable result={result} />);
    const text = container.textContent || "";
    // 2 groups (Engineering, Sales)
    expect(text).toContain("2 groups");
    // 1 column (__all__)
    expect(text).toContain("1 columns");
  });

  test("pivot table renders header with rowField name", () => {
    const { container } = render(<PivotTable result={result} />);
    const ths = container.querySelectorAll("th");
    expect(ths.length).toBeGreaterThan(0);
    expect(ths[0]?.textContent).toBe("dept");
  });

  test("pivot table renders row keys", () => {
    const { container } = render(<PivotTable result={result} />);
    const tds = container.querySelectorAll("td");
    const rowKeys = Array.from(tds)
      .filter((_, i) => i % 2 === 0)
      .map((td) => td.textContent);
    expect(rowKeys).toContain("Engineering");
    expect(rowKeys).toContain("Sales");
  });

  test("no auto-detect when fewer than 2 fields", () => {
    const single: QueryResult = {
      rows: [{ id: 1 }],
      fields: ["id"],
      rowCount: 1,
      executionTime: 1,
    };
    const { queryByText } = render(<PivotTable result={single} />);
    // Config bar should render but no auto-detection — shows "Select row and value fields" placeholder
    expect(queryByText("Select row and value fields to build pivot")).not.toBeNull();
  });

  test("clearing row field shows placeholder", () => {
    const { container, queryByText } = render(<PivotTable result={result} />);
    const rowSelect = container.querySelectorAll("select")[0];
    fireEvent.change(rowSelect!, { target: { value: "" } });
    expect(queryByText("Select row and value fields to build pivot")).not.toBeNull();
  });

  // --- New tests ---

  test("aggregate sum returns correct total", () => {
    // 90000 + 85000 + 70000 + 75000 = 320000
    expect(aggregate([90000, 85000, 70000, 75000], "sum")).toBe("320000.00");
    expect(aggregate([10, 20, 30], "sum")).toBe("60.00");
    expect(aggregate([0], "sum")).toBe("0.00");
  });

  test("aggregate avg returns correct average", () => {
    // (90000 + 85000 + 70000 + 75000) / 4 = 80000
    expect(aggregate([90000, 85000, 70000, 75000], "avg")).toBe("80000.00");
    expect(aggregate([10, 20, 30], "avg")).toBe("20.00");
    expect(aggregate([5], "avg")).toBe("5.00");
  });

  test("aggregate min and max return correct extremes", () => {
    const values = [90000, 85000, 70000, 75000];
    expect(aggregate(values, "min")).toBe("70000");
    expect(aggregate(values, "max")).toBe("90000");
    // Single value
    expect(aggregate([42], "min")).toBe("42");
    expect(aggregate([42], "max")).toBe("42");
  });

  test("aggregate with non-numeric values returns fallback", () => {
    // All non-numeric: sum=0, avg=0, min/max='-'
    const nonNumeric = ["hello", "world", undefined];
    expect(aggregate(nonNumeric, "sum")).toBe("0");
    expect(aggregate(nonNumeric, "avg")).toBe("0");
    expect(aggregate(nonNumeric, "min")).toBe("-");
    expect(aggregate(nonNumeric, "max")).toBe("-");
    // count still counts all values
    expect(aggregate(nonNumeric, "count")).toBe("3");
  });

  test("generateSQL with colField produces CASE WHEN for each column value", () => {
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { container, queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    // Set column field to 'status'
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    // Click SUM so aggregation is SUM
    fireEvent.click(queryByText("SUM")!);
    fireEvent.click(queryByText("Generate SQL")!);
    const sql: string = onLoadQuery.mock.calls[0][0];
    // Should have CASE WHEN for both 'active' and 'inactive' column values
    expect(sql).toContain("CASE WHEN \"status\" = 'active'");
    expect(sql).toContain("CASE WHEN \"status\" = 'inactive'");
    expect(sql).toContain("SUM(CASE WHEN");
    expect(sql).toContain('"salary"');
    expect(sql).toContain("GROUP BY");
  });

  test("onLoadQuery callback receives full SQL when Generate SQL clicked", () => {
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    fireEvent.click(queryByText("Generate SQL")!);
    expect(onLoadQuery).toHaveBeenCalledTimes(1);
    const sql: string = onLoadQuery.mock.calls[0][0];
    // Should be valid SQL structure
    expect(sql).toMatch(/^SELECT\n/);
    expect(sql).toContain("FROM your_table");
    expect(sql).toContain("GROUP BY");
    expect(sql).toContain("ORDER BY");
    expect(sql.endsWith(";")).toBe(true);
  });

  test('NULL values in row field are grouped under "NULL" key', () => {
    const nullResult: QueryResult = {
      rows: [
        { dept: null, salary: 100 },
        { dept: null, salary: 200 },
        { dept: "Sales", salary: 300 },
      ],
      fields: ["dept", "salary"],
      rowCount: 3,
      executionTime: 1,
    };
    const { container } = render(<PivotTable result={nullResult} />);
    // Auto-detect won't pick dept (first row sample is null, not string),
    // so manually set rowField via the select dropdown
    const rowSelect = container.querySelectorAll("select")[0];
    fireEvent.change(rowSelect!, { target: { value: "dept" } });
    const tds = container.querySelectorAll("td");
    const cellTexts = Array.from(tds).map((td) => td.textContent);
    // Null values should be represented as 'NULL' row key
    expect(cellTexts).toContain("NULL");
  });

  test("status bar shows correct group, column, and aggregation counts", () => {
    const { container, queryByText } = render(<PivotTable result={result} />);
    // Default: 2 groups (Engineering, Sales), 1 column (__all__), COUNT aggregation
    const text = container.textContent || "";
    expect(text).toContain("2 groups");
    expect(text).toContain("1 columns");
    expect(text).toContain("COUNT aggregation");

    // Set column field to 'status' — should show 2 columns (active, inactive)
    const colSelect = container.querySelectorAll("select")[1];
    fireEvent.change(colSelect!, { target: { value: "status" } });
    const updatedText = container.textContent || "";
    expect(updatedText).toContain("2 groups");
    expect(updatedText).toContain("2 columns");

    // Switch aggregation to AVG
    fireEvent.click(queryByText("AVG")!);
    expect(container.textContent).toContain("AVG aggregation");
  });

  test("switching aggregation function updates displayed values", () => {
    const { container, queryByText } = render(<PivotTable result={result} />);
    // Default is COUNT — Engineering has 2 rows, Sales has 2 rows
    const getValueCells = () =>
      Array.from(container.querySelectorAll("td"))
        .filter((_, i) => i % 2 === 1)
        .map((td) => td.textContent);

    let values = getValueCells();
    // COUNT: Engineering=2, Sales=2
    expect(values).toContain("2");

    // Switch to SUM
    fireEvent.click(queryByText("SUM")!);
    values = getValueCells();
    // SUM: Engineering = 90000+85000=175000.00, Sales = 70000+75000=145000.00
    expect(values).toContain("175000.00");
    expect(values).toContain("145000.00");

    // Switch to AVG
    fireEvent.click(queryByText("AVG")!);
    values = getValueCells();
    // AVG: Engineering = 87500.00, Sales = 72500.00
    expect(values).toContain("87500.00");
    expect(values).toContain("72500.00");
  });

  test("generateSQL without colField produces simple aggregation", () => {
    const onLoadQuery = mock((sql: string) => {
      void sql;
    });
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    // Default: no colField set, auto-detected rowField=dept, valueField=salary, aggFunction=count
    fireEvent.click(queryByText("Generate SQL")!);
    const sql: string = onLoadQuery.mock.calls[0][0];
    // Should NOT contain CASE WHEN
    expect(sql).not.toContain("CASE WHEN");
    // Should have simple aggregation like COUNT("salary") AS "count_value"
    expect(sql).toContain('COUNT("salary") AS "count_value"');
    expect(sql).toContain('"dept"');
    expect(sql).toContain('GROUP BY "dept"');
    expect(sql).toContain('ORDER BY "dept"');
  });
});

describe("display masking (#1939)", () => {
  const emailPattern = DEFAULT_MASKING_CONFIG.patterns.find((p) => p.id === "builtin-email")!;
  const maskEmail = (value: unknown) => maskValueByPattern(value, emailPattern);
  const ssnPattern = DEFAULT_MASKING_CONFIG.patterns.find((p) => p.id === "builtin-ssn")!;
  const maskSsn = (value: unknown) => maskValueByPattern(value, ssnPattern);
  const maskingProps = {
    maskingEnabled: true,
    userRole: "admin",
    maskingConfig: DEFAULT_MASKING_CONFIG,
  };

  // alice@example.com and al123@example.com mask to the SAME text, so a pivot grouped
  // by the masked value would merge them into one group of three. The null row keeps the
  // grid's "NULL" label rather than a mask of the text "NULL".
  const emailResult: QueryResult = {
    rows: [
      { email: "alice@example.com", dept: "Engineering", salary: 90000 },
      { email: "alice@example.com", dept: "Sales", salary: 70000 },
      { email: "al123@example.com", dept: "Sales", salary: 75000 },
      { email: null, dept: "Sales", salary: 60000 },
    ],
    fields: ["email", "dept", "salary"],
    rowCount: 4,
    executionTime: 1,
  };

  test("masks the row field's values, and still groups by the raw ones", () => {
    const { container } = render(<PivotTable result={emailResult} {...maskingProps} />);
    const text = container.textContent || "";
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("al123@example.com");
    expect(text).toContain(maskEmail("alice@example.com"));

    // Three groups survive with their own counts: one row per raw value, not one merged
    // masked row, and the null group keeps the grid's "NULL" rather than a fake mask.
    // Masked-label order (#1491): the two groups sharing one mask come first in
    // first-seen order (alice's 2 before al123's 1), and "NULL" sorts after the mask text.
    const bodyRows = container.querySelectorAll("tbody tr");
    expect(bodyRows.length).toBe(3);
    expect(bodyRows[0]?.textContent).toContain("2");
    expect(bodyRows[1]?.textContent).toContain("1");
    expect(bodyRows[2]?.textContent).toContain("NULL");
    expect(bodyRows[2]?.textContent).not.toContain("@");
  });

  test("masks the column field's values", () => {
    const { container } = render(<PivotTable result={emailResult} {...maskingProps} />);
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0]!, { target: { value: "dept" } });
    fireEvent.change(selects[1]!, { target: { value: "email" } });

    const head = container.querySelector("thead")?.textContent || "";
    expect(head).not.toContain("alice@example.com");
    expect(head).toContain(maskEmail("alice@example.com"));
    expect(container.textContent).not.toContain("al123@example.com");
  });

  test("keeps groups whose masks collide as separate download columns", () => {
    const { container, getByText } = render(<PivotTable result={emailResult} {...maskingProps} />);
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0]!, { target: { value: "dept" } });
    fireEvent.change(selects[1]!, { target: { value: "email" } });

    fireEvent.click(getByText("Export as CSV"));
    fireEvent.click(getByText("Export as JSON"));

    const calls = mockDownloadText.mock.calls;
    const csv = calls[calls.length - 2][0] as string;
    const mask = maskEmail("alice@example.com");
    // The CSV header row carries the same disambiguated names, and no raw key.
    const headerLine = csv.split("\n")[0];
    expect(headerLine).toBe(`dept,${mask},${mask} (2),NULL`);
    expect(csv).not.toContain("alice@example.com");
    expect(csv).not.toContain("al123@example.com");

    const json = JSON.parse(calls[calls.length - 1][0] as string) as Record<string, unknown>[];
    // al123@example.com masks to the same text; the second column takes the result's own
    // "name (2)" spelling instead of overwriting the first group's column. The shared
    // mask sorts the columns, and the first-seen tie puts alice's group first (#1491).
    expect(json).toEqual([
      { dept: "Engineering", [mask]: "1", [`${mask} (2)`]: "0", NULL: "0" },
      { dept: "Sales", [mask]: "1", [`${mask} (2)`]: "1", NULL: "1" },
    ]);
  });

  test("masks the CSV and JSON download", () => {
    const { getByText } = render(<PivotTable result={emailResult} {...maskingProps} />);

    fireEvent.click(getByText("Export as CSV"));
    fireEvent.click(getByText("Export as JSON"));

    const calls = mockDownloadText.mock.calls;
    const csv = calls[calls.length - 2][0] as string;
    expect(csv).toContain(maskEmail("alice@example.com"));
    expect(csv).not.toContain("alice@example.com");
    expect(csv).not.toContain("al123@example.com");

    const json = JSON.parse(calls[calls.length - 1][0] as string) as Record<string, unknown>[];
    // Masked-label order (#1491): alice's group first (first-seen tie on the shared
    // mask), then al123's, then "NULL".
    expect(json).toEqual([
      { email: maskEmail("alice@example.com"), "COUNT(*)": "2" },
      { email: maskEmail("al123@example.com"), "COUNT(*)": "1" },
      { email: "NULL", "COUNT(*)": "1" },
    ]);
  });

  test("withholds Generate SQL while a masked column would supply its literals", () => {
    const onLoadQuery = mock(() => {});
    const { container, queryByText, getByText } = render(
      <PivotTable result={emailResult} onLoadQuery={onLoadQuery} {...maskingProps} />,
    );

    // A masked ROW field reaches the statement only as an identifier, so the control stays.
    expect(getByText("Generate SQL")).not.toBeNull();

    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0]!, { target: { value: "dept" } });
    fireEvent.change(selects[1]!, { target: { value: "email" } });
    expect(queryByText("Generate SQL")).toBeNull();

    // An unmasked column field keeps it.
    fireEvent.change(selects[1]!, { target: { value: "" } });
    expect(queryByText("Generate SQL")).not.toBeNull();
  });

  test("does not offer a masked column as the pivot value", () => {
    const { container } = render(<PivotTable result={emailResult} {...maskingProps} />);
    const valueSelect = container.querySelectorAll("select")[2]!;
    const options = [...valueSelect.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(options).not.toContain("salary");
    expect(options).toContain("dept");
    // salary is the only numeric column, so nothing is auto-picked and the pivot counts.
    expect(valueSelect.value).toBe("");
  });

  test("respects the provider's masking exemptions", () => {
    const { container } = render(
      <PivotTable
        result={emailResult}
        {...maskingProps}
        maskingExemptColumns={{ column: "^email$", reason: "the engine's key" }}
      />,
    );
    expect(container.textContent).toContain("alice@example.com");
  });

  test("shows raw values while masking is off", () => {
    const { container } = render(<PivotTable result={emailResult} />);
    expect(container.textContent).toContain("alice@example.com");
  });

  test("shows raw keys while masking is off, config still handed in", () => {
    // maskingEnabled: false wins over the config: the keys read in the clear even
    // though a config is present. This pins existing behavior.
    const { container } = render(
      <PivotTable
        result={emailResult}
        maskingEnabled={false}
        userRole="admin"
        maskingConfig={DEFAULT_MASKING_CONFIG}
      />,
    );
    expect(container.textContent).toContain("alice@example.com");
    expect(container.textContent).toContain("al123@example.com");
  });

  // The pivot used to order its keys by the RAW value, so 900-11-0001, 100-22-0002 and
  // 500-33-0003 read 0002, 0003, 0001: the rank of the hidden prefixes leaks. The grid
  // has sorted masked fields by their masked label since #1491; the pivot and its
  // download do the same now, ties in first-seen order (#1939, PR #1957 review).
  const ssnResult: QueryResult = {
    rows: [
      { ssn: "900-11-0001", logins: 3 },
      { ssn: "100-22-0002", logins: 1 },
      { ssn: "500-33-0003", logins: 2 },
    ],
    fields: ["ssn", "logins"],
    rowCount: 3,
    executionTime: 1,
  };

  test("sorts masked row keys by their masked label, on screen and in the CSV", () => {
    const { container, getByText } = render(<PivotTable result={ssnResult} {...maskingProps} />);
    fireEvent.click(getByText("SUM"));

    const bodyRows = [...container.querySelectorAll("tbody tr")];
    expect(bodyRows.map((tr) => tr.querySelector("td")?.textContent)).toEqual([
      maskSsn("900-11-0001"),
      maskSsn("100-22-0002"),
      maskSsn("500-33-0003"),
    ]);
    // The aggregates ride with their group, so the order is provable beyond the labels.
    expect(bodyRows.map((tr) => tr.querySelectorAll("td")[1]?.textContent)).toEqual(["3.00", "1.00", "2.00"]);

    fireEvent.click(getByText("Export as CSV"));
    const csv = mockDownloadText.mock.calls.at(-1)![0] as string;
    const dataLines = csv.split("\n").slice(1);
    expect(dataLines.map((line) => line.split(",")[0])).toEqual([
      maskSsn("900-11-0001"),
      maskSsn("100-22-0002"),
      maskSsn("500-33-0003"),
    ]);
    expect(dataLines.map((line) => line.split(",")[1])).toEqual(["3.00", "1.00", "2.00"]);
    // And no raw key anywhere in the download.
    expect(csv).not.toContain("900-11-0001");
    expect(csv).not.toContain("100-22-0002");
    expect(csv).not.toContain("500-33-0003");
  });

  const ssnColumnResult: QueryResult = {
    rows: [
      { dept: "Engineering", ssn: "900-11-0001", logins: 3 },
      { dept: "Engineering", ssn: "100-22-0002", logins: 1 },
      { dept: "Sales", ssn: "500-33-0003", logins: 2 },
    ],
    fields: ["dept", "ssn", "logins"],
    rowCount: 3,
    executionTime: 1,
  };

  test("sorts masked column keys by their masked label, in the header and the CSV", () => {
    const { container, getByText } = render(<PivotTable result={ssnColumnResult} {...maskingProps} />);
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0]!, { target: { value: "dept" } });
    fireEvent.change(selects[1]!, { target: { value: "ssn" } });

    expect([...container.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
      "dept",
      maskSsn("900-11-0001"),
      maskSsn("100-22-0002"),
      maskSsn("500-33-0003"),
    ]);

    fireEvent.click(getByText("Export as CSV"));
    const csv = mockDownloadText.mock.calls.at(-1)![0] as string;
    expect(csv.split("\n")[0]).toBe(
      ["dept", maskSsn("900-11-0001"), maskSsn("100-22-0002"), maskSsn("500-33-0003")].join(","),
    );
    expect(csv).not.toContain("900-11-0001");
    expect(csv).not.toContain("100-22-0002");
    expect(csv).not.toContain("500-33-0003");
  });

  // Two raw values whose masks are identical cannot be ordered by their labels; the
  // stable sort keeps first-seen order, and the DIFFERENT aggregates prove which raw
  // group landed where — the labels alone could not.
  const ssnTieResult: QueryResult = {
    rows: [
      { ssn: "900-11-0001", logins: 5 },
      { ssn: "100-22-0001", logins: 2 },
    ],
    fields: ["ssn", "logins"],
    rowCount: 2,
    executionTime: 1,
  };

  test("keeps first-seen order when two masked labels tie", () => {
    const { container, getByText } = render(<PivotTable result={ssnTieResult} {...maskingProps} />);
    fireEvent.click(getByText("SUM"));

    const bodyRows = [...container.querySelectorAll("tbody tr")];
    expect(bodyRows.map((tr) => tr.querySelector("td")?.textContent)).toEqual([
      maskSsn("900-11-0001"),
      maskSsn("100-22-0001"),
    ]);
    expect(bodyRows.map((tr) => tr.querySelectorAll("td")[1]?.textContent)).toEqual(["5.00", "2.00"]);

    fireEvent.click(getByText("Export as CSV"));
    const csv = mockDownloadText.mock.calls.at(-1)![0] as string;
    expect(
      csv
        .split("\n")
        .slice(1)
        .map((line) => line.split(",")[1]),
    ).toEqual(["5.00", "2.00"]);
  });
});
