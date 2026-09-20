import { describe, test, expect } from "bun:test";
import { hasResultOrder } from "@/lib/sql/result-order";

/**
 * Whether a statement's OWN result is ordered (#816).
 *
 * The grid asks this to decide whether to say that order across pages is not
 * guaranteed. A wrong answer either way is a lie to the user, so this is a scanner over
 * the shared span and word readers rather than an `/\bORDER\s+BY\b/i`: that pattern sees
 * an `ORDER BY` inside a string, a comment, a quoted identifier, a subquery, a CTE body
 * and a window function's `OVER (…)`, none of which order the result the user is paging.
 */
describe("hasResultOrder", () => {
  test.each([
    ["a plain trailing ORDER BY", "SELECT * FROM t ORDER BY id"],
    ["a lower-case one", "select * from t order by id"],
    ["an ordering with a direction", "SELECT * FROM t ORDER BY created_at DESC"],
    ["several keys", "SELECT * FROM t ORDER BY a, b DESC"],
    ["an ordering with a trailing bound after it", "SELECT * FROM t ORDER BY id LIMIT 10"],
    ["an outer ordering after a subquery in the FROM", "SELECT * FROM (SELECT id FROM t) s ORDER BY s.id"],
    ["an outer ordering after a subquery in the WHERE", "SELECT * FROM t WHERE id IN (SELECT id FROM u) ORDER BY id"],
    ["an outer ordering after a CTE", "WITH c AS (SELECT id FROM t) SELECT * FROM c ORDER BY id"],
    ["an outer ordering after a window function", "SELECT row_number() OVER (ORDER BY a) rn FROM t ORDER BY rn"],
    ["an ordering split over lines", "SELECT *\nFROM t\nORDER\n  BY id"],
    ["an ordering with a comment between the words", "SELECT * FROM t ORDER /* key */ BY id"],
  ])("sees %s", (_label, sql) => {
    expect(hasResultOrder(sql)).toBe(true);
  });

  test.each([
    ["no ordering at all", "SELECT * FROM t"],
    ["an ordering inside a string literal", "SELECT * FROM t WHERE note = 'ORDER BY id'"],
    ["an ordering inside a line comment", "SELECT * FROM t -- ORDER BY id"],
    ["an ordering inside a block comment", "SELECT * FROM t /* ORDER BY id */"],
    ["an ordering inside a quoted identifier", 'SELECT * FROM "ORDER BY id"'],
    ["an ordering inside a subquery only", "SELECT * FROM (SELECT id FROM t ORDER BY id) s"],
    ["an ordering inside a CTE body only", "WITH c AS (SELECT id FROM t ORDER BY id) SELECT * FROM c"],
    ["a window function's ordering only", "SELECT row_number() OVER (ORDER BY a) rn FROM t"],
    ["the word ORDER as a column name", "SELECT order FROM t"],
    ["the word ORDER as a table name", "SELECT * FROM orders"],
    ["ORDER not followed by BY", "SELECT * FROM t GROUP BY id"],
    ["a GROUP BY, which does not order the result", "SELECT id FROM t GROUP BY id"],
  ])("does not see %s", (_label, sql) => {
    expect(hasResultOrder(sql)).toBe(false);
  });

  /**
   * WHICH runs are not code is the dialect's answer, exactly as it is for every other
   * reader in this folder (#292). `#` opens a comment in MySQL and is an ordinary
   * character in PostgreSQL, and `[…]` is a quoted identifier in T-SQL and a subscript
   * elsewhere — so the same text has two right answers and only the grammar says which.
   */
  test("reads a MySQL hash comment as a comment", () => {
    expect(hasResultOrder("SELECT * FROM t # ORDER BY id", "mysql")).toBe(false);
    expect(hasResultOrder("SELECT * FROM t # ORDER BY id", "postgres")).toBe(true);
  });

  test("reads a T-SQL bracketed identifier as an identifier", () => {
    expect(hasResultOrder("SELECT * FROM [ORDER BY id]", "mssql")).toBe(false);
  });

  /**
   * An unbalanced closing paren must not drive the depth negative and then read an inner
   * ordering as an outer one. The statement is broken either way; answering "ordered"
   * for it would put a false reassurance on the screen.
   */
  test("an unbalanced closing paren does not promote an inner ordering", () => {
    expect(hasResultOrder("SELECT * FROM (SELECT id FROM t)) s ORDER BY s.id")).toBe(true);
    expect(hasResultOrder("SELECT * FROM t) WHERE (id IN (SELECT id FROM u ORDER BY id)")).toBe(false);
  });

  test("an empty statement is not ordered", () => {
    expect(hasResultOrder("")).toBe(false);
  });
});
