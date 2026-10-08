import { describe, expect, test } from "bun:test";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";

// The proof obligation of the Databend provider's escaping: for every input, the
// shared helpers under "databend" produce exactly one token of Databend's own lexer
// rule, and Databend's unescape of that token is the input again. The reference
// tokenizer is the lexer's regex itself: a string literal is `'([^'\\]|\\.|'')*'`
// (token.rs), where `.` excludes only a line feed. The JavaScript `.` without the `s`
// flag also excludes a carriage return, U+2028 and U+2029, so this reference is
// stricter, which is safe because a correct literal never puts a backslash before any
// of them. A quoted identifier is a backtick span whose only escape is a doubled
// backtick. A backslash has no meaning inside the backtick rule.

const LITERAL_TOKEN = /^'([^'\\]|\\.|'')*'$/;
const IDENTIFIER_TOKEN = /^`([^`]|``)*`$/;

// What Databend's unescape (quote.rs) makes of a backslash pair. Only the pairs a
// correct literal could contain are listed; anything else throws, so a quoting change
// that started emitting a new escape fails here instead of being decoded by a guess.
const BACKSLASH_PAIRS: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
};

/** Databend's reading of one literal token, written from the lexer rule above. */
function unescapeLiteral(token: string): string {
  if (!LITERAL_TOKEN.test(token)) throw new Error(`not one literal token: ${JSON.stringify(token)}`);
  const body = token.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      const next = body[++i];
      const decoded = BACKSLASH_PAIRS[next];
      if (decoded === undefined) throw new Error(`unexpected escape \\${next}`);
      out += decoded;
    } else if (ch === "'") {
      // The token regex admits a quote inside the body only as a doubled pair.
      out += "'";
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Databend's reading of one backtick identifier token. */
function unescapeIdentifier(token: string): string {
  if (!IDENTIFIER_TOKEN.test(token)) throw new Error(`not one identifier token: ${JSON.stringify(token)}`);
  return token.slice(1, -1).replace(/``/g, "`");
}

// mulberry32: a small seeded PRNG, so a failure names a reproducible input.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The characters every escaping rule here turns on, drawn more often than chance
// would draw them from the whole code-unit range.
const SPECIALS = ["'", "\\", "`", '"', "\n", "\r", "\u0000", " ", ";", "-", "/", "*", "$", "%", "_", " "];

function generate(seed: number, count: number): string[] {
  const random = mulberry32(seed);
  const values: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = Math.floor(random() * 24);
    let value = "";
    for (let i = 0; i < length; i++) {
      value +=
        random() < 0.5
          ? SPECIALS[Math.floor(random() * SPECIALS.length)]
          : String.fromCharCode(Math.floor(random() * 0x10000));
    }
    values.push(value);
  }
  return values;
}

// The C15 identifier corpus and the C16 value corpus of the security review, plus the
// L4 probe's values: every one of these was round-tripped live on the pinned image.
const CORPUS = [
  "a`b",
  "x\\",
  "x\\\\",
  'a"b',
  "a'b",
  "a;b",
  "a--b",
  "a/*b",
  "$$",
  "a b",
  "a\nb",
  "a\u0000b",
  "表名",
  "n".repeat(255),
  "MixedCase",
  "a\\",
  "\\'",
  "\\x41",
  "\\u0041",
  "%_",
  "''",
  "plain",
  "\\",
  "'",
  "",
];

const GENERATED = generate(20261008, 10_000);

describe("Databend quoting under the shared helpers", () => {
  test("doubles a backtick inside an identifier and adds no backslash escape", () => {
    expect(quoteIdentifier("a`b", "databend")).toBe("`a``b`");
    expect(quoteIdentifier("x\\", "databend")).toBe("`x\\`");
  });

  test("quotes a mixed-case name, which Databend would fold if it were bare", () => {
    expect(quoteIdentifier("MyTable", "databend")).toBe("`MyTable`");
  });

  test("writes a literal with the backslash doubled before the quote", () => {
    expect(quoteLiteral("\\'", "databend")).toBe("'\\\\'''");
  });

  test("the reference readers refuse what is not one token", () => {
    expect(() => unescapeLiteral("'a'b'")).toThrow("not one literal token");
    expect(() => unescapeLiteral("'\\n'")).toThrow("unexpected escape");
    expect(() => unescapeIdentifier("`a`b`")).toThrow("not one identifier token");
    // The standard quoting of a value ending in a backslash leaves the closing quote
    // escaped, so the reference has to tell it from the Databend quoting.
    expect(() => unescapeLiteral(quoteLiteral("x\\", "postgres"))).toThrow("not one literal token");
  });

  test("a quoted name or value followed by more statement text ends where it should", () => {
    // The sticky regexes are the anchored token rules above without the end anchor,
    // so they read the first token of a statement the way the lexer does.
    const identifier = quoteIdentifier("x\\", "databend");
    const identifierStatement = `${identifier} FROM t; DROP TABLE u; --`;
    const identifierRule = /`([^`]|``)*`/y;
    expect(identifierRule.exec(identifierStatement)?.[0]).toBe(identifier);
    expect(identifierStatement.slice(identifierRule.lastIndex)).toStartWith(" FROM");

    const literal = quoteLiteral("x\\", "databend");
    const literalStatement = `${literal}; DROP TABLE u; --'`;
    const literalRule = /'([^'\\]|\\.|'')*'/y;
    expect(literalRule.exec(literalStatement)?.[0]).toBe(literal);
    expect(literalStatement.slice(literalRule.lastIndex)).toStartWith("; DROP");
  });

  test("the generator is seeded and draws 10,000 strings", () => {
    expect(GENERATED).toHaveLength(10_000);
    expect(generate(20261008, 3)).toEqual(GENERATED.slice(0, 3));
  });

  for (const [name, values] of [
    ["the C15 and C16 corpus", CORPUS],
    ["10,000 seeded strings", GENERATED],
  ] as const) {
    test(`every literal is one token that reads back as its value: ${name}`, () => {
      for (const value of values) {
        const token = quoteLiteral(value, "databend");
        expect({ value, token, match: LITERAL_TOKEN.test(token) }).toEqual({ value, token, match: true });
        expect(unescapeLiteral(token)).toBe(value);
      }
    });

    test(`every identifier is one token that reads back as its name: ${name}`, () => {
      for (const value of values) {
        const token = quoteIdentifier(value, "databend");
        expect({ value, token, match: IDENTIFIER_TOKEN.test(token) }).toEqual({ value, token, match: true });
        expect(unescapeIdentifier(token)).toBe(value);
      }
    });
  }
});
