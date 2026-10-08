/**
 * The Databend HTTP query API paths (design 3.9, 3.10): the statement POST, the page and final links of its
 * `next_uri` chain, its kill and the session logout. Every path is built here from the query id Studio sent, never
 * from a link the server handed back, so `endpointUrl` only ever receives a path written in this file.
 *
 * `next_uri` is the one link followed, and only in the two measured, origin-relative shapes for our own id (M25a):
 * `/v1/query/ID/page/N` and `/v1/query/ID/final`. Everything else is refused, the state link `/v1/query/ID` among
 * them: the server sends it only for a running query whose page manager has ended, which its executor's ordering
 * prevents, and its body has another shape. `stats_uri`, `final_uri` and `kill_uri` are never read.
 *
 * This is the only file of the directory that holds a `/v1/` literal (the seam guard checks it).
 */

/** The statement POST, which the ROLLBACK of design 3.4 also takes. */
export const QUERY_PATH = "/v1/query";

/** Ends the session, which drops its temporary tables (UC5). */
export const LOGOUT_PATH = "/v1/session/logout";

/** What a refused `next_uri` is called in the protocol sentence of design 3.13; it names neither the link nor an id. */
export const NEXT_URI_REFUSED = "a next_uri link of a shape Studio does not follow";

/** A page number as the server writes it: no sign, no leading zero, at most nine digits. */
const PAGE_NUMBER = /^(0|[1-9][0-9]{0,8})$/;

/** The path of one of our statement's links, its id in the form a URL keeps. */
function statementPath(queryId: string, rest: string): string {
  return `${QUERY_PATH}/${encodeURIComponent(queryId)}/${rest}`;
}

/** Closes a statement the server already ended, early (design 3.10); its `1044 closed by client` is ignored. */
export function finalPath(queryId: string): string {
  return statementPath(queryId, "final");
}

/** Stops a statement; idempotent, and it ends a long poll at once (M12g, M12i). */
export function killPath(queryId: string): string {
  return statementPath(queryId, "kill");
}

/** A `next_uri` the loop may follow, as the path rebuilt from our id; `page` is the page it names. */
export type AcceptedLink =
  | { readonly kind: "page"; readonly page: number; readonly path: string }
  | { readonly kind: "final"; readonly path: string };

export type NextUriDecision = AcceptedLink | { readonly kind: "refused"; readonly reason: string };

/**
 * Accepts `link` only as exactly page N or final of the statement `queryId`, compared as text: an absolute URL (even
 * a same-origin one), `//`, `\`, `%`, `?`, `#`, a dot segment, whitespace, a control character, another id and any
 * longer text cannot equal either shape, so each is refused with the same sentence.
 */
export function acceptNextUri(link: string, queryId: string): NextUriDecision {
  const final = finalPath(queryId);
  if (link === final) return { kind: "final", path: final };

  const pagePrefix = statementPath(queryId, "page/");
  if (link.startsWith(pagePrefix)) {
    const page = link.slice(pagePrefix.length);
    if (PAGE_NUMBER.test(page))
      return { kind: "page", page: Number(page), path: statementPath(queryId, `page/${page}`) };
  }

  return { kind: "refused", reason: NEXT_URI_REFUSED };
}
