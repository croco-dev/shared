import { Component, Context, Inject } from "@croco/framework-context";
import {
  type IndexConfig,
  MissingTenantProblem,
  SearchCapabilityUnavailableProblem,
  type SearchDocument,
  SearchEngine,
  type SearchEngineCapabilities,
  type SearchOperation,
  type SearchOperationOptions,
  type SearchQuery,
  type SearchResult,
  StrategyUnavailableProblem,
  throwIfSearchOperationAborted,
} from "@croco/search-core";
import { BulkIndexChunkFailedProblem } from "./problems/BulkIndexProblems";
import { InvalidSearchRowProblem } from "./problems/InvalidSearchRowProblem";
import { SEARCH_SCORE_ALIAS } from "./searchScore";
import {
  type BulkIndexQueryPlan,
  DRIZZLE_TOKEN,
  type DrizzleSearchDatabase,
  type SearchResultRow,
  type SearchStrategy,
} from "./types";

function isSearchResultRow(value: unknown): value is SearchResultRow {
  return typeof value === "object" && value !== null;
}

const NUMERIC_SCORE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseSearchScore(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (NUMERIC_SCORE_PATTERN.test(normalized)) {
      const score = Number(normalized);
      if (Number.isFinite(score)) {
        return score;
      }
    }
  }

  throw new InvalidSearchRowProblem("expected score as a finite number or numeric string");
}

function readSearchTotal(rows: readonly unknown[]): number {
  const row = rows[0];
  if (!isSearchResultRow(row)) {
    throw new InvalidSearchRowProblem("expected total count result");
  }

  const rawTotal = row.total;
  const total =
    typeof rawTotal === "bigint" || (typeof rawTotal === "string" && /^\d+$/.test(rawTotal))
      ? Number(rawTotal)
      : rawTotal;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new InvalidSearchRowProblem("expected a non-negative safe integer total");
  }

  return total;
}

/**
 * PostgreSQL 검색 전략을 사용해 문서 검색을 수행하는 Drizzle 검색 엔진입니다.
 */
@Component()
export class DrizzleSearchEngine extends SearchEngine {
  private capabilityCheck: Promise<void> | null = null;

  /**
   * Drizzle DB와 검색 전략을 받아 검색 엔진을 초기화합니다.
   */
  constructor(
    @Inject(DRIZZLE_TOKEN) private readonly db: DrizzleSearchDatabase,
    private readonly strategy: SearchStrategy,
  ) {
    super();
  }

  /**
   * 현재 전략이 제공하는 검색 기능을 반환합니다.
   */
  get capabilities(): SearchEngineCapabilities {
    return this.strategy.getCapabilities();
  }

  /**
   * 인덱스와 쿼리를 받아 검색 결과를 반환합니다.
   */
  async search<T>(
    index: string,
    query: SearchQuery,
    options: SearchOperationOptions = {},
  ): Promise<SearchResult<T>> {
    await this.ensureCapable("search", options);
    const tenantId = this.getTenantId("search");

    const plan = this.strategy.buildSearchQuery(index, query, tenantId);
    throwIfSearchOperationAborted("search", options);
    const result = await this.db.execute(plan.rows);
    throwIfSearchOperationAborted("search", options);

    const hits = result.rows.map((row) => {
      if (!isSearchResultRow(row)) {
        throw new InvalidSearchRowProblem();
      }

      const { [SEARCH_SCORE_ALIAS]: rawScore, ...documentRow } = row;
      const score = parseSearchScore(rawScore);
      const mappedDocument =
        this.strategy.mapSearchRow?.<T>(documentRow) ?? (documentRow as unknown as T);

      return {
        score,
        document: mappedDocument,
      };
    });

    throwIfSearchOperationAborted("search", options);
    const totalResult = await this.db.execute(plan.total);
    throwIfSearchOperationAborted("search", options);

    return {
      hits,
      total: readSearchTotal(totalResult.rows),
      query,
      processingTimeMs: 0,
    };
  }

  /**
   * 단일 문서를 인덱스에 저장합니다.
   */
  async indexDocument(
    index: string,
    document: SearchDocument,
    options: SearchOperationOptions = {},
  ): Promise<void> {
    await this.ensureCapable("indexDocument", options);
    const tenantId = this.getTenantId("indexDocument");

    const sql = this.strategy.buildIndexQuery(index, document, tenantId);
    throwIfSearchOperationAborted("indexDocument", options);
    await this.db.execute(sql);
    throwIfSearchOperationAborted("indexDocument", options);
  }

