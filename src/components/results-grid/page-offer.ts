import type { QueryPagination } from "@/lib/types";

/**
 * The offer of a next page, or the absence of one (#816).
 *
 * Whether another page can be fetched is asked in two places that must not disagree: the
 * grid, which renders the control, and the export dialog, which tells the user to "load
 * them first" before exporting. Written out twice they drift, and the drift is silent -
 * the dialog names an action the UI does not offer, which is the same failure the control
 * itself was designed to avoid on the engines that cannot page.
 */
export interface PageOffer {
  /** Fetch it. */
  onLoadMore: () => void;
  /** The size of the page already on screen, so a label can name what the click delivers. */
  pageSize: number;
}

/**
 * The three conditions, in order.
 *
 * The provider can really apply an offset (`ProviderCapabilities.supportsResultPagination`,
 * gated on `=== true` so an absent flag reads as unsupported); the route says another page
 * exists, which it now only does for a bound the route itself applied; and this surface is
 * offering to fetch it, which a result hydrated from an agent run is not.
 */
export function pageOfferFor(
  pagination: QueryPagination | undefined,
  supportsResultPagination: boolean | undefined,
  onLoadMore: (() => void) | undefined,
): PageOffer | undefined {
  if (supportsResultPagination !== true || pagination?.hasMore !== true || onLoadMore === undefined) {
    return undefined;
  }
  return { onLoadMore, pageSize: pagination.limit };
}
