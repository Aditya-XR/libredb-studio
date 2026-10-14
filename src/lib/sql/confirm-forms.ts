/**
 * Where a dialect's own confirmation forms (`SqlGrammar.confirmForms` and `confirmCodeForms`) are found in a
 * statement's code.
 *
 * The confirmation gate (`isDangerousQuery`) reads them, and so does an EXPLAIN strategy that must never send a
 * statement the gate would ask about: Snowflake's compiler evaluates a `SYSTEM$` function while it explains the
 * statement (SF-001), so its strategy declines whatever these forms find. One reading for both, so the gate and the
 * strategy cannot drift apart.
 */

import type { ConfirmCodeForm, ConfirmFormWhen, SqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { findCodeWord, readSqlWord } from "@/lib/sql/words";

/** The code word after `from`, past whitespace and comments, or `null` when the next code is not a word. */
function nextCodeWord(text: string, from: number, grammar: SqlGrammar): { word: string; end: number } | null {
  let i = from;
  for (;;) {
    const span = readSqlSpan(text, i, grammar);
    if (
      span === null ||
      (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment")
    ) {
      break;
    }
    i = span.end;
  }
  const found = readSqlWord(text, i);
  return found === null ? null : { word: found.text, end: found.end };
}

/** Whether the code words after `from` are `words`, in order. */
export function wordsFollow(text: string, from: number, words: readonly string[], grammar: SqlGrammar): boolean {
  let at = from;
  for (const expected of words) {
    const next = nextCodeWord(text, at, grammar);
    if (next === null || next.word !== expected.toUpperCase()) return false;
    at = next.end;
  }
  return true;
}

/** Whether the word sequence `form` appears anywhere in the code of `text`. */
export function sequenceInCode(text: string, form: readonly string[], grammar: SqlGrammar): boolean {
  let found = findCodeWord(text, form[0], 0, grammar);
  while (found !== null) {
    if (wordsFollow(text, found.end, form.slice(1), grammar)) return true;
    found = findCodeWord(text, form[0], found.end, grammar);
  }
  return false;
}

/** Whether the next code after `from`, past whitespace and comments, is `(`. */
function callFollows(text: string, from: number, grammar: SqlGrammar): boolean {
  let i = from;
  for (let span = readSqlSpan(text, i, grammar); span !== null; span = readSqlSpan(text, i, grammar)) {
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return false;
    i = span.end;
  }
  return text[i] === "(";
}

/**
 * Whether a code word of `text` starts with `prefix`, compared case-insensitively, or a quoted name called as a
 * function does, compared exactly: a quoted upper-case name resolves as the bare one, and a quoted name is
 * case-sensitive, so `"SYSTEM$WAIT"(10)` is the bare call and `"system$wait"(10)` is another function.
 */
function prefixInCode(text: string, prefix: string, grammar: SqlGrammar): boolean {
  const target = prefix.toUpperCase();
  let i = 0;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span !== null) {
      if (
        span.kind === "quoted-identifier" &&
        span.terminated &&
        text.slice(i + 1, span.end - 1).startsWith(target) &&
        callFollows(text, span.end, grammar)
      ) {
        return true;
      }
      i = span.end;
      continue;
    }
    const found = readSqlWord(text, i);
    if (found === null) {
      i++;
      continue;
    }
    if (found.text.startsWith(target)) return true;
    i = found.end;
  }
  return false;
}

/**
 * Whether the next code after `from`, past whitespace and comments, opens a string literal: a `string` span (a raw
 * string included) or a run opened by `"`, which Spark reads as a string unless two ANSI settings are both on. A
 * dollar-quoted run, a backtick name, a `(` or a word does not count.
 */
function literalFollows(text: string, from: number, grammar: SqlGrammar): boolean {
  let i = from;
  for (let span = readSqlSpan(text, i, grammar); span !== null; span = readSqlSpan(text, i, grammar)) {
    if (span.kind === "string") return true;
    if (span.kind === "quoted-identifier") return text[i] === '"';
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return false;
    i = span.end;
  }
  return false;
}

/**
 * Whether the next code after `from`, past whitespace and comments, opens a routine body: a string literal or a
 * dollar-quoted run, the two forms PostgreSQL takes a `DO` block's code in. A word, a quoted name or a `(` does not.
 */
function bodyFollows(text: string, from: number, grammar: SqlGrammar): boolean {
  let i = from;
  for (let span = readSqlSpan(text, i, grammar); span !== null; span = readSqlSpan(text, i, grammar)) {
    if (span.kind === "string" || span.kind === "dollar-string") return true;
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return false;
    i = span.end;
  }
  return false;
}

