"use client";

import { useEffect, useRef } from "react";

/**
 * Close a popover when the next press lands outside it (#870).
 *
 * Two surfaces in the results grid open a small panel over the rows: the per-column filter
 * in `ResultsGrid` and the column visibility menu in `StatsBar`. Both were dismissed only
 * by pressing their own trigger again, and both cover the rows they sit over, so the one
 * gesture that closed them was also the one gesture the panel hid.
 *
 * The returned ref goes on an element that contains BOTH the panel and its trigger, not on
 * the panel alone. A press on the trigger would otherwise be "outside": this handler would
 * close the panel and the trigger's own click would reopen it a moment later, so the
 * control would look dead. Containing the trigger leaves that press to the toggle it
 * already has.
 *
 * `mousedown` rather than `click`, because a click is delivered after `mouseup` and a
 * re-render between the two can detach the element the browser was going to deliver it to.
 * The listener is attached only while `active`, so a closed popover costs nothing and no
 * handler survives it.
 */
export function useDismissOnOutsideClick<T extends HTMLElement>(active: boolean, onDismiss: () => void) {
  const ref = useRef<T | null>(null);
  // The callback is read through a ref so that a caller passing an inline arrow does not
  // re-attach the listener on every render. Written in an effect and not during render:
  // `react(refs)` is an error in this repository, and a render-time write is also what
  // makes a ref disagree with the render that was committed.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (!active) return;

    const onPress = (event: MouseEvent) => {
      const container = ref.current;
      // `composedTarget` is not needed: neither surface renders into a shadow root, and a
      // target that is not a Node at all (which the type permits) is treated as outside.
      const target = event.target;
      if (container !== null && target instanceof Node && container.contains(target)) return;
      dismiss.current();
    };

    document.addEventListener("mousedown", onPress);
    return () => document.removeEventListener("mousedown", onPress);
  }, [active]);

  return ref;
}
