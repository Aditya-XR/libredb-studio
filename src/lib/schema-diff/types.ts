export type DiffAction = "added" | "removed" | "modified";

export interface ColumnDiff {
  action: DiffAction;
  columnName: string;
  sourceType?: string;
  targetType?: string;
  sourceNullable?: boolean;
  targetNullable?: boolean;
  sourceDefault?: string;
  targetDefault?: string;
  /**
   * The SQL text that produces `targetDefault`, carried from `ColumnSchema.defaultExpression`
   * and preferred by every site that emits a DEFAULT clause. Absent where the provider could
   * not say, and then the generator falls back to `targetDefault`.
   *
   * The target only: `sourceDefault` is compared and read for a ClickHouse REMOVE keyword,
   * and is never interpolated into emitted SQL.
   */
  targetDefaultSql?: string;
  sourceIsPrimary?: boolean;
  targetIsPrimary?: boolean;
  changes: string[];
}

export interface IndexDiff {
  action: DiffAction;
  indexName: string;
  sourceColumns?: string[];
  targetColumns?: string[];
  sourceUnique?: boolean;
  targetUnique?: boolean;
  changes: string[];
}

export interface ForeignKeyDiff {
  action: DiffAction;
  columnName: string;
  sourceReferencedTable?: string;
  targetReferencedTable?: string;
  sourceReferencedColumn?: string;
  targetReferencedColumn?: string;
  changes: string[];
}

export interface TableDiff {
  action: DiffAction;
  tableName: string;
  columns: ColumnDiff[];
  indexes: IndexDiff[];
  foreignKeys: ForeignKeyDiff[];
}

export interface DiffSummary {
  added: number;
  removed: number;
  modified: number;
}

export interface SchemaDiff {
  tables: TableDiff[];
  summary: DiffSummary;
  hasChanges: boolean;
}
