import { describe, expect, test } from "bun:test";
import { clipboardField, selectionClipboardText } from "@/components/results-grid/clipboard";

describe("clipboardField", () => {
  test("leaves a plain value as it is", () => {
    expect(clipboardField("Alice")).toBe("Alice");
    expect(clipboardField("")).toBe("");
    expect(clipboardField("12.50")).toBe("12.50");
  });

  test("quotes a value holding a tab, a line break or a quote, doubling the quotes, the way Excel does", () => {
    expect(clipboardField("a\tb")).toBe('"a\tb"');
    expect(clipboardField("line 1\nline 2")).toBe('"line 1\nline 2"');
    expect(clipboardField("line 1\r\nline 2")).toBe('"line 1\r\nline 2"');
    expect(clipboardField('say "hi"')).toBe('"say ""hi"""');
  });
});

describe("selectionClipboardText", () => {
  test("a single cell copies its value raw, with no quoting, so it pastes into an editor as typed", () => {
    expect(selectionClipboardText([{ rows: [["line 1\nline 2"]] }])).toBe("line 1\nline 2");
    expect(selectionClipboardText([{ rows: [['say "hi"']] }])).toBe('say "hi"');
  });

  test("a range copies as tab-separated rows, so it pastes into a spreadsheet cell for cell", () => {
    expect(
      selectionClipboardText([
        {
          rows: [
            ["1", "Alice"],
            ["2", "Bob"],
          ],
        },
      ]),
    ).toBe("1\tAlice\n2\tBob");
  });

  test("a range quotes the values that would otherwise split a cell or a row", () => {
    expect(selectionClipboardText([{ rows: [["1", "a\tb"]] }])).toBe('1\t"a\tb"');
    expect(selectionClipboardText([{ rows: [["x"], ["two\nlines"]] }])).toBe('x\n"two\nlines"');
  });

  test("headers lead the range when asked for, quoted by the same rule", () => {
    expect(selectionClipboardText([{ headers: ["id", "full\tname"], rows: [["1", "Alice"]] }])).toBe(
      'id\t"full\tname"\n1\tAlice',
    );
  });

  test("a single cell copied with its header is a two-line range, not a raw value", () => {
    expect(selectionClipboardText([{ headers: ["note"], rows: [["a\tb"]] }])).toBe('note\n"a\tb"');
  });

  test("several regions stack one under the other in selection order", () => {
    expect(
      selectionClipboardText([
        { headers: ["id"], rows: [["1"]] },
        { headers: ["name"], rows: [["Bob"], ["Eve"]] },
      ]),
    ).toBe("id\n1\nname\nBob\nEve");
  });

  test("two single cells are two rows, each a quoted field", () => {
    expect(selectionClipboardText([{ rows: [["a\tb"]] }, { rows: [["c"]] }])).toBe('"a\tb"\nc');
  });

  test("nothing selected copies nothing", () => {
    expect(selectionClipboardText([])).toBe("");
  });
});