/** Whether a code occurrence of `word` is followed by what `follows` looks for (`literalFollows`, `bodyFollows`). */
function wordThenInCode(
  text: string,
  word: string,
  follows: (text: string, from: number, grammar: SqlGrammar) => boolean,
  grammar: SqlGrammar,
): boolean {
  let found = findCodeWord(text, word, 0, grammar);
  while (found !== null) {
    if (follows(text, found.end, grammar)) return true;
    found = findCodeWord(text, word, found.end, grammar);
  }
  return false;
}

/**
 * Whether a closed quoted name whose text is `name`, compared without case, is called: a `(` follows it past
 * whitespace and comments. Spark resolves a function name without case, quoted or not, so `` `Reflect`(1) `` calls
 * `reflect`.
 */
function quotedCallInCode(text: string, name: string, grammar: SqlGrammar): boolean {
  const target = name.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span === null) {
      i = readSqlWord(text, i)?.end ?? i + 1;
      continue;
    }
    if (
      span.kind === "quoted-identifier" &&
      span.terminated &&
      text.slice(i + 1, span.end - 1).toLowerCase() === target &&
      callFollows(text, span.end, grammar)
    ) {
      return true;
    }
    i = span.end;
  }
  return false;
}

/**
 * The index past the parenthesised run that opens at the next code after `from`, past whitespace and comments, or -1
 * when that code is not a `(` or the run never closes. Literals, quoted names and comments inside it are read whole,
 * so a `)` written in one closes nothing.
 */
function pastParenthesised(text: string, from: number, grammar: SqlGrammar): number {
  if (!callFollows(text, from, grammar)) return -1;
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span !== null) {
      i = span.end;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/**
 * Whether a code occurrence of `word` is followed, past whitespace and comments, by a parenthesised run and then a `(`:
 * a call whose function name the run computes, as Spark's `IDENTIFIER('f')(1)` is, which the gate cannot read.
 */
function computedCallInCode(text: string, word: string, grammar: SqlGrammar): boolean {
  let found = findCodeWord(text, word, 0, grammar);
  while (found !== null) {
    const end = pastParenthesised(text, found.end, grammar);
    if (end !== -1 && callFollows(text, end, grammar)) return true;
    found = findCodeWord(text, word, found.end, grammar);
  }
  return false;
}

/**
 * Whether a dollar-quoted run (`$$...$$`, `$tag$...$tag$`) opens at a code position of `text`, the span reader asked at
 * each character as `hasUnterminatedSpan` asks it: Spark's names hold no `$`, so a `$$` right after a name's letters
 * opens a run there too. A run that never closes counts as well.
 */
function dollarQuotedInCode(text: string, grammar: SqlGrammar): boolean {
  let i = 0;
  while (i < text.length) {
    const span = readSqlSpan(text, i, grammar);
    if (span === null) i++;
    else if (span.kind === "dollar-string") return true;
    else i = span.end;
  }
  return false;
}

function codeFormInText(text: string, form: ConfirmCodeForm, grammar: SqlGrammar): boolean {
  if ("prefix" in form) return prefixInCode(text, form.prefix, grammar);
  if ("wordThenLiteral" in form) return wordThenInCode(text, form.wordThenLiteral, literalFollows, grammar);
  if ("wordThenBody" in form) return wordThenInCode(text, form.wordThenBody, bodyFollows, grammar);
  if ("quotedCall" in form) return quotedCallInCode(text, form.quotedCall, grammar);
  if ("computedCall" in form) return computedCallInCode(text, form.computedCall, grammar);
  if ("dollarQuoted" in form) return dollarQuotedInCode(text, grammar);
  return sequenceInCode(text, form, grammar);
}

/** Whether any of `grammar`'s `confirmCodeForms` appears in the code of `text`; a grammar without them has none. */
export function hasConfirmCodeForm(text: string, grammar: SqlGrammar): boolean {
  return (grammar.confirmCodeForms ?? []).some((form) => codeFormInText(text, form, grammar));
}

/**
 * Whether a `confirmFormsWhen` form operates the statement whose operative keyword `keyword` ends at `end`: its words
 * follow there and its `when` word appears in the code after them.
 */
export function conditionalFormOperates(
  text: string,
  keyword: string,
  end: number,
  form: ConfirmFormWhen,
  grammar: SqlGrammar,
): boolean {
  return (
    form.form[0].toUpperCase() === keyword &&
    wordsFollow(text, end, form.form.slice(1), grammar) &&
    findCodeWord(text, form.when, end, grammar) !== null
  );
}

/** Whether a `confirmFormsWhen` form appears anywhere in the code of `text` with its `when` word after it. */
export function conditionalFormInCode(text: string, form: ConfirmFormWhen, grammar: SqlGrammar): boolean {
  let found = findCodeWord(text, form.form[0], 0, grammar);
  while (found !== null) {
    if (conditionalFormOperates(text, form.form[0].toUpperCase(), found.end, form, grammar)) return true;
    found = findCodeWord(text, form.form[0], found.end, grammar);
  }
  return false;
}
