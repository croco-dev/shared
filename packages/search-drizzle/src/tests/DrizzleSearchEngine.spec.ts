import { Container, Context } from "@croco/framework-context";
import {
  SearchCapabilityUnavailableProblem,
  SearchOperationAbortedProblem,
  StrategyUnavailableProblem,
} from "@croco/search-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { DrizzleSearchEngine } from "../libs/DrizzleSearchEngine";
import { BulkIndexChunkFailedProblem } from "../libs/problems/BulkIndexProblems";
import { InvalidSearchRowProblem } from "../libs/problems/InvalidSearchRowProblem";
import { PgSearchStrategy } from "../libs/strategies/PgSearchStrategy";
import type { SearchStrategy } from "../libs/types";

// Mock external dependencies
vi.mock("@croco/framework-context", async () => {
  const actual = await vi.importActual("@croco/framework-context");
  return {
    ...actual,
    Context: {
      getTenantId: vi.fn(),
    },
  };
});

// Mock Strategy
const mockStrategy = {
  buildSearchQuery: vi.fn(),
  buildIndexQuery: vi.fn(),
  buildDeleteQuery: vi.fn(),
  getRequiredExtensions: vi.fn(),
  checkCapability: vi.fn(),
  getCapabilities: vi.fn(),
  mapSearchRow: vi.fn(),
};

const strategy = mockStrategy as unknown as SearchStrategy;

const executeMock = vi.fn();
const mockRowsSql = { toSQL: () => ({ sql: "SELECT 1", params: [] }) };
const mockTotalSql = { toSQL: () => ({ sql: "SELECT COUNT(*)", params: [] }) };

// Mock DB
const mockDb = {
  execute: executeMock,
} as unknown as NodePgDatabase<Record<string, never>>;

