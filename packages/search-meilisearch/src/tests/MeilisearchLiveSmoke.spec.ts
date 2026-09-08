import { createHash } from "node:crypto";
import { Context } from "@croco/framework-context";
import type { SearchHit } from "@croco/search-core";
import { describe, expect, it, vi } from "vitest";
import { MeilisearchDiagnosticsProvider } from "../libs/MeilisearchDiagnosticsProvider";
import { MeilisearchEngine } from "../libs/MeilisearchEngine";
import type { MeilisearchEngineOptions } from "../libs/types";

const MEILISEARCH_LIVE_ENV = ["MEILISEARCH_HOST", "MEILISEARCH_API_KEY"] as const;

const missingLiveSmokeEnv = MEILISEARCH_LIVE_ENV.filter((name) => !process.env[name]);

const liveConfig: MeilisearchEngineOptions = {
  apiKey: process.env.MEILISEARCH_API_KEY ?? "",
  host: process.env.MEILISEARCH_HOST ?? "",
  taskWait: {
    timeoutMs: 10_000,
  },
};

describe("Meilisearch live smoke", () => {
  it.skipIf(missingLiveSmokeEnv.length > 0)(
    "does not match internal document keys when searchable fields are discovered by default",
    async () => {
      const indexName = `croco_default_search_${Date.now()}`;
      const engine = new MeilisearchEngine(liveConfig);
      try {
        await engine.createIndex({ name: indexName });
        await Context.run({ requestId: "default-search", tenantId: "x" }, async () => {
          await engine.indexDocument(indexName, { id: "1", tenantId: "x", title: "hello" });
          const hashPrefix = createHash("sha256")
            .update(JSON.stringify(["x", "1"]))
            .digest("hex")
            .slice(0, 8);
          expect((await engine.search(indexName, { query: hashPrefix })).total).toBe(0);
          expect(
            (await engine.search(indexName, { query: "hello" })).hits[0].document,
          ).toMatchObject({ id: "1", title: "hello" });
        });
      } finally {
        await engine.deleteIndex(indexName, { allowGlobalDrop: true });
      }
    },
  );

  it.skipIf(missingLiveSmokeEnv.length > 0)(
    "requires MEILISEARCH_HOST and MEILISEARCH_API_KEY for live Meilisearch readiness and search smoke",
    async () => {
      const diagnostics = new MeilisearchDiagnosticsProvider(liveConfig, {
        readinessCheck: async ({ client }) => {
          await client.health();
          return {
            details: {
              reachable: true,
            },
          };
        },
      });
      const health = await diagnostics.getHealth();
      expect(health).toMatchObject({
        component: "search-meilisearch",
        details: expect.objectContaining({
          liveCheck: "passed",
        }),
        status: "healthy",
      });

      const tenantId = `tenant-${Date.now()}`;
      const indexName = `croco_live_smoke_${Date.now()}`;
      const tenantContext = vi.spyOn(Context, "getTenantId").mockReturnValue(tenantId);

      const engine = new MeilisearchEngine(liveConfig);

      try {
        await engine.createIndex({
          filterableFields: ["kind"],
          name: indexName,
          searchableFields: ["title"],
        });
        await engine.indexDocument(indexName, {
          id: "doc-1",
          kind: "smoke",
          tenantId,
          title: "Croco Meilisearch live smoke",
        });

        tenantContext.mockReturnValue(`${tenantId}-other`);
        await engine.bulkIndex(indexName, [
          {
            id: "doc-1",
            kind: "smoke",
            tenantId: "forged",
            title: "Other tenant document",
          },
        ]);
        tenantContext.mockReturnValue(tenantId);

        const result = await engine.search<{ id: string; title: string }>(indexName, {
          filters: { kind: "smoke" },
          query: "Croco",
        });

        expect(
          result.hits.some(
            (hit: SearchHit<{ id: string; title: string }>) => hit.document.id === "doc-1",
          ),
        ).toBe(true);
        expect(result.hits[0].document).not.toHaveProperty("_crocoDocumentId");
        expect(result.total).toBe(1);
        await engine.deleteDocument(indexName, "doc-1");
        expect((await engine.search(indexName, { query: "" })).total).toBe(0);
        tenantContext.mockReturnValue(`${tenantId}-other`);
        const other = await engine.search(indexName, { query: "", filters: { id: "doc-1" } });
        expect(other.total).toBe(1);
        expect(other.hits[0].document).toMatchObject({
          id: "doc-1",
          title: "Other tenant document",
        });
      } finally {
        tenantContext.mockRestore();
        await engine.deleteIndex(indexName, { allowGlobalDrop: true });
      }
    },
  );
});
