import type { SearchDocument } from "@croco/search-core";
import { type SQL, sql } from "drizzle-orm";
import { BulkIndexDocumentTooWideProblem } from "./problems/BulkIndexProblems";

import type { BulkIndexQueryPlan } from "./types";

const DOCUMENT_ID_COLUMN = "id";
const DOCUMENT_TENANT_ID_FIELD = "tenantId";
const TENANT_ID_COLUMN = "tenant_id";
const DOCUMENT_TENANT_FIELDS = new Set([DOCUMENT_TENANT_ID_FIELD, TENANT_ID_COLUMN]);
const MAX_BULK_INDEX_DOCUMENTS_PER_QUERY = 100;
const MAX_BULK_INDEX_PARAMETERS_PER_QUERY = 60_000;

type PlannedDocument = {
  document: SearchDocument;
  documentIndexes: number[];
};

type DocumentGroup = {
  columns: readonly string[];
  documents: PlannedDocument[];
};

export function buildPostgresDocumentUpsertQuery(
  table: string,
  document: SearchDocument,
  tenantId: string,
): SQL {
  const documentEntries = getDocumentEntries(document);
  const insertEntries = [...documentEntries, [TENANT_ID_COLUMN, tenantId] as const];
  const updateColumns = documentEntries
    .map(([column]) => column)
    .filter((column) => column !== DOCUMENT_ID_COLUMN);

  const columnChunks = sql.join(
    insertEntries.map(([column]) => sql.identifier(column)),
    sql`, `,
  );
  const valueChunks = sql.join(
    insertEntries.map(([, value]) => sql.param(value)),
    sql`, `,
  );
  const conflictAction = buildConflictAction(updateColumns);

  return sql`
    INSERT INTO ${sql.identifier(table)} (${columnChunks})
    VALUES (${valueChunks})
    ON CONFLICT (${sql.identifier(TENANT_ID_COLUMN)}, ${sql.identifier(DOCUMENT_ID_COLUMN)})
    ${conflictAction}
  `;
}

export function buildPostgresDocumentBulkUpsertQueryPlans(
  table: string,
  documents: readonly SearchDocument[],
  tenantId: string,
): readonly BulkIndexQueryPlan[] {
  const plannedDocuments = coalesceDocuments(documents);
  const chunks: PlannedDocument[][] = [];
  let chunk: PlannedDocument[] = [];
  let parameterCount = 0;

  for (const plannedDocument of plannedDocuments) {
    const documentParameterCount = getDocumentEntries(plannedDocument.document).length + 1;
    if (documentParameterCount > MAX_BULK_INDEX_PARAMETERS_PER_QUERY) {
      throw new BulkIndexDocumentTooWideProblem(
        plannedDocument.documentIndexes,
        documentParameterCount,
        MAX_BULK_INDEX_PARAMETERS_PER_QUERY,
      );
    }

    if (
      chunk.length > 0 &&
      (chunk.length === MAX_BULK_INDEX_DOCUMENTS_PER_QUERY ||
        parameterCount + documentParameterCount > MAX_BULK_INDEX_PARAMETERS_PER_QUERY)
    ) {
      chunks.push(chunk);
      chunk = [];
      parameterCount = 0;
    }

    chunk.push(plannedDocument);
    parameterCount += documentParameterCount;
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks.map((documentsInChunk) => ({
    query: buildChunkQuery(table, documentsInChunk, tenantId),
    documentIndexes: documentsInChunk
      .flatMap(({ documentIndexes }) => documentIndexes)
      .sort((left, right) => left - right),
  }));
}

function coalesceDocuments(documents: readonly SearchDocument[]): PlannedDocument[] {
  const byDocumentId = new Map<string, PlannedDocument>();

  documents.forEach((document, documentIndex) => {
    const existing = byDocumentId.get(document.id);
    if (existing) {
      existing.document = { ...existing.document, ...document };
      existing.documentIndexes.push(documentIndex);
      return;
    }

    byDocumentId.set(document.id, {
      document: { ...document },
      documentIndexes: [documentIndex],
    });
  });

  return [...byDocumentId.values()];
}

function buildChunkQuery(
  table: string,
  documents: readonly PlannedDocument[],
  tenantId: string,
): SQL {
  const groups = groupDocumentsByColumns(documents);
  const groupQueries = groups.map((group) => buildGroupUpsertQuery(table, group, tenantId));

  if (groupQueries.length === 1) {
    return groupQueries[0];
  }

  const commonTableExpressions = groupQueries.map(
    (query, index) => sql`${sql.identifier(`bulk_index_${index}`)} AS (${query} RETURNING 1)`,
  );
  return sql`WITH ${sql.join(commonTableExpressions, sql`, `)} SELECT 1`;
}

function groupDocumentsByColumns(documents: readonly PlannedDocument[]): DocumentGroup[] {
  const groups = new Map<string, DocumentGroup>();

  for (const plannedDocument of documents) {
    const columns = getDocumentEntries(plannedDocument.document).map(([column]) => column);
    const signature = JSON.stringify(columns);
    const existing = groups.get(signature);
    if (existing) {
      existing.documents.push(plannedDocument);
    } else {
      groups.set(signature, { columns, documents: [plannedDocument] });
    }
  }

  return [...groups.values()];
}

function buildGroupUpsertQuery(table: string, group: DocumentGroup, tenantId: string): SQL {
  const insertColumns = [...group.columns, TENANT_ID_COLUMN];
  const values = group.documents.map(({ document }) => {
    const documentEntries = new Map(getDocumentEntries(document));
    const rowValues = group.columns.map((column) => sql.param(documentEntries.get(column) ?? null));
    return sql`(${sql.join([...rowValues, sql.param(tenantId)], sql`, `)})`;
  });
  const updateColumns = group.columns.filter((column) => column !== DOCUMENT_ID_COLUMN);
  const conflictAction = buildConflictAction(updateColumns);

  return sql`
    INSERT INTO ${sql.identifier(table)} (${sql.join(
      insertColumns.map((column) => sql.identifier(column)),
      sql`, `,
    )})
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (${sql.identifier(TENANT_ID_COLUMN)}, ${sql.identifier(DOCUMENT_ID_COLUMN)})
    ${conflictAction}
  `;
}

function buildConflictAction(updateColumns: readonly string[]): SQL {
  if (updateColumns.length === 0) {
    return sql`DO NOTHING`;
  }

  return sql`DO UPDATE SET ${sql.join(
    updateColumns.map(
      (column) => sql`${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`,
    ),
    sql`, `,
  )}`;
}

function getDocumentEntries(document: SearchDocument): [string, unknown][] {
  return Object.entries(document)
    .filter(([column]) => !DOCUMENT_TENANT_FIELDS.has(column))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}
