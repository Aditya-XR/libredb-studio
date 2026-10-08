import { describe, expect, test } from "bun:test";
import {
  acceptNextUri,
  finalPath,
  killPath,
  LOGOUT_PATH,
  NEXT_URI_REFUSED,
  QUERY_PATH,
} from "@/lib/db/providers/sql/databend/routes";

const ID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("Databend routes", () => {
  test("the query, final, kill and logout paths, built from our id", () => {
    expect(QUERY_PATH).toBe("/v1/query");
    expect(finalPath(ID)).toBe(`/v1/query/${ID}/final`);
    expect(killPath(ID)).toBe(`/v1/query/${ID}/kill`);
    expect(LOGOUT_PATH).toBe("/v1/session/logout");
  });

  test.each([
    ["page 0", `/v1/query/${ID}/page/0`, 0],
    ["page 1", `/v1/query/${ID}/page/1`, 1],
    ["the largest page number", `/v1/query/${ID}/page/999999999`, 999999999],
  ])("accepts %s of our statement, rebuilt from our id", (_name, link, page) => {
    expect(acceptNextUri(link, ID)).toEqual({ kind: "page", page, path: `/v1/query/${ID}/page/${page}` });
  });

  test("accepts our final link", () => {
    expect(acceptNextUri(`/v1/query/${ID}/final`, ID)).toEqual({ kind: "final", path: `/v1/query/${ID}/final` });
  });

  test.each([
    ["the state link", `/v1/query/${ID}`],
    ["the state link with a trailing slash", `/v1/query/${ID}/`],
    ["the kill link", `/v1/query/${ID}/kill`],
    ["an absolute same-origin URL", `http://127.0.0.1:8000/v1/query/${ID}/page/1`],
    ["an absolute foreign URL", `https://evil.example/v1/query/${ID}/page/1`],
    ["a protocol-relative link", `//evil.example/v1/query/${ID}/page/1`],
    ["a doubled slash", `/v1//query/${ID}/page/1`],
    ["a backslash", `/v1/query/${ID}\\page/1`],
    ["a percent escape", `/v1/query/${ID}/page/%31`],
    ["a query string", `/v1/query/${ID}/page/1?x=1`],
    ["an empty query string", `/v1/query/${ID}/final?`],
    ["a fragment", `/v1/query/${ID}/final#x`],
    ["a dot segment", `/v1/query/${ID}/page/../final`],
    ["a dot-dot to another id", `/v1/query/${ID}/../${OTHER}/final`],
    ["a space", `/v1/query/${ID}/page/ 1`],
    ["a trailing line feed", `/v1/query/${ID}/final\n`],
    ["a line feed after the page number", `/v1/query/${ID}/page/1\n`],
    ["a CR LF after the page number", `/v1/query/${ID}/page/1\r\n`],
    ["a tab", `/v1/query/${ID}/page/\t1`],
    ["a control character", `/v1/query/${ID}/page/1\u0000`],
    ["a DEL", `/v1/query/${ID}/final\u007f`],
    ["another statement's page", `/v1/query/${OTHER}/page/1`],
    ["another statement's final", `/v1/query/${OTHER}/final`],
    ["our id in upper case", `/v1/query/${ID.toUpperCase()}/final`],
    ["a page number with a leading zero", `/v1/query/${ID}/page/01`],
    ["a page number of ten digits", `/v1/query/${ID}/page/1000000000`],
    ["a negative page number", `/v1/query/${ID}/page/-1`],
    ["a page with no number", `/v1/query/${ID}/page/`],
    ["a non-ASCII digit", `/v1/query/${ID}/page/١`],
    ["another API version", `/v2/query/${ID}/final`],
    ["a relative link", `v1/query/${ID}/final`],
    ["an empty link", ""],
    ["a link over 512 bytes", `/v1/query/${ID}/page/1${"/".repeat(512)}`],
  ])("refuses %s, naming neither the link nor any id", (_name, link) => {
    const refusal = acceptNextUri(link, ID);
    expect(refusal).toEqual({ kind: "refused", reason: NEXT_URI_REFUSED });
    expect(NEXT_URI_REFUSED).not.toContain("/");
    expect(NEXT_URI_REFUSED).not.toContain(ID);
    expect(NEXT_URI_REFUSED).not.toContain(OTHER);
  });
});
