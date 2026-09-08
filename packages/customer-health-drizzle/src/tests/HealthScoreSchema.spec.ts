import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { tenantHealthScores } from "../libs/schema";

describe("health score schema", () => {
  it("identifies score rows by their generated transition sequence", () => {
    const { columns } = getTableConfig(tenantHealthScores);

    expect(columns.filter((column) => column.primary).map((column) => column.name)).toEqual([
      "transition_sequence",
    ]);
    expect(tenantHealthScores.transitionSequence.notNull).toBe(true);
    expect(tenantHealthScores.transitionSequence.hasDefault).toBe(true);
  });

  it.each([
    ["tenant_health_scores_tenant_seq_idx", "transition_sequence"],
    ["tenant_health_scores_tenant_calc_idx", "calculated_at"],
  ])("supports tenant-scoped descending history with %s", (name, orderingColumn) => {
    const { indexes } = getTableConfig(tenantHealthScores);
    const config = indexes.find((entry) => entry.config.name === name)?.config;

    expect(config).toMatchObject({
      method: "btree",
      unique: false,
      columns: [
        { name: "tenant_id", indexConfig: { order: "asc" } },
        { name: orderingColumn, indexConfig: { order: "desc" } },
      ],
    });
    expect(config?.where).toBeUndefined();
  });
});
