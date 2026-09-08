import { Context } from "@croco/framework-context";
import {
  MissingTenantProblem,
  SearchOperationAbortedProblem,
  SearchService,
} from "@croco/search-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeilisearchEngine } from "../libs/MeilisearchEngine";
import {
  MeilisearchIndexNotFoundProblem,
  MeilisearchInvalidRequestProblem,
  MeilisearchRetryableUpstreamProblem,
  MeilisearchTerminalUpstreamProblem,
  MissingMeilisearchConfigProblem,
} from "../libs/problems/MeilisearchProblems";
import type { MeilisearchEngineOptions } from "../libs/types";

const SECRET_SAMPLE = "super-secret-token";
const SECRET_RICH_ERROR_MESSAGE = `Authorization: Bearer ${SECRET_SAMPLE}; token=${SECRET_SAMPLE}; https://search.example?apiKey=${SECRET_SAMPLE}; Cookie: session=${SECRET_SAMPLE}`;
type ProblemConstructor<TProblem extends Error> = Function & {
  readonly prototype: TProblem;
  readonly name: string;
};

const mocks = vi.hoisted(() => {
  const index = {
    getRawInfo: vi.fn(),
    search: vi.fn(),
    addDocuments: vi.fn(),
    deleteDocuments: vi.fn(),
    updateSettings: vi.fn(),
  };
  const client = {
    index: vi.fn(() => index),
    createIndex: vi.fn(),
    deleteIndex: vi.fn(),
    generateTenantToken: vi.fn(),
    waitForTask: vi.fn(),
    health: vi.fn(),
  };
  const constructor = vi.fn();
  return { clientMock: client, constructorMock: constructor, indexMock: index };
});

vi.mock("meilisearch", () => ({
  MeiliSearch: class {
    constructor(options: unknown) {
      mocks.constructorMock(options);
      Object.assign(this, mocks.clientMock);
    }
  },
}));

function createUpstreamError(
  message: string,
  options: {
    readonly status?: number;
    readonly code?: string;
    readonly name?: string;
  },
): Error & {
  response?: { readonly status: number };
  cause?: { readonly code?: string; readonly message?: string; readonly type?: string };
  code?: string;
} {
  const error = new Error(message) as Error & {
    response?: { status: number };
    cause?: { code?: string; message?: string; type?: string };
    code?: string;
  };
  if (options.name) {
    error.name = options.name;
  }
  if (options.status !== undefined) {
    error.response = { status: options.status };
  }
  if (options.code !== undefined) {
    error.code = options.code;
    error.cause = { code: options.code, message };
  }
  return error;
}

async function expectProblem<TProblem extends Error>(
  action: () => Promise<unknown>,
  problemClass: ProblemConstructor<TProblem>,
): Promise<TProblem> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(problemClass);
    return error as TProblem;
  }

  throw new Error(`Expected ${problemClass.name} to be thrown.`);
}

