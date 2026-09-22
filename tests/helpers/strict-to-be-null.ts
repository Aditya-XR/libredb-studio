/**
 * A `toBeNull` that actually fails, because bun's own one does not in this repository.
 *
 * MEASURED on bun 1.4.2 against the object tree, twice, by two independent reviewers and again
 * here: `expect(element).toBeNull()` on a REACT-RENDERED element does not throw. It is not a
 * matcher bug and it is not a DOM-size effect. A hand-built DOM of 128 sibling rows throws, and
 * sixteen React rows rendered through Testing Library throw. What does not throw is an element
 * the real `ObjectTree` rendered, whose nodes carry `__reactFiber$` and `__reactProps$` into a
 * fiber graph bun's diff formatter cannot finish walking: it spends about twenty seconds building
 * a failure message and then the assertion passes. Two such calls in one test take bun down with
 * `panic(main thread): Segmentation fault`.
 *
 * WHY THAT IS WORSE THAN A SLOW TEST. The signature is a suite that stays green, so a negative
 * assertion silently stops asserting. Measured on this branch: deleting the empty-type guard in
 * `TreeRow.tsx` left all eighteen tests in `column-rows.test.tsx` passing, with the only symptom a
 * run that went from 0.8 seconds to 20.9. With this matcher the same mutant dies in 26ms.
 *
 * Row count does not predict which call is affected, so a per-site audit cannot find them. This is
 * a preload for that reason: the trap catches the next test written, not only the ones that exist.
 *
 * SAFE TO TURN ON, measured rather than assumed: the whole suite is green with it, 586 files and
 * 19,207 tests, over 3,037 `toBeNull()` calls in 213 files. A strict matcher can only fail a call
 * that is currently asserting something false, and none was. The vacuity was latent.
 *
 * The message never formats the received value beyond its tag name, which is the whole point: it
 * must not walk a fiber graph to explain itself.
 */
import { expect } from "bun:test";

function describeReceived(received: unknown): string {
  if (received === undefined) return "undefined";
  if (typeof received === "object" && received !== null && "tagName" in received) {
    return `<${String((received as { readonly tagName: unknown }).tagName).toLowerCase()}> element`;
  }
  return String(received);
}

expect.extend({
  toBeNull(received: unknown) {
    const pass = received === null;
    return {
      pass,
      message: () =>
        pass ? "expected the value not to be null" : `expected null, received ${describeReceived(received)}`,
    };
  },
});
