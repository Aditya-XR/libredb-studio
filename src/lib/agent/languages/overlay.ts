/**
 * `defineOverlay` (#1821): one facet of a family pack with an engine's overlay applied. Client tier and a leaf: it
 * loads nothing at run time, so every tier may read it.
 *
 * Applied facet by facet, member by member. A function in the overlay is called with the base member and its result
 * becomes the member; any other value replaces the member whole. Values are never merged, so an overlay that gives a
 * record gives all of it. Every member the overlay leaves alone keeps its reference, and an overlay with no own key is
 * no overlay: the base comes back itself.
 */
import type { FacetOverrides } from "./pack";

/**
 * `base` with `overlay` applied, frozen. `A` carries members the base lacks, such as an engine's `dialect`; a member the
 * base holds keeps the base's type, whether the overlay gave a value or a derivation.
 */
export function defineOverlay<B extends object, A extends object = Record<never, never>>(
  base: B,
  overlay?: FacetOverrides<B> & A,
): Readonly<B & Omit<A, keyof B>> {
  if (overlay === undefined || Object.keys(overlay).length === 0) return base as Readonly<B & Omit<A, keyof B>>;
  const resolved: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(overlay)) {
    resolved[key] = typeof member === "function" ? member((base as Record<string, unknown>)[key]) : member;
  }
  return Object.freeze({ ...base, ...resolved }) as Readonly<B & Omit<A, keyof B>>;
}