describe("Meilisearch provider conformance", () => {
  let engine!: MeilisearchEngine;

  const options: MeilisearchEngineOptions = {
    host: "http://localhost:7700",
    apiKey: "masterKey",
    retryBackoff: {
      delay: 0,
      jitter: false,
    },
    tenantTokenOptions: {
      apiKeyUid: "uid",
    },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();

    mocks.indexMock.search.mockResolvedValue({
      estimatedTotalHits: 0,
      hits: [],
      processingTimeMs: 0,
    });
    mocks.indexMock.getRawInfo.mockResolvedValue({ primaryKey: "_crocoDocumentId" });
    mocks.indexMock.addDocuments.mockResolvedValue({ taskUid: 1 });
    mocks.indexMock.deleteDocuments.mockResolvedValue({ taskUid: 2 });
    mocks.indexMock.updateSettings.mockResolvedValue({ taskUid: 3 });

    mocks.clientMock.createIndex.mockResolvedValue({ taskUid: 4 });
    mocks.clientMock.deleteIndex.mockResolvedValue({ taskUid: 5 });
    mocks.clientMock.generateTenantToken.mockResolvedValue("token");
    mocks.clientMock.waitForTask.mockResolvedValue({ status: "succeeded" });

    engine = new MeilisearchEngine(options);
  });

  describe("configuration", () => {
    it("fails missing host and API key with stable Problems", () => {
      expect(() => new MeilisearchEngine({ host: "", apiKey: "masterKey" })).toThrow(
        MissingMeilisearchConfigProblem,
      );
      expect(() => new MeilisearchEngine({ host: "http://localhost:7700", apiKey: "" })).toThrow(
        MissingMeilisearchConfigProblem,
      );
    });

    it("constructs the Meilisearch client without exposing configuration in diagnostics", () => {
      expect(mocks.constructorMock).toHaveBeenLastCalledWith({
        apiKey: "masterKey",
        host: "http://localhost:7700",
      });
    });
  });

  describe("caller cancellation", () => {
    it("passes the same AbortSignal to every engine I/O client", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const operations = [
        () => engine.search("index", { query: "test" }, options),
        () => engine.indexDocument("index", { id: "1", tenantId: "tenant-1" }, options),
        () => engine.deleteDocument("index", "1", options),
        () => engine.bulkIndex("index", [{ id: "1", tenantId: "tenant-1" }], options),
        () => engine.createIndex({ name: "index" }, options),
        () => {
          vi.spyOn(Context, "getTenantId").mockReturnValue(null);
          return engine.deleteIndex("index", { ...options, allowGlobalDrop: true });
        },
      ];

      for (const operation of operations) {
        await operation();
        expect(mocks.constructorMock).toHaveBeenLastCalledWith({
          apiKey: "masterKey",
          host: "http://localhost:7700",
          requestConfig: { signal: controller.signal },
        });
      }
    });

    it("rejects every pre-aborted operation before constructing or calling a provider client", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      controller.abort(new Error("request closed"));
      const options = { signal: controller.signal };
      const constructorCalls = mocks.constructorMock.mock.calls.length;
      const operations = [
        () => engine.search("index", { query: "test" }, options),
        () => engine.indexDocument("index", { id: "1", tenantId: "tenant-1" }, options),
        () => engine.deleteDocument("index", "1", options),
        () => engine.bulkIndex("index", [{ id: "1", tenantId: "tenant-1" }], options),
        () => engine.createIndex({ name: "index" }, options),
        () => engine.deleteIndex("index", options),
      ];

      for (const operation of operations) {
        await expect(operation()).rejects.toBeInstanceOf(SearchOperationAbortedProblem);
      }

      expect(mocks.constructorMock).toHaveBeenCalledTimes(constructorCalls);
      expect(mocks.clientMock.index).not.toHaveBeenCalled();
      expect(mocks.clientMock.createIndex).not.toHaveBeenCalled();
      expect(mocks.clientMock.deleteIndex).not.toHaveBeenCalled();
    });

    it("reports in-flight provider cancellation as a stable search Problem", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      const reason = new Error("request closed");
      mocks.indexMock.search.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
              once: true,
            });
          }),
      );

      const search = engine.search("index", { query: "test" }, { signal: controller.signal });
      await vi.waitFor(() => expect(mocks.indexMock.search).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      await expect(search).rejects.toMatchObject({
        code: "search-core/operation-aborted",
        cause: reason,
        extensions: { operation: "search" },
      });
      expect(mocks.constructorMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestConfig: { signal: controller.signal } }),
      );
    });

    it("does not return a successful search after the provider call observes an abort", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      const reason = new Error("request closed");
      mocks.indexMock.search.mockImplementationOnce(async () => {
        controller.abort(reason);
        return { estimatedTotalHits: 0, hits: [], processingTimeMs: 0 };
      });

      await expect(
        engine.search("index", { query: "test" }, { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: "search-core/operation-aborted",
        cause: reason,
        extensions: { operation: "search" },
      });
    });

    it("cancels promptly while task polling is waiting between provider requests", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      const reason = new Error("request closed");
      mocks.clientMock.waitForTask.mockImplementationOnce(() => new Promise(() => {}));

      const indexing = engine.indexDocument(
        "index",
        { id: "1", tenantId: "tenant-1" },
        { signal: controller.signal },
      );
      await vi.waitFor(() => expect(mocks.clientMock.waitForTask).toHaveBeenCalledOnce());
      controller.abort(reason);

      await expect(indexing).rejects.toMatchObject({
        code: "search-core/operation-aborted",
        cause: reason,
        extensions: { operation: "indexDocument" },
      });
    });
  });

  describe("search", () => {
    it("throws MissingTenantProblem if tenantId is missing", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue(null);
      await expect(engine.search("index", { query: "test" })).rejects.toThrow(MissingTenantProblem);
    });

    it("adds tenant filter, query controls, and supported scalar filters", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.search.mockResolvedValue({
        estimatedTotalHits: 1,
        hits: [{ id: "1", title: "Croco" }],
        processingTimeMs: 7,
      });

      const result = await engine.search<{ id: string; title: string }>("index", {
        query: "croco",
        filters: { active: true, price: 10, status: "published" },
        limit: 5,
        offset: 10,
        sort: [{ field: "price", order: "desc" }],
      });

      expect(mocks.clientMock.index).toHaveBeenCalledWith("index");
      expect(mocks.indexMock.search).toHaveBeenCalledWith(
        "croco",
        expect.objectContaining({
          filter: expect.arrayContaining([
            '_tenantId = "tenant-1"',
            "active = true",
            "price = 10",
            'status = "published"',
          ]),
          limit: 5,
          offset: 10,
          sort: ["price:desc"],
        }),
      );
      expect(result).toMatchObject({
        processingTimeMs: 7,
        total: 1,
        hits: [{ document: { id: "1", title: "Croco" } }],
      });
    });

    it("accepts SearchService tenant filters by mapping them to provider tenant isolation", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const searchService = new SearchService({ engine });

      await searchService.search("index", {
        query: "croco",
        filters: { status: "published" },
      });

      const searchOptions = mocks.indexMock.search.mock.calls.at(-1)?.[1] as {
        readonly filter: readonly string[];
      };
      expect(searchOptions.filter).toContain('_tenantId = "tenant-1"');
      expect(searchOptions.filter).toContain('status = "published"');
      expect(searchOptions.filter).not.toContain('tenantId = "tenant-1"');
    });

    it("rejects tenant filters that conflict with the active tenant context", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");

      await expect(
        engine.search("index", {
          query: "test",
          filters: { tenantId: "tenant-2" },
        }),
      ).rejects.toThrow(MeilisearchInvalidRequestProblem);
      await expect(
        engine.search("index", {
          query: "test",
          filters: { _tenantId: "tenant-2" },
        }),
      ).rejects.toThrow(MeilisearchInvalidRequestProblem);

      expect(mocks.indexMock.search).not.toHaveBeenCalled();
    });

    it("escapes quotes and backslashes in string filters and tenant filters", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue('tenant-"one"\\x');

      await engine.search("index", {
        query: "test",
        filters: {
          status: 'active"\\flag',
        },
      });

      expect(mocks.indexMock.search).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({
          filter: expect.arrayContaining([
            '_tenantId = "tenant-\\"one\\"\\\\x"',
            'status = "active\\"\\\\flag"',
          ]),
        }),
      );
    });

    it("rejects unsafe filter and sort fields before sending the search request", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");

      await expect(
        engine.search("index", {
          query: "test",
          filters: { "status OR _tenantId": "active" },
        }),
      ).rejects.toThrow(MeilisearchInvalidRequestProblem);

      await expect(
        engine.search("index", {
          query: "test",
          sort: [{ field: "title;DROP", order: "asc" }],
        }),
      ).rejects.toThrow(MeilisearchInvalidRequestProblem);

      expect(mocks.indexMock.search).not.toHaveBeenCalled();
    });
  });

  describe("index lifecycle", () => {
    it("rejects an index drop without options", async () => {
      await expect(engine.deleteIndex("products")).rejects.toThrow(
        MeilisearchInvalidRequestProblem,
      );
      expect(mocks.clientMock.deleteIndex).not.toHaveBeenCalled();
    });

    it.each([undefined, false, true])(
      "rejects tenant index drops even when allowGlobalDrop is %s",
      async (allowGlobalDrop) => {
        await Context.run({ requestId: "tenant-drop", tenantId: "tenant-a" }, async () => {
          await expect(engine.deleteIndex("products", { allowGlobalDrop })).rejects.toMatchObject({
            code: "search-meilisearch/invalid-request",
            extensions: {
              operation: "deleteIndex",
              indexName: "products",
              upstreamCode: "tenant-index-drop-forbidden",
              retryable: false,
            },
          });
        });

        expect(mocks.clientMock.deleteIndex).not.toHaveBeenCalled();
        expect(mocks.indexMock.deleteDocuments).not.toHaveBeenCalled();
        expect(mocks.clientMock.waitForTask).not.toHaveBeenCalled();
      },
    );

    it("rejects an empty tenant context instead of treating it as system scope", async () => {
      await Context.run({ requestId: "empty-tenant", tenantId: "" }, async () => {
        await expect(engine.deleteIndex("products", { allowGlobalDrop: true })).rejects.toThrow(
          MeilisearchInvalidRequestProblem,
        );
      });

      expect(mocks.clientMock.deleteIndex).not.toHaveBeenCalled();
    });

    it.each([undefined, false])(
      "requires explicit system opt-in when allowGlobalDrop is %s",
      async (allowGlobalDrop) => {
        await expect(engine.deleteIndex("products", { allowGlobalDrop })).rejects.toMatchObject({
          code: "search-meilisearch/invalid-request",
          extensions: {
            operation: "deleteIndex",
            indexName: "products",
            upstreamCode: "global-index-drop-not-authorized",
            retryable: false,
          },
        });

        expect(mocks.clientMock.deleteIndex).not.toHaveBeenCalled();
        expect(mocks.clientMock.waitForTask).not.toHaveBeenCalled();
      },
    );

    it("rejects a truthy non-boolean global-drop opt-in", async () => {
      await expect(
        engine.deleteIndex("products", { allowGlobalDrop: "true" as unknown as boolean }),
      ).rejects.toThrow(MeilisearchInvalidRequestProblem);

      expect(mocks.clientMock.deleteIndex).not.toHaveBeenCalled();
    });

    it("keeps concurrent tenant drops isolated from an explicit system drop", async () => {
      const tenantDrops = ["tenant-a", "tenant-b"].map((tenantId) =>
        Context.run({ requestId: tenantId, tenantId }, async () => {
          await Promise.resolve();
          await expect(engine.deleteIndex("products", { allowGlobalDrop: true })).rejects.toThrow(
            MeilisearchInvalidRequestProblem,
          );
        }),
      );

      await Promise.all([
        ...tenantDrops,
        Context.run({ requestId: "system-drop" }, async () => {
          await Promise.resolve();
          await engine.deleteIndex("retired-index", { allowGlobalDrop: true });
        }),
      ]);

      expect(mocks.clientMock.deleteIndex).toHaveBeenCalledExactlyOnceWith("retired-index");
      expect(mocks.indexMock.deleteDocuments).not.toHaveBeenCalled();
    });

    it("creates indexes with tenant filterability and configured searchable/sortable fields", async () => {
      await engine.createIndex({
        name: "products",
        filterableFields: ["category"],
        searchableFields: ["title"],
        sortableFields: ["price"],
      });

      expect(mocks.clientMock.createIndex).toHaveBeenCalledWith("products", {
        primaryKey: "_crocoDocumentId",
      });
      expect(mocks.indexMock.updateSettings).toHaveBeenCalledWith({
        filterableAttributes: ["_tenantId", "id", "category"],
        searchableAttributes: ["title"],
        sortableAttributes: ["price"],
      });
      expect(mocks.clientMock.waitForTask).toHaveBeenCalledWith(4, {});
      expect(mocks.clientMock.waitForTask).toHaveBeenCalledWith(3, {});
    });

    it("keeps Meilisearch default searchable attributes when searchable fields are omitted", async () => {
      await engine.createIndex({ name: "products" });

      expect(mocks.indexMock.updateSettings).toHaveBeenCalledWith({
        filterableAttributes: ["_tenantId", "id"],
        sortableAttributes: [],
      });
      expect(mocks.indexMock.updateSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({ searchableAttributes: [] }),
      );
    });

    it("deletes indexes only with system opt-in and waits for the provider task", async () => {
      await Context.run({ requestId: "system-drop" }, async () => {
        await engine.deleteIndex("products", { allowGlobalDrop: true });
      });

      expect(mocks.clientMock.deleteIndex).toHaveBeenCalledWith("products");
      expect(mocks.clientMock.waitForTask).toHaveBeenCalledWith(5, {});
    });
  });

  describe("shared index primary keys", () => {
    it("encodes every digest bit using only default tokenizer separators", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("x");
      await engine.indexDocument("shared", { id: "1", tenantId: "x" });
      expect(mocks.indexMock.addDocuments.mock.calls[0][0][0]._crocoDocumentId).toBe(
        "-___--_--_-_--__-__--__-_--_-___-___---_--_-_----__-_-_--___--_-___-_--___-_--_-_----__---_---______--_----_--_--_-__----__-____------__---_--___--__--__---_---_-___-___--__-_--_---------_________----_--__-----_-----__-_____------_-_-_-___---_---_-___--_--",
      );
    });

    it.each(["single", "bulk"])(
      "preserves colliding tenant documents for %s writes",
      async (mode) => {
        const stored = new Map<string, Record<string, unknown>>();
        mocks.indexMock.addDocuments.mockImplementation(async (documents, options) => {
          const primaryKey = options?.primaryKey ?? "id";
          for (const document of documents) {
            stored.set(document[primaryKey], { ...document });
          }
          return { taskUid: 1 };
        });
        const write = async (tenantId: string, title: string) =>
          Context.run({ requestId: tenantId, tenantId }, async () => {
            const document = {
              id: "doc-42",
              tenantId: "forged",
              _crocoDocumentId: "forged",
              title,
            };
            if (mode === "single") await engine.indexDocument("shared", document);
            else await engine.bulkIndex("shared", [document]);
          });
        await Promise.all([write("alpha", "Alpha"), write("beta", "Beta")]);
        expect(stored.size).toBe(2);
        await write("alpha", "Updated");
        expect(stored.size).toBe(2);
        expect([...stored.values()]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "doc-42", _tenantId: "alpha", title: "Updated" }),
            expect.objectContaining({ id: "doc-42", _tenantId: "beta", title: "Beta" }),
          ]),
        );
        for (const key of stored.keys()) expect(key).toMatch(/^[-_]{256}$/);
      },
    );

    it("keeps tuple boundaries and Unicode distinct", async () => {
      for (const [tenantId, id] of [
        ["a___b", "c"],
        ["a", "b___c"],
        ["테넌트", "문서/1"],
      ]) {
        await Context.run({ requestId: "key", tenantId }, () =>
          engine.indexDocument("shared", { id, tenantId }),
        );
      }
      const keys = mocks.indexMock.addDocuments.mock.calls.map(
        ([docs]) => docs[0]._crocoDocumentId,
      );
      expect(new Set(keys).size).toBe(3);
    });

    it.each(["id", "sku", null])(
      "rejects an incompatible existing primary key %s before writing",
      async (primaryKey) => {
        vi.spyOn(Context, "getTenantId").mockReturnValue("alpha");
        mocks.indexMock.getRawInfo.mockResolvedValue({ primaryKey });
        await expect(
          engine.indexDocument("old", { id: "1", tenantId: "alpha" }),
        ).rejects.toMatchObject({
          extensions: { upstreamCode: "incompatible-primary-key" },
        });
        await expect(
          engine.bulkIndex("old", [{ id: "1", tenantId: "alpha" }]),
        ).rejects.toMatchObject({
          extensions: { upstreamCode: "incompatible-primary-key" },
        });
        expect(mocks.indexMock.addDocuments).not.toHaveBeenCalled();
      },
    );

    it("rejects custom primary keys before creating an index", async () => {
      await expect(engine.createIndex({ name: "shared", primaryKey: "sku" })).rejects.toThrow(
        MeilisearchInvalidRequestProblem,
      );
      expect(mocks.clientMock.createIndex).not.toHaveBeenCalled();
    });

    it("returns original ids without provider primary keys", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("alpha");
      mocks.indexMock.search.mockResolvedValue({
        hits: [{ id: "doc-42", _crocoDocumentId: "internal", title: "Alpha" }],
        estimatedTotalHits: 1,
      });
      const result = await engine.search("shared", { query: "", filters: { id: "doc-42" } });
      expect(result.hits[0].document).toEqual({ id: "doc-42", title: "Alpha" });
      expect(mocks.indexMock.search).toHaveBeenCalledWith(
        "",
        expect.objectContaining({ filter: ['id = "doc-42"', '_tenantId = "alpha"'] }),
      );
    });
  });

  describe("document writes", () => {
    it("adds the active tenant to indexed documents and waits for the task", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");

      await engine.indexDocument("products", {
        _tenantId: "forged-tenant",
        id: "1",
        tenantId: "tenant-from-document",
        title: "test",
      });

      expect(mocks.indexMock.addDocuments).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            _tenantId: "tenant-1",
            id: "1",
            tenantId: "tenant-1",
            title: "test",
          }),
        ],
        { primaryKey: "_crocoDocumentId" },
      );
      expect(mocks.clientMock.waitForTask).toHaveBeenCalledWith(1, {});
    });

    it("bulk indexes documents and preserves tenant isolation", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");

      await engine.bulkIndex("products", [
        { id: "1", tenantId: "ignored", title: "One" },
        { id: "2", tenantId: "ignored", title: "Two" },
      ]);

      expect(mocks.indexMock.addDocuments).toHaveBeenCalledWith(
        [
          expect.objectContaining({ _tenantId: "tenant-1", id: "1", tenantId: "tenant-1" }),
          expect.objectContaining({ _tenantId: "tenant-1", id: "2", tenantId: "tenant-1" }),
        ],
        { primaryKey: "_crocoDocumentId" },
      );
    });

    it("treats empty bulk index input as a deterministic no-op", async () => {
      await engine.bulkIndex("products", []);

      expect(mocks.indexMock.addDocuments).not.toHaveBeenCalled();
      expect(mocks.clientMock.waitForTask).not.toHaveBeenCalled();
    });

    it("rejects invalid index and document identifiers", async () => {
      await expect(engine.indexDocument("", { id: "1", tenantId: "tenant-1" })).rejects.toThrow(
        MeilisearchInvalidRequestProblem,
      );
      await expect(
        engine.indexDocument("products", { id: "", tenantId: "tenant-1" }),
      ).rejects.toThrow(MeilisearchInvalidRequestProblem);
    });
  });

  describe("deleteDocument", () => {
    it("deletes by tenant-bound filter and escapes tenant and document ids", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue('tenant-"one"\\x');

      await engine.deleteDocument("index", 'doc-"id"\\x');

      expect(mocks.indexMock.deleteDocuments).toHaveBeenCalledWith({
        filter: '_tenantId = "tenant-\\"one\\"\\\\x" AND id = "doc-\\"id\\"\\\\x"',
      });
      expect(mocks.clientMock.waitForTask).toHaveBeenCalledWith(2, {});
    });
  });

  describe("generateTenantToken", () => {
    it("generates tenant token using escaped tenant search rules", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue('tenant-"one"\\x');

      const token = await engine.generateTenantToken('tenant-"one"\\x');

      expect(mocks.clientMock.generateTenantToken).toHaveBeenCalledWith(
        options.tenantTokenOptions?.apiKeyUid,
        {
          "*": {
            filter: '_tenantId = "tenant-\\"one\\"\\\\x"',
          },
        },
        expect.anything(),
      );
      expect(token).toBe("token");
    });

    it("computes expiresAt when expiresIn is 0", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

      const engineWithZeroExpiresIn = new MeilisearchEngine({
        ...options,
        tenantTokenOptions: {
          apiKeyUid: "uid",
          expiresIn: 0,
        },
      });

      await engineWithZeroExpiresIn.generateTenantToken("tenant-1");

      expect(mocks.clientMock.generateTenantToken).toHaveBeenCalledWith(
        "uid",
        {
          "*": {
            filter: '_tenantId = "tenant-1"',
          },
        },
        {
          expiresAt: new Date(1_700_000_000_000),
        },
      );

      dateNowSpy.mockRestore();
    });

    it("requires an active tenant context before generating a token", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue(null);

      await expect(engine.generateTenantToken("tenant-1")).rejects.toThrow(MissingTenantProblem);
      expect(mocks.clientMock.generateTenantToken).not.toHaveBeenCalled();
    });

    it("rejects tenant ids that differ from the active tenant before generating a token", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");

      const problem = await expectProblem(
        () => engine.generateTenantToken("tenant-2"),
        MeilisearchInvalidRequestProblem,
      );
      expect(problem.extensions).toMatchObject({ upstreamCode: "invalid-tenant-context" });
      expect(mocks.clientMock.generateTenantToken).not.toHaveBeenCalled();
    });

    it("rejects missing token configuration and empty tenant ids", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const engineWithoutTokenConfig = new MeilisearchEngine({
        apiKey: "masterKey",
        host: "http://localhost:7700",
      });

      await expect(engineWithoutTokenConfig.generateTenantToken("tenant-1")).rejects.toMatchObject({
        code: "search-meilisearch/tenant-token-not-configured",
      });
      await expect(engine.generateTenantToken("")).rejects.toThrow(
        MeilisearchInvalidRequestProblem,
      );
    });
  });

  describe("upstream failure normalization", () => {
    it("retries bounded 429 failures for replay-safe searches", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.search.mockRejectedValue(
        createUpstreamError("too many requests", { code: "rate_limited", status: 429 }),
      );

      await expectProblem(
        () => engine.search("products", { query: "croco" }),
        MeilisearchRetryableUpstreamProblem,
      );

      expect(mocks.indexMock.search).toHaveBeenCalledTimes(3);
    });

    it("retries network failures for deterministic document upserts", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.addDocuments
        .mockRejectedValueOnce(createUpstreamError("connection reset", { code: "ECONNRESET" }))
        .mockResolvedValueOnce({ taskUid: 1 });

      await engine.indexDocument("products", { id: "1", tenantId: "tenant-1" });

      expect(mocks.indexMock.addDocuments).toHaveBeenCalledTimes(2);
      expect(mocks.clientMock.waitForTask).toHaveBeenCalledOnce();
    });

    it("retries deterministic document deletes and settings updates", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const transientError = createUpstreamError("connection reset", { code: "ECONNRESET" });
      mocks.indexMock.deleteDocuments
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ taskUid: 2 });

      await engine.deleteDocument("products", "1");

      mocks.indexMock.updateSettings
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce({ taskUid: 3 });

      await engine.createIndex({ name: "products" });

      expect(mocks.indexMock.deleteDocuments).toHaveBeenCalledTimes(2);
      expect(mocks.clientMock.createIndex).toHaveBeenCalledOnce();
      expect(mocks.indexMock.updateSettings).toHaveBeenCalledTimes(2);
    });

    it("retries transient 5xx failures while polling tasks", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.clientMock.waitForTask
        .mockRejectedValueOnce(
          createUpstreamError("temporarily unavailable", { code: "server_error", status: 503 }),
        )
        .mockResolvedValueOnce({ status: "succeeded" });

      await engine.deleteDocument("products", "1");

      expect(mocks.clientMock.waitForTask).toHaveBeenCalledTimes(2);
    });

    it("does not restart the configured task wait after its timeout expires", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.clientMock.waitForTask.mockRejectedValue(
        createUpstreamError("task wait timed out", { name: "MeiliSearchTimeOutError" }),
      );

      await expectProblem(
        () => engine.deleteDocument("products", "1"),
        MeilisearchRetryableUpstreamProblem,
      );

      expect(mocks.clientMock.waitForTask).toHaveBeenCalledOnce();
    });

    it("attempts terminal upstream failures only once", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.search.mockRejectedValue(
        createUpstreamError("invalid key", { code: "invalid_api_key", status: 401 }),
      );

      await expectProblem(
        () => engine.search("products", { query: "croco" }),
        MeilisearchTerminalUpstreamProblem,
      );

      expect(mocks.indexMock.search).toHaveBeenCalledOnce();
    });

    it("does not retry after the caller aborts a replay-safe operation", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      const reason = new Error("request closed");
      mocks.indexMock.search.mockImplementationOnce(async () => {
        controller.abort(reason);
        throw createUpstreamError("temporarily unavailable", { status: 503 });
      });

      await expect(
        engine.search("products", { query: "croco" }, { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: "search-core/operation-aborted",
        cause: reason,
        extensions: { operation: "search" },
      });
      expect(mocks.indexMock.search).toHaveBeenCalledOnce();
    });

    it("does not start task polling after a completed write observes an abort", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const controller = new AbortController();
      const reason = new Error("request closed");
      mocks.indexMock.addDocuments.mockImplementationOnce(async () => {
        controller.abort(reason);
        return { taskUid: 1 };
      });

      await expect(
        engine.indexDocument(
          "products",
          { id: "1", tenantId: "tenant-1" },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({
        code: "search-core/operation-aborted",
        cause: reason,
        extensions: { operation: "indexDocument" },
      });
      expect(mocks.clientMock.waitForTask).not.toHaveBeenCalled();
    });

    it("does not retry operations outside the replay-safe allowlist", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      const transientError = createUpstreamError("temporarily unavailable", { status: 503 });
      mocks.clientMock.createIndex.mockRejectedValue(transientError);
      mocks.clientMock.deleteIndex.mockRejectedValue(transientError);
      mocks.clientMock.generateTenantToken.mockRejectedValue(transientError);

      await expectProblem(
        () => engine.createIndex({ name: "products" }),
        MeilisearchRetryableUpstreamProblem,
      );
      await expectProblem(() => {
        vi.spyOn(Context, "getTenantId").mockReturnValue(null);
        return engine.deleteIndex("products", { allowGlobalDrop: true });
      }, MeilisearchRetryableUpstreamProblem);
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      await expectProblem(
        () => engine.generateTenantToken("tenant-1"),
        MeilisearchRetryableUpstreamProblem,
      );

      expect(mocks.clientMock.createIndex).toHaveBeenCalledOnce();
      expect(mocks.clientMock.deleteIndex).toHaveBeenCalledOnce();
      expect(mocks.clientMock.generateTenantToken).toHaveBeenCalledOnce();
    });

    it("normalizes retryable upstream failures and redacts sensitive error details", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.search.mockRejectedValue(
        createUpstreamError(SECRET_RICH_ERROR_MESSAGE, {
          code: "temporarily_unavailable",
          status: 503,
        }),
      );

      const problem = await expectProblem(
        () => engine.search("products", { query: "croco" }),
        MeilisearchRetryableUpstreamProblem,
      );

      expect(problem.detail).toContain("search");
      expect(problem.detail).not.toContain(SECRET_SAMPLE);
      expect(problem.extensions).toMatchObject({
        operation: "search",
        retryable: true,
        upstreamStatus: 503,
      });
    });

    it("normalizes terminal upstream failures", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.search.mockRejectedValue(
        createUpstreamError("invalid key", { code: "invalid_api_key", status: 401 }),
      );

      const problem = await expectProblem(
        () => engine.search("products", { query: "croco" }),
        MeilisearchTerminalUpstreamProblem,
      );

      expect(problem.extensions).toMatchObject({
        operation: "search",
        retryable: false,
        upstreamStatus: 401,
      });
    });

    it("normalizes index-not-found upstream failures", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.search.mockRejectedValue(
        createUpstreamError("index not found", { code: "index_not_found", status: 404 }),
      );

      await expectProblem(
        () => engine.search("products", { query: "croco" }),
        MeilisearchIndexNotFoundProblem,
      );
    });

    it("normalizes failed async tasks through the same Problem taxonomy", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.clientMock.waitForTask.mockResolvedValueOnce({
        error: { code: "index_not_found", message: "index not found" },
        status: "failed",
      });

      await expectProblem(
        () => engine.indexDocument("products", { id: "1", tenantId: "tenant-1" }),
        MeilisearchIndexNotFoundProblem,
      );
    });

    it("rejects canceled document tasks with document context", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.clientMock.waitForTask.mockResolvedValueOnce({
        error: null,
        status: "canceled",
      });

      await expect(
        engine.indexDocument("products", { id: "document-1", tenantId: "tenant-1" }),
      ).rejects.toMatchObject({
        code: "search-meilisearch/task-canceled",
        extensions: {
          documentId: "document-1",
          indexName: "products",
          operation: "indexDocument",
          provider: "meilisearch",
          retryable: false,
        },
      });
    });

    it("rejects canceled index tasks with index context", async () => {
      mocks.clientMock.waitForTask.mockResolvedValueOnce({
        error: null,
        status: "canceled",
      });

      await expect(engine.deleteIndex("products", { allowGlobalDrop: true })).rejects.toMatchObject(
        {
          code: "search-meilisearch/task-canceled",
          extensions: {
            indexName: "products",
            operation: "deleteIndex",
            provider: "meilisearch",
            retryable: false,
          },
        },
      );
    });

    it("fails malformed async task responses while task waiting is enabled", async () => {
      vi.spyOn(Context, "getTenantId").mockReturnValue("tenant-1");
      mocks.indexMock.addDocuments.mockResolvedValueOnce({});

      await expectProblem(
        () => engine.indexDocument("products", { id: "1", tenantId: "tenant-1" }),
        MeilisearchInvalidRequestProblem,
      );

      expect(mocks.clientMock.waitForTask).not.toHaveBeenCalled();
    });
  });
});
