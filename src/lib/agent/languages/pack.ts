/**
 * The shape of a statement language's pack (#1821). Types only: nothing here is evaluated, so every tier may read it.
 */
import type { PlanStatementIdentifiers } from "../plan-statement";
import type { AgentInventory } from "../types";

export interface AgentLanguageServerAdapter {
  /** The descriptor this language's model-written reads are evaluated under. */
  readonly readOperation: "sql.query.read" | "kubectl.query.read" | "mongo.query.read";
  /**
   * The model's argument as the one statement text every server layer reads: the fence, the provider, the ledger
   * and the repair identity. Null for any value that carries no statement, which the caller refuses rather than
   * sending.
   */
  readonly canonicalize: (raw: unknown) => string | null;
  /** Total over any text: the repair ledger's identity of one call. */
  readonly fingerprint: (text: string) => string;
  /** The sentence for a read refused past the row budget. */
  readonly rowCapAdvice: (statement: string, allowed: string) => string;
  /** The admission pre-check: the reader's own refusal, or null when admitted. Null for SQL, whose shape advice stays (D6). */
  readonly admit: ((text: string) => { readonly code: string; readonly message: string } | null) | null;
  /** The sentence a shape denial carries, in this language's words. Absent for SQL, whose sentence stays (D6). */
  readonly shapeAdvice?: string;
  /**
   * The check of an admitted statement against the run's captured inventory, for a language whose engine answers a
   * mistake the inventory already shows with an empty result instead of an error: the model's sentence, or null when
   * the inventory sees nothing wrong or cannot tell. Absent for SQL and kubectl, whose engines refuse such a statement
   * themselves. See `mongo/inventory-check.ts`.
   */
  readonly inventoryProblem?: (text: string, inventory: AgentInventory | null) => string | null;
  /**
   * The names a plan-mode draft in this language uses, read against the inventory, for a language whose drafts this
   * server can read for names although the SQL guard cannot read them. Absent for SQL, whose drafts the SQL reader in
   * `plan-statement.ts` checks, and for kubectl.
   */
  readonly planDraftIdentifiers?: (text: string, inventory: AgentInventory | null) => PlanStatementIdentifiers;
}

/** What a language does on the server, below `tools.ts`. Reached through `languageServerPack` in `server.ts`. */
export interface AgentLanguageServerPack {
  readonly adapter: AgentLanguageServerAdapter;
}
