import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildPostgresDocumentBulkUpsertQueryPlans } from "../libs/postgresDocumentIndex";

describe("PostgresDocumentIndex", () => {
  it("binds undefined bulk fields as null while preserving populated values", () => {
    const plans = buildPostgresDocumentBulkUpsertQueryPlans(
      "documents",
      [
        { id: "1", tenantId: "tenant", value: undefined },
        { id: "2", tenantId: "tenant", value: null },
        { id: "3", tenantId: "tenant", value: 0 },
        { id: "4", tenantId: "tenant", value: false },
        { id: "5", tenantId: "tenant", value: "" },
        { id: "6", tenantId: "tenant", value: "text" },
      ],
      "tenant",
    );

    expect(plans).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(plans[0].query);
    expect(query.params).toEqual([
      "1",
      null,
      "tenant",
      "2",
      null,
      "tenant",
      "3",
      0,
      "tenant",
      "4",
      false,
      "tenant",
      "5",
      "",
      "tenant",
      "6",
      "text",
      "tenant",
    ]);
  });

  it("keeps omitted fields out of their bulk upsert group", () => {
    const plans = buildPostgresDocumentBulkUpsertQueryPlans(
      "documents",
      [
        { id: "1", tenantId: "tenant", value: undefined },
        { id: "2", tenantId: "tenant" },
      ],
      "tenant",
    );

    expect(plans).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(plans[0].query);
    expect(query.params).toEqual(["1", null, "tenant", "2", "tenant"]);
    expect(query.sql).toContain('"bulk_index_1" AS (');
    expect(query.sql).toContain('INSERT INTO "documents" ("id", "tenant_id")');
    expect(query.sql).toContain("DO NOTHING");
  });
});
