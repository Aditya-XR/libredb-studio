/**
 * Server values more than one language pack holds by reference (#1821). A leaf: it imports nothing.
 */

/** A language whose argument is text: the statement is the string as written, and nothing else is one. */
export const canonicalText = (raw: unknown): string | null => (typeof raw === "string" && raw.length > 0 ? raw : null);