describe("DrizzleSearchEngine", () => {
  let engine!: DrizzleSearchEngine;

  beforeEach(() => {
    Container.reset();
    vi.clearAllMocks();
    Container.reset();

    // Default setups
    (Context.getTenantId as Mock).mockReturnValue("tenant-123");
    mockStrategy.checkCapability.mockResolvedValue(true);
    mockStrategy.getCapabilities.mockReturnValue({
      fullText: true,
      fuzzy: false,
      highlight: false,
    });
    mockStrategy.mapSearchRow.mockReset();
    executeMock.mockReset();

    // Mock SQL return
    mockStrategy.buildSearchQuery.mockReturnValue({ rows: mockRowsSql, total: mockTotalSql });
    mockStrategy.buildIndexQuery.mockReturnValue(mockRowsSql);
    mockStrategy.buildDeleteQuery.mockReturnValue(mockRowsSql);

    executeMock.mockImplementation(async (query) =>
      query === mockTotalSql ? { rows: [{ total: 0 }] } : { rows: [] },
    );
  });

  it("should check capability on first use", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await engine.search("users", { query: "test" });

    expect(mockStrategy.checkCapability).toHaveBeenCalledWith(mockDb);
  });

  it("should throw StrategyUnavailableProblem if capability check fails", async () => {
    mockStrategy.checkCapability.mockResolvedValue(false);
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.search("users", { query: "test" })).rejects.toThrow(
      StrategyUnavailableProblem,
    );
  });

  it("should retry capability checks after a transient failure", async () => {
    mockStrategy.checkCapability.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.search("users", { query: "test" })).rejects.toThrow(
      StrategyUnavailableProblem,
    );

    await expect(engine.search("users", { query: "test" })).resolves.toEqual({
      hits: [],
      total: 0,
      query: { query: "test" },
      processingTimeMs: 0,
    });

    expect(mockStrategy.checkCapability).toHaveBeenCalledTimes(2);
  });

  it("should use tenantId from Context in search", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await engine.search("users", { query: "test" });

    expect(Context.getTenantId).toHaveBeenCalled();
    expect(mockStrategy.buildSearchQuery).toHaveBeenCalledWith(
      "users",
      { query: "test" },
      "tenant-123",
    );
  });

  it("should preserve zero score from search result", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: "doc-1", __croco_search_score: 0 }],
      rowCount: 1,
    });

    engine = new DrizzleSearchEngine(mockDb, strategy);
    const result = await engine.search<{ id: string }>("users", { query: "test" });

    expect(result.hits[0]?.score).toBe(0);
  });

  it("should normalize numeric string scores without replacing document fields", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: "doc-1", score: 42, __croco_search_score: "0.625" }],
      rowCount: 1,
    });

    engine = new DrizzleSearchEngine(mockDb, strategy);
    const result = await engine.search<{ id: string; score: number }>("users", { query: "test" });

    expect(result.hits[0]?.score).toBe(0.625);
    expect(result.hits[0]?.document).toEqual({ id: "doc-1", score: 42 });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["blank", ""],
    ["whitespace-only", "   "],
    ["non-numeric", "not-a-number"],
    ["NaN", Number.NaN],
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["non-finite string", "Infinity"],
  ])("should reject %s score data", async (_case, score) => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: "doc-1", __croco_search_score: score }],
      rowCount: 1,
    });

    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.search("users", { query: "test" })).rejects.toMatchObject({
      code: "SEARCH_DRIZZLE_INVALID_ROW",
    });
    expect(mockStrategy.mapSearchRow).not.toHaveBeenCalled();
  });

  it("should return the full matching total for a partial page", async () => {
    executeMock
      .mockResolvedValueOnce({
        rows: [{ id: "doc-2", __croco_search_score: 0.8 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ total: 3 }],
        rowCount: 1,
      });

    engine = new DrizzleSearchEngine(mockDb, strategy);
    const result = await engine.search("users", { query: "test", limit: 1, offset: 1 });

    expect(result.total).toBe(3);
    expect(result.hits).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("should retain the full matching total for an empty page beyond the last result", async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: 3 }], rowCount: 1 });

    engine = new DrizzleSearchEngine(mockDb, strategy);
    const result = await engine.search("users", { query: "test", limit: 1, offset: 10 });

    expect(result).toMatchObject({ hits: [], total: 3 });
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    0,
    123,
    Number.MAX_SAFE_INTEGER,
    "0",
    "123",
    "9007199254740991",
    BigInt("0"),
    BigInt("123"),
    BigInt("9007199254740991"),
  ])("should normalize safe total count %s", async (total) => {
    executeMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total }] });

    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.search("users", { query: "test" })).resolves.toMatchObject({
      hits: [],
      total: Number(total),
    });
  });

  it.each([
    undefined,
    null,
    true,
    false,
    {},
    [],
    "",
    "   ",
    "abc",
    "0x10",
    "1e2",
    "1.0",
    "1.0000000000000001",
    -1,
    "-1",
    BigInt("-1"),
    1.5,
    "1.5",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "Infinity",
    Number.MAX_SAFE_INTEGER + 1,
    "9007199254740992",
    BigInt("9007199254740992"),
  ])("should reject malformed total count %s", async (total) => {
    executeMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total }] });

    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.search("users", { query: "test" })).rejects.toThrow(
      "Invalid search row: expected a non-negative safe integer total",
    );
  });

  it("should throw when search returns non-object rows", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [null],
      rowCount: 1,
    });

    engine = new DrizzleSearchEngine(mockDb, strategy);

    const searchPromise = engine.search("users", { query: "test" });

    await expect(searchPromise).rejects.toBeInstanceOf(InvalidSearchRowProblem);
    await expect(searchPromise).rejects.toThrow("Invalid search row: expected object result");
  });

  it("should map search rows through strategy mapper when provided", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: "doc-1", title: "raw title", __croco_search_score: 0.8 }],
      rowCount: 1,
    });

    mockStrategy.mapSearchRow = vi.fn().mockImplementation((row) => ({
      id: row.id,
      title: String(row.title).toUpperCase(),
    }));

    engine = new DrizzleSearchEngine(mockDb, strategy);
    const result = await engine.search<{ id: string; title: string }>("users", { query: "test" });

    expect(mockStrategy.mapSearchRow).toHaveBeenCalledWith({
      id: "doc-1",
      title: "raw title",
    });
    expect(result.hits[0]?.document).toEqual({ id: "doc-1", title: "RAW TITLE" });
    expect(result.hits[0]?.score).toBe(0.8);
  });

  it("should delegate indexDocument to strategy", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const doc = { id: "1", tenantId: "tenant-123", title: "hello" };

    await engine.indexDocument("users", doc);

    expect(mockStrategy.buildIndexQuery).toHaveBeenCalledWith("users", doc, "tenant-123");
    expect(executeMock).toHaveBeenCalled();
  });

  it("should delegate deleteDocument to strategy", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await engine.deleteDocument("users", "1");

    expect(mockStrategy.buildDeleteQuery).toHaveBeenCalledWith("users", "1", "tenant-123");
    expect(executeMock).toHaveBeenCalled();
  });

  it("should preserve the per-document strategy fallback for custom strategies", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const documents = [
      { id: "1", tenantId: "tenant-123" },
      { id: "2", tenantId: "tenant-123" },
    ];
    const options = { signal: new AbortController().signal };

    await engine.bulkIndex("users", documents, options);

    expect(mockStrategy.buildIndexQuery).toHaveBeenNthCalledWith(
      1,
      "users",
      documents[0],
      "tenant-123",
    );
    expect(mockStrategy.buildIndexQuery).toHaveBeenNthCalledWith(
      2,
      "users",
      documents[1],
      "tenant-123",
    );
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("should batch built-in bulk indexing into fewer database statements than documents", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ supported: true }] })
      .mockResolvedValue({ rows: [] });
    const db = { execute } as unknown as NodePgDatabase<Record<string, never>>;
    const builtInEngine = new DrizzleSearchEngine(db, new PgSearchStrategy());

    await builtInEngine.bulkIndex("users", [
      { id: "1", tenantId: "tenant-123", title: "First" },
      { id: "2", tenantId: "tenant-123", title: "Second" },
      { id: "3", tenantId: "tenant-123", title: "Third" },
    ]);

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("should execute all built-in bulk chunks in one transaction when supported", async () => {
    const capabilityExecute = vi.fn().mockResolvedValue({ rows: [{ supported: true }] });
    const transactionExecute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (run) => run({ execute: transactionExecute }));
    const db = { execute: capabilityExecute, transaction } as unknown as NodePgDatabase<
      Record<string, never>
    >;
    const builtInEngine = new DrizzleSearchEngine(db, new PgSearchStrategy());

    await builtInEngine.bulkIndex(
      "users",
      Array.from({ length: 101 }, (_, index) => ({
        id: String(index),
        tenantId: "tenant-123",
        title: `Document ${index}`,
      })),
    );

    expect(capabilityExecute).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionExecute).toHaveBeenCalledTimes(2);
  });

  it("should observe an abort while the transaction commit is pending", async () => {
    const controller = new AbortController();
    const capabilityExecute = vi.fn().mockResolvedValue({ rows: [{ supported: true }] });
    const transactionExecute = vi.fn().mockResolvedValue({ rows: [] });
    const transaction = vi.fn(async (run) => {
      const result = await run({ execute: transactionExecute });
      controller.abort(new Error("request closed during commit"));
      return result;
    });
    const db = { execute: capabilityExecute, transaction } as unknown as NodePgDatabase<
      Record<string, never>
    >;
    const builtInEngine = new DrizzleSearchEngine(db, new PgSearchStrategy());

    await expect(
      builtInEngine.bulkIndex("users", [{ id: "1", tenantId: "tenant-123" }], {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "search-core/operation-aborted",
      extensions: { operation: "bulkIndex" },
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionExecute).toHaveBeenCalledOnce();
  });

  it("should attribute a transactional chunk failure without reporting committed documents", async () => {
    const storageError = new Error("storage rejected secret-document-id");
    const capabilityExecute = vi.fn().mockResolvedValue({ rows: [{ supported: true }] });
    const transactionExecute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(storageError);
    const transaction = vi.fn(async (run) => run({ execute: transactionExecute }));
    const db = { execute: capabilityExecute, transaction } as unknown as NodePgDatabase<
      Record<string, never>
    >;
    const builtInEngine = new DrizzleSearchEngine(db, new PgSearchStrategy());

    const operation = builtInEngine.bulkIndex(
      "users",
      Array.from({ length: 101 }, (_, index) => ({
        id: index === 100 ? "secret-document-id" : String(index),
        tenantId: "tenant-123",
      })),
    );

    await expect(operation).rejects.toBeInstanceOf(BulkIndexChunkFailedProblem);
    await expect(operation).rejects.toMatchObject({
      cause: storageError,
      extensions: {
        chunkIndex: 1,
        failedDocumentIndexes: [100],
        committedDocumentIndexes: [],
        transactional: true,
      },
    });
    await expect(operation).rejects.not.toHaveProperty("extensions.failedDocumentIds");
  });

  it("should report committed positions after a non-transactional chunk failure", async () => {
    const storageError = new Error("second chunk failed");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ supported: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(storageError);
    const db = { execute } as unknown as NodePgDatabase<Record<string, never>>;
    const builtInEngine = new DrizzleSearchEngine(db, new PgSearchStrategy());

    await expect(
      builtInEngine.bulkIndex(
        "users",
        Array.from({ length: 101 }, (_, index) => ({
          id: String(index),
          tenantId: "tenant-123",
        })),
      ),
    ).rejects.toMatchObject({
      cause: storageError,
      extensions: {
        chunkIndex: 1,
        failedDocumentIndexes: [100],
        committedDocumentIndexes: Array.from({ length: 100 }, (_, index) => index),
        transactional: false,
      },
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("should preserve an empty bulk index as a tenant-independent no-op", async () => {
    (Context.getTenantId as Mock).mockReturnValue(undefined);
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.bulkIndex("users", [])).resolves.toBeUndefined();

    expect(mockStrategy.checkCapability).toHaveBeenCalledOnce();
    expect(Context.getTenantId).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("should reject every pre-aborted operation before capability or database I/O", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const controller = new AbortController();
    controller.abort(new Error("request closed"));
    const options = { signal: controller.signal };
    const operations = [
      () => engine.search("users", { query: "test" }, options),
      () => engine.indexDocument("users", { id: "1", tenantId: "tenant-123" }, options),
      () => engine.deleteDocument("users", "1", options),
      () => engine.bulkIndex("users", [{ id: "1", tenantId: "tenant-123" }], options),
      () => engine.createIndex({ name: "users" }, options),
      () => engine.deleteIndex("users", options),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(SearchOperationAbortedProblem);
    }

    expect(mockStrategy.checkCapability).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("should stop bulk indexing before the next database write after abort", async () => {
    const controller = new AbortController();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ supported: true }] })
      .mockImplementationOnce(async () => {
        controller.abort(new Error("request closed"));
        return { rows: [] };
      });
    const db = { execute } as unknown as NodePgDatabase<Record<string, never>>;
    const builtInEngine = new DrizzleSearchEngine(db, new PgSearchStrategy());

    await expect(
      builtInEngine.bulkIndex(
        "users",
        Array.from({ length: 101 }, (_, index) => ({
          id: String(index),
          tenantId: "tenant-123",
        })),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: "search-core/operation-aborted",
      extensions: { operation: "bulkIndex" },
    });

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("should not execute the total query when the hit query observes an abort", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const controller = new AbortController();
    const reason = new Error("request closed");
    executeMock.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { rows: [], rowCount: 0 };
    });

    await expect(
      engine.search("users", { query: "test" }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "search-core/operation-aborted",
      cause: reason,
      extensions: { operation: "search" },
    });
    expect(executeMock).toHaveBeenCalledOnce();
  });

  it("should not execute the total query when row mapping aborts the search", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const controller = new AbortController();
    const reason = new Error("request closed");
    executeMock.mockResolvedValueOnce({ rows: [{ id: "doc-1", __croco_search_score: 0.8 }] });
    mockStrategy.mapSearchRow.mockImplementationOnce(() => {
      controller.abort(reason);
      return { id: "doc-1" };
    });

    await expect(
      engine.search("users", { query: "test" }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "search-core/operation-aborted",
      cause: reason,
      extensions: { operation: "search" },
    });
    expect(executeMock).toHaveBeenCalledOnce();
  });

  it("should not return a successful search when the total query observes an abort", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const controller = new AbortController();
    const reason = new Error("request closed");
    executeMock.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(async () => {
      controller.abort(reason);
      return { rows: [{ total: 0 }] };
    });

    await expect(
      engine.search("users", { query: "test" }, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "search-core/operation-aborted",
      cause: reason,
      extensions: { operation: "search" },
    });
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("should reject every database operation aborted during its final write", async () => {
    const operations = [
      {
        operation: "indexDocument",
        run: (options: { signal: AbortSignal }) =>
          engine.indexDocument("users", { id: "1", tenantId: "tenant-123" }, options),
      },
      {
        operation: "deleteDocument",
        run: (options: { signal: AbortSignal }) => engine.deleteDocument("users", "1", options),
      },
      {
        operation: "bulkIndex",
        run: (options: { signal: AbortSignal }) =>
          engine.bulkIndex("users", [{ id: "1", tenantId: "tenant-123" }], options),
      },
    ] as const;

    for (const { operation, run } of operations) {
      engine = new DrizzleSearchEngine(mockDb, strategy);
      const controller = new AbortController();
      const reason = new Error("request closed");
      executeMock.mockImplementationOnce(async () => {
        controller.abort(reason);
        return { rows: [] };
      });

      await expect(run({ signal: controller.signal })).rejects.toMatchObject({
        code: "search-core/operation-aborted",
        cause: reason,
        extensions: { operation },
      });
    }
  });

  it("should preserve a successful shared capability check when one caller aborts", async () => {
    let resolveCapability: ((value: boolean) => void) | undefined;
    const capability = new Promise<boolean>((resolve) => {
      resolveCapability = resolve;
    });
    mockStrategy.checkCapability.mockReturnValueOnce(capability);
    engine = new DrizzleSearchEngine(mockDb, strategy);
    const controller = new AbortController();

    const cancelledSearch = engine.search(
      "users",
      { query: "cancelled" },
      { signal: controller.signal },
    );
    const activeSearch = engine.search("users", { query: "active" });
    await vi.waitFor(() => expect(mockStrategy.checkCapability).toHaveBeenCalledOnce());
    controller.abort(new Error("request closed"));
    resolveCapability?.(true);

    await expect(cancelledSearch).rejects.toBeInstanceOf(SearchOperationAbortedProblem);
    await expect(activeSearch).resolves.toMatchObject({ total: 0 });
    await expect(engine.search("users", { query: "later" })).resolves.toMatchObject({ total: 0 });
    expect(mockStrategy.checkCapability).toHaveBeenCalledOnce();
  });

  it("should fail fast for unsupported createIndex capability", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(
      engine.createIndex({
        name: "users",
      }),
    ).rejects.toBeInstanceOf(SearchCapabilityUnavailableProblem);
  });

  it("should fail fast for unsupported deleteIndex capability", async () => {
    engine = new DrizzleSearchEngine(mockDb, strategy);

    await expect(engine.deleteIndex("users")).rejects.toBeInstanceOf(
      SearchCapabilityUnavailableProblem,
    );
  });
});
