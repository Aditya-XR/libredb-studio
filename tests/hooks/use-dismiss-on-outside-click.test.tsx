import "../setup-dom";

import React, { useState } from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useDismissOnOutsideClick } from "@/hooks/use-dismiss-on-outside-click";

function Panel({ startOpen = true }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const ref = useDismissOnOutsideClick<HTMLDivElement>(open, () => setOpen(false));

  return (
    <div>
      <div ref={ref} data-testid="region">
        <button type="button" data-testid="trigger" onClick={() => setOpen((value) => !value)}>
          toggle
        </button>
        {open && <div data-testid="panel">panel</div>}
      </div>
      <div data-testid="elsewhere">elsewhere</div>
    </div>
  );
}

describe("useDismissOnOutsideClick", () => {
  afterEach(() => {
    cleanup();
  });

  test("dismisses on a press outside the region", () => {
    const { queryByTestId } = render(<Panel />);

    expect(queryByTestId("panel")).not.toBeNull();
    fireEvent.mouseDown(queryByTestId("elsewhere")!);
    expect(queryByTestId("panel")).toBeNull();
  });

  /**
   * The control, and the reason the ref wraps the trigger as well as the panel: a press on
   * the trigger must reach the toggle it already has. Dismissing here would close the panel
   * and let the click reopen it, leaving a control that never appears to change anything.
   */
  test("leaves a press on the trigger to the trigger", () => {
    const { queryByTestId } = render(<Panel />);

    fireEvent.mouseDown(queryByTestId("trigger")!);
    expect(queryByTestId("panel")).not.toBeNull();
  });

  test("leaves a press inside the panel alone", () => {
    const { queryByTestId } = render(<Panel />);

    fireEvent.mouseDown(queryByTestId("panel")!);
    expect(queryByTestId("panel")).not.toBeNull();
  });

  /**
   * Nothing is listening while the panel is closed, so a press cannot call a dismiss that
   * would run on a surface with nothing to dismiss. Asserted by opening afterwards: a
   * listener that had run would have left the state it closed.
   */
  test("attaches nothing while inactive", () => {
    const { queryByTestId } = render(<Panel startOpen={false} />);

    fireEvent.mouseDown(queryByTestId("elsewhere")!);
    fireEvent.click(queryByTestId("trigger")!);
    expect(queryByTestId("panel")).not.toBeNull();
  });

  /**
   * A target that is not a Node is treated as outside rather than thrown on. `MouseEvent`
   * permits it and this handler runs on every press in the document.
   */
  test("treats a target that is not a node as outside", () => {
    const { queryByTestId } = render(<Panel />);

    const event = new MouseEvent("mousedown", { bubbles: true });
    Object.defineProperty(event, "target", { value: null });
    // Through `fireEvent` and not `document.dispatchEvent`: the raw call dispatches the
    // event but leaves the state update it causes outside React's act() scope, so the
    // component never re-renders and the assertion reads a stale tree.
    fireEvent(document, event);

    expect(queryByTestId("panel")).toBeNull();
  });
});