  /**
   * 문서 ID로 인덱스에서 문서를 삭제합니다.
   */
  async deleteDocument(
    index: string,
    documentId: string,
    options: SearchOperationOptions = {},
  ): Promise<void> {
    await this.ensureCapable("deleteDocument", options);
    const tenantId = this.getTenantId("deleteDocument");

    const sql = this.strategy.buildDeleteQuery(index, documentId, tenantId);
    throwIfSearchOperationAborted("deleteDocument", options);
    await this.db.execute(sql);
    throwIfSearchOperationAborted("deleteDocument", options);
  }

  /**
   * 여러 문서를 bounded SQL chunk로 인덱싱합니다.
   */
  async bulkIndex(
    index: string,
    documents: SearchDocument[],
    options: SearchOperationOptions = {},
  ): Promise<void> {
    await this.ensureCapable("bulkIndex", options);
    if (documents.length === 0) {
      return;
    }

    const tenantId = this.getTenantId("bulkIndex");
    const plans = this.buildBulkIndexQueryPlans(index, documents, tenantId);

    if (typeof this.db.transaction === "function") {
      await this.db.transaction(async (transaction) => {
        await this.executeBulkIndexQueryPlans(transaction, plans, options, true);
      });
      throwIfSearchOperationAborted("bulkIndex", options);
      return;
    }

    await this.executeBulkIndexQueryPlans(this.db, plans, options, false);
  }

  /**
   * Drizzle 검색 엔진에서 지원하지 않는 인덱스 생성 API입니다.
   */
  async createIndex(_config: IndexConfig, options: SearchOperationOptions = {}): Promise<void> {
    await this.ensureCapable("createIndex", options);
    throw new SearchCapabilityUnavailableProblem("createIndex", "DrizzleSearchEngine");
  }

  /**
   * Drizzle 검색 엔진에서 지원하지 않는 인덱스 삭제 API입니다.
   */
  async deleteIndex(_name: string, options: SearchOperationOptions = {}): Promise<void> {
    await this.ensureCapable("deleteIndex", options);
    throw new SearchCapabilityUnavailableProblem("deleteIndex", "DrizzleSearchEngine");
  }

  private async checkStrategy(): Promise<void> {
    const isCapable = await this.strategy.checkCapability(this.db);
    if (!isCapable) {
      throw new StrategyUnavailableProblem(
        this.strategy.constructor.name,
        `Database does not support required extensions: ${this.strategy.getRequiredExtensions().join(", ")}`,
      );
    }
  }

  private buildBulkIndexQueryPlans(
    index: string,
    documents: readonly SearchDocument[],
    tenantId: string,
  ): readonly BulkIndexQueryPlan[] {
    if (this.strategy.buildBulkIndexQueryPlans) {
      return this.strategy.buildBulkIndexQueryPlans(index, documents, tenantId);
    }

    return documents.map((document, documentIndex) => ({
      query: this.strategy.buildIndexQuery(index, document, tenantId),
      documentIndexes: [documentIndex],
    }));
  }

  private async executeBulkIndexQueryPlans(
    executor: Pick<DrizzleSearchDatabase, "execute">,
    plans: readonly BulkIndexQueryPlan[],
    options: SearchOperationOptions,
    transactional: boolean,
  ): Promise<void> {
    const committedDocumentIndexes: number[] = [];

    for (const [chunkIndex, plan] of plans.entries()) {
      throwIfSearchOperationAborted("bulkIndex", options);
      try {
        await executor.execute(plan.query);
      } catch (error) {
        throwIfSearchOperationAborted("bulkIndex", options);
        throw new BulkIndexChunkFailedProblem(
          chunkIndex,
          plan.documentIndexes,
          transactional ? [] : committedDocumentIndexes,
          transactional,
          error,
        );
      }
      throwIfSearchOperationAborted("bulkIndex", options);
      committedDocumentIndexes.push(...plan.documentIndexes);
    }
  }

  private async ensureCapable(
    operation: SearchOperation,
    options: SearchOperationOptions,
  ): Promise<void> {
    throwIfSearchOperationAborted(operation, options);
    try {
      if (!this.capabilityCheck) {
        this.capabilityCheck = this.checkStrategy();
      }

      await this.capabilityCheck;
    } catch (error) {
      this.capabilityCheck = null;
      throwIfSearchOperationAborted(operation, options);

      if (error instanceof StrategyUnavailableProblem) {
        throw error;
      }
      throw new StrategyUnavailableProblem(this.strategy.constructor.name, String(error));
    }
    throwIfSearchOperationAborted(operation, options);
  }

  private getTenantId(operation: string): string {
    const tenantId = Context.getTenantId();
    if (!tenantId) {
      throw new MissingTenantProblem(operation);
    }
    return tenantId;
  }
}
