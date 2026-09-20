/**
 * Whether a statement's OWN result is ordered.
 *
 * The grid asks this to decide whether to state, once, that order across pages is not
 * guaranteed (#816). Studio will not inject, require or suggest an `ORDER BY` to make
 * pagination work — on a table of millions of rows a sort can be fatal and paying for it
 * is the user's call — so an unordered query paginates like any other, and the only thing
 * owed to the reader is that it does not pretend to be the ordered case.
 *
 * A regex is the wrong instrument here for the reason this folder has now recorded five
 * times over (#275, #280, #287, #292, #294): `/\bORDER\s+BY\b/i` matches text the
 * statement merely CONTAINS. Every one of these is a false positive, and each would
 * silence a notice that ought to show:
 *
 *   SELECT * FROM t WHERE note = 'ORDER BY id'     -- inside a literal
 *   SELECT * FROM t -- ORDER BY id                 -- inside a comment
 *   SELECT * FROM "ORDER BY id"                    -- a quoted identifier
 *   SELECT * FROM (SELECT id FROM t ORDER BY id) s -- an inner sort, discarded above it
 *   SELECT row_number() OVER (ORDER BY a) FROM t   -- a window's sort, not the result's
 *
 * So this walks the statement the way `query-limiter.ts` and `operative-keyword.ts` do:
 * `readSqlSpan` for the runs that are not code, `readSqlWord` for the words that are, and
 * a paren depth so only an ordering at the OUTER level counts. The grammar comes from the
 * connection's dialect, because which runs are not code is the dialect's answer for `#`
 * and for `[…]` (#292).
 */

import type { DatabaseType } from "@/lib/types";
import { resolveSqlGrammar } from "./grammar";
import { readSqlSpan } from "./spans";
import { readSqlWord } from "./words";

export function hasResultOrder(sql: string, type?: DatabaseType): boolean {
  const grammar = resolveSqlGrammar(type);
  let depth = 0;
  /**
   * True when the previous CODE word was an outer-level `ORDER`.
   *
   * The depth is checked when this is SET, not when `BY` is read, and that is the only
   * place it can be checked: the two words are only a pair when nothing but trivia sits
   * between them, and a paren between them clears the flag on its own.
   */
  let sawOrder = false;
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, grammar);
    if (span !== null) {
      // Trivia may sit between `ORDER` and `BY` — a newline, or a comment written
      // between the two words — so only a span that is part of the statement's own text
      // breaks the pair.
      if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") {
        sawOrder = false;
      }
      i = span.end;
      continue;
    }

    const word = readSqlWord(sql, i);
    if (word !== null) {
      if (sawOrder && word.text === "BY") return true;
      sawOrder = depth === 0 && word.text === "ORDER";
      i = word.end;
      continue;
    }

    if (sql[i] === "(") depth++;
    // Clamped at zero: an unbalanced `)` in a statement the user is still typing would
    // otherwise drive the depth negative and read the next subquery's ordering as the
    // result's own, which is the one direction that puts a false reassurance on screen.
    if (sql[i] === ")" && depth > 0) depth--;
    sawOrder = false;
    i++;
  }

  return false;
}
