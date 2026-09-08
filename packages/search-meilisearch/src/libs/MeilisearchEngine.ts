import { createHash } from "node:crypto";
import { Component, Context } from "@croco/framework-context";
import type { RetryPolicy } from "@croco/retry-core";
import { RetryTemplate } from "@croco/retry-core";
import type {
  IndexConfig,
  SearchDocument,
  SearchEngineCapabilities,
  SearchOperation,
  SearchOperationOptions,
  SearchQuery,
  SearchResult,
} from "@croco/search-core";
import {
  MissingTenantProblem,
  SearchEngine,
  SearchOperationAbortedProblem,
  throwIfSearchOperationAborted,
} from "@croco/search-core";
import { MeiliSearch } from "meilisearch";
import { validateMeilisearchOptions } from "./MeilisearchConfig";
import {
  MeilisearchInvalidRequestProblem,
  MeilisearchRetryableUpstreamProblem,
  MeilisearchTaskCanceledProblem,
  normalizeMeilisearchError,
  TenantTokenNotConfiguredProblem,
} from "./problems/MeilisearchProblems";
import type { MeilisearchDeleteIndexOptions, MeilisearchEngineOptions } from "./types";

const DOCUMENT_PRIMARY_KEY = "_crocoDocumentId";

const MEILISEARCH_RETRY_POLICY: RetryPolicy = {
  shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
    return attempt < maxAttempts && error instanceof MeilisearchRetryableUpstreamProblem;
  },
};

const MEILISEARCH_TASK_WAIT_RETRY_POLICY: RetryPolicy = {
  shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
    return (
      attempt < maxAttempts &&
      error instanceof MeilisearchRetryableUpstreamProblem &&
      error.extensions?.upstreamCode !== "MeiliSearchTimeOutError"
    );
  },
};

@Component()
/**
 * 테넌트 격리와 테넌트 토큰 발급을 지원하는 Meilisearch 검색 엔진입니다.
 */
export class MeilisearchEngine extends SearchEngine {
  private readonly client: MeiliSearch;
  private static readonly FILTER_ESCAPE_REGEXP = /([\\"])/g;
  private static readonly FILTER_FIELD_REGEXP = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  private readonly options: MeilisearchEngineOptions;

  readonly capabilities: SearchEngineCapabilities = {
    facetedSearch: true,
    vectorSearch: false,
    highlightSearch: true,
    fuzzySearch: true,
  };

  constructor(options: MeilisearchEngineOptions) {
    super();
    this.options = validateMeilisearchOptions(options);
    this.client = new MeiliSearch({
      host: this.options.host,
      apiKey: this.options.apiKey,
    });
  }

  async search<T>(
    indexName: string,
    query: SearchQuery,
    options: SearchOperationOptions = {},
  ): Promise<SearchResult<T>> {
    const client = this.getOperationClient("search", options);
    this.validateIndexName(indexName, "search");
    const tenantId = this.getTenantId("search");

    const filterArray = this.transformFilters(query.filters, tenantId);
    filterArray.push(`_tenantId = "${this.escapeFilterValue(tenantId)}"`);

    const sortArray = this.transformSort(query.sort);

    const index = client.index(indexName);
    const result = await this.runOperation(
      "search",
      () =>
        index.search(query.query, {
          filter: filterArray,
          limit: query.limit,
          offset: query.offset,
          sort: sortArray,
        }),
      { indexName },
      { operation: "search", options },
      true,
    );

    return {
      hits: result.hits.map((hit) => {
        const document = { ...hit };
        delete document[DOCUMENT_PRIMARY_KEY];
        return { document: document as T };
      }),
      total: result.estimatedTotalHits ?? 0,
      query,
      processingTimeMs: result.processingTimeMs || 0,
    };
  }

  async indexDocument(
    indexName: string,
    document: SearchDocument,
    options: SearchOperationOptions = {},
  ): Promise<void> {
    const client = this.getOperationClient("indexDocument", options);
    this.validateIndexName(indexName, "indexDocument");
    this.validateDocument(document, "indexDocument");
    const tenantId = this.getTenantId("indexDocument");
    const index = client.index(indexName);
    await this.validateIndexPrimaryKey(client, indexName, "indexDocument", options);
    const task = await this.runOperation(
      "indexDocument",
      () =>
        index.addDocuments([this.scopeDocument(document, tenantId)], {
          primaryKey: DOCUMENT_PRIMARY_KEY,
        }),
      { documentId: document.id, indexName },
      { operation: "indexDocument", options },
      true,
    );
    await this.waitForTask(
      "indexDocument",
      "indexDocument",
      task,
      client,
      { documentId: document.id, indexName },
      options,
    );
  }

  async bulkIndex(
    indexName: string,
    documents: SearchDocument[],
    options: SearchOperationOptions = {},
  ): Promise<void> {
    const client = this.getOperationClient("bulkIndex", options);
    this.validateIndexName(indexName, "bulkIndex");
    for (const document of documents) {
      this.validateDocument(document, "bulkIndex");
    }

    if (documents.length === 0) {
      return;
    }

    const tenantId = this.getTenantId("bulkIndex");
    const index = client.index(indexName);
    await this.validateIndexPrimaryKey(client, indexName, "bulkIndex", options);
    const docsWithTenant = documents.map((doc) => this.scopeDocument(doc, tenantId));
    const task = await this.runOperation(
      "bulkIndex",
      () => index.addDocuments(docsWithTenant, { primaryKey: DOCUMENT_PRIMARY_KEY }),
      { indexName },
      { operation: "bulkIndex", options },
      true,
    );
    await this.waitForTask("bulkIndex", "bulkIndex", task, client, { indexName }, options);
  }

  async deleteDocument(
    indexName: string,
    documentId: string,
    options: SearchOperationOptions = {},
  ): Promise<void> {
    const client = this.getOperationClient("deleteDocument", options);
    this.validateIndexName(indexName, "deleteDocument");
    this.validateDocumentId(documentId, "deleteDocument");
    const tenantId = this.getTenantId("deleteDocument");
    const index = client.index(indexName);

    const task = await this.runOperation(
      "deleteDocument",
      () =>
        index.deleteDocuments({
          filter: `_tenantId = "${this.escapeFilterValue(tenantId)}" AND id = "${this.escapeFilterValue(documentId)}"`,
        }),
      { documentId, indexName },
      { operation: "deleteDocument", options },
      true,
    );
    await this.waitForTask(
      "deleteDocument",
      "deleteDocument",
      task,
      client,
      { documentId, indexName },
      options,
    );
  }

  async createIndex(config: IndexConfig, options: SearchOperationOptions = {}): Promise<void> {
    const client = this.getOperationClient("createIndex", options);
    this.validateIndexName(config.name, "createIndex");
    this.validateAttributeNames(config.filterableFields, "createIndex");
    this.validateAttributeNames(config.searchableFields, "createIndex");
    this.validateAttributeNames(config.sortableFields, "createIndex");

    if (config.primaryKey !== undefined && config.primaryKey !== "id") {
      throw new MeilisearchInvalidRequestProblem(
        {
          operation: "createIndex",
          indexName: config.name,
          upstreamCode: "incompatible-primary-key",
        },
        "Meilisearch shared indexes require the logical document primary key 'id'",
      );
    }

    const createTask = await this.runOperation(
      "createIndex",
      () => client.createIndex(config.name, { primaryKey: DOCUMENT_PRIMARY_KEY }),
      { indexName: config.name },
      { operation: "createIndex", options },
    );
    await this.waitForTask(
      "createIndex",
      "createIndex",
      createTask,
      client,
      { indexName: config.name },
      options,
    );

    const index = client.index(config.name);

    const filterable = ["_tenantId", "id", ...(config.filterableFields || [])].filter(
      (field, index, fields) => fields.indexOf(field) === index,
    );
    const sortable = [...(config.sortableFields || [])];
    const settings = {
      filterableAttributes: filterable,
      ...(config.searchableFields !== undefined && {
        searchableAttributes: [...config.searchableFields],
      }),
      sortableAttributes: sortable,
    };

    const settingsTask = await this.runOperation(
      "createIndex.updateSettings",
      () => index.updateSettings(settings),
      { indexName: config.name },
      { operation: "createIndex", options },
      true,
    );
    await this.waitForTask(
      "createIndex.updateSettings",
      "createIndex",
      settingsTask,
      client,
      { indexName: config.name },
      options,
    );
  }

  /**
   * 테넌트 컨텍스트에서는 거부하며, 시스템 호출은 allowGlobalDrop: true가 필요합니다.
   */
  async deleteIndex(name: string, options: MeilisearchDeleteIndexOptions = {}): Promise<void> {
    const client = this.getOperationClient("deleteIndex", options);
    this.validateIndexName(name, "deleteIndex");

    if (Context.getTenantId() !== null) {
      throw new MeilisearchInvalidRequestProblem(
        { operation: "deleteIndex", indexName: name, upstreamCode: "tenant-index-drop-forbidden" },
        "Physical index deletion is forbidden in a tenant context",
      );
    }

    if (options.allowGlobalDrop !== true) {
      throw new MeilisearchInvalidRequestProblem(
        {
          operation: "deleteIndex",
          indexName: name,
          upstreamCode: "global-index-drop-not-authorized",
        },
        "Physical index deletion requires allowGlobalDrop: true in a system context",
      );
    }

    const task = await this.runOperation(
      "deleteIndex",
      () => client.deleteIndex(name),
      { indexName: name },
      { operation: "deleteIndex", options },
    );
    await this.waitForTask(
      "deleteIndex",
      "deleteIndex",
      task,
      client,
      { indexName: name },
      options,
    );
  }

  async generateTenantToken(tenantId: string, expiresAt?: Date): Promise<string> {
    const activeTenantId = this.getTenantId("generateTenantToken");

    if (!tenantId.trim()) {
      throw new MeilisearchInvalidRequestProblem(
        { operation: "generateTenantToken" },
        "Tenant id must be a non-empty string",
      );
    }

    if (tenantId !== activeTenantId) {
      throw new MeilisearchInvalidRequestProblem(
        { operation: "generateTenantToken", upstreamCode: "invalid-tenant-context" },
        "Meilisearch tenant token id must match the active tenant context",
      );
    }

    if (!this.options.tenantTokenOptions) {
      throw new TenantTokenNotConfiguredProblem();
    }

    const { apiKeyUid, expiresIn } = this.options.tenantTokenOptions;

    const searchRules = {
      "*": {
        filter: `_tenantId = "${this.escapeFilterValue(activeTenantId)}"`,
      },
    };

    return await this.runOperation(
      "generateTenantToken",
      () =>
        this.client.generateTenantToken(apiKeyUid, searchRules, {
          expiresAt:
            expiresAt ??
            (expiresIn !== undefined ? new Date(Date.now() + expiresIn * 1000) : undefined),
        }),
      {},
    );
  }

  private scopeDocument(document: SearchDocument, tenantId: string): SearchDocument {
    return {
      ...document,
      tenantId,
      _tenantId: tenantId,
      [DOCUMENT_PRIMARY_KEY]: createHash("sha256")
        .update(JSON.stringify([tenantId, document.id]))
        .digest("hex"),
    };
  }

  private async validateIndexPrimaryKey(
    client: MeiliSearch,
    indexName: string,
    operation: "indexDocument" | "bulkIndex",
    options: SearchOperationOptions,
  ): Promise<void> {
    const info = await this.runOperation(
      operation,
      () => client.index(indexName).getRawInfo(),
      { indexName },
      { operation, options },
      true,
    );
    if (info.primaryKey !== DOCUMENT_PRIMARY_KEY) {
      throw new MeilisearchInvalidRequestProblem(
        { operation, indexName, upstreamCode: "incompatible-primary-key" },
        "Recreate the index with MeilisearchEngine.createIndex and reindex tenant documents before writing",
      );
    }
  }

  private getTenantId(operation: string): string {
    const tenantId = Context.getTenantId();
    if (!tenantId) {
      throw new MissingTenantProblem(operation);
    }
    return tenantId;
  }

  private transformFilters(
    filters: Record<string, unknown> | undefined,
    tenantId: string,
  ): string[] {
    if (!filters) return [];
    return Object.entries(filters).flatMap(([key, value]) => {
      if (key === "tenantId") {
        if (value !== tenantId) {
          throw new MeilisearchInvalidRequestProblem(
            { operation: "search", upstreamCode: "invalid-tenant-filter" },
            "Meilisearch tenantId filter must match the active tenant context",
          );
        }
        return [];
      }

      if (key === "_tenantId") {
        throw new MeilisearchInvalidRequestProblem(
          { operation: "search", upstreamCode: "invalid-tenant-filter" },
          "Meilisearch _tenantId filter is provider-owned and cannot be supplied by callers",
        );
      }

      this.validateAttributeName(key, "search");
      return [`${key} = ${this.formatFilterValue(value, "search")}`];
    });
  }

  private formatFilterValue(value: unknown, operation: string): string {
    if (typeof value === "string") {
      return `"${this.escapeFilterValue(value)}"`;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === "boolean") {
      return String(value);
    }

    throw new MeilisearchInvalidRequestProblem(
      { operation },
      "Meilisearch filters support only string, finite number, and boolean values",
    );
  }

  private escapeFilterValue(value: string): string {
    return value.replace(MeilisearchEngine.FILTER_ESCAPE_REGEXP, "\\$1");
  }

  private transformSort(sort?: { field: string; order: "asc" | "desc" }[]): string[] | undefined {
    if (!sort) return undefined;
    return sort.map((s) => {
      this.validateAttributeName(s.field, "search");
      return `${s.field}:${s.order}`;
    });
  }

  private validateIndexName(indexName: string, operation: string): void {
    if (!indexName.trim()) {
      throw new MeilisearchInvalidRequestProblem(
        { operation },
        "Meilisearch index name must be a non-empty string",
      );
    }
  }

  private validateDocument(document: SearchDocument, operation: string): void {
    this.validateDocumentId(document.id, operation);
  }

  private validateDocumentId(documentId: string, operation: string): void {
    if (!documentId.trim()) {
      throw new MeilisearchInvalidRequestProblem(
        { operation },
        "Search document id must be a non-empty string",
      );
    }
  }

  private validateAttributeNames(fields: readonly string[] | undefined, operation: string): void {
    for (const field of fields ?? []) {
      this.validateAttributeName(field, operation);
    }
  }

  private validateAttributeName(field: string, operation: string): void {
    if (!MeilisearchEngine.FILTER_FIELD_REGEXP.test(field)) {
      throw new MeilisearchInvalidRequestProblem(
        { operation, upstreamCode: "invalid-filter-field" },
        `Meilisearch field '${field}' is not safe for filter or sort construction`,
      );
    }
  }

  private async runOperation<T>(
    providerOperation: string,
    action: () => Promise<T> | T,
    context: { indexName?: string; documentId?: string },
    cancellation?: {
      operation: SearchOperation;
      options: SearchOperationOptions;
    },
    replaySafe = false,
    retryPolicy = MEILISEARCH_RETRY_POLICY,
  ): Promise<T> {
    const executeAttempt = async (): Promise<T> => {
      if (cancellation) {
        throwIfSearchOperationAborted(cancellation.operation, cancellation.options);
      }

      let result: T;
      try {
        result = await this.awaitOperation(action(), cancellation);
      } catch (error) {
        if (cancellation?.options.signal?.aborted) {
          throw new SearchOperationAbortedProblem(cancellation.operation, error);
        }
        throw normalizeMeilisearchError(error, { operation: providerOperation, ...context });
      }

      if (cancellation) {
        throwIfSearchOperationAborted(cancellation.operation, cancellation.options);
      }
      return result;
    };

    if (!replaySafe) {
      return await executeAttempt();
    }

    const retryTemplate = new RetryTemplate({
      maxAttempts: 3,
      backoff: this.options.retryBackoff,
      retryPolicy,
      signal: cancellation?.options.signal,
    });

    try {
      return await retryTemplate.execute(async () => await executeAttempt());
    } catch (error) {
      if (cancellation?.options.signal?.aborted) {
        throw new SearchOperationAbortedProblem(
          cancellation.operation,
          cancellation.options.signal.reason,
        );
      }
      throw error;
    }
  }

  private async awaitOperation<T>(
    result: Promise<T> | T,
    cancellation:
      | {
          operation: SearchOperation;
          options: SearchOperationOptions;
        }
      | undefined,
  ): Promise<T> {
    const signal = cancellation?.options.signal;
    if (!signal) {
      return await result;
    }

    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
      }
    });

    try {
      return await Promise.race([result, abortPromise]);
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private async waitForTask(
    providerOperation: string,
    operation: SearchOperation,
    task: unknown,
    client: MeiliSearch,
    context: { indexName?: string; documentId?: string },
    options: SearchOperationOptions,
  ): Promise<void> {
    if (this.options.taskWait?.enabled === false) {
      return;
    }

    const taskUid = this.getTaskUid(task);
    if (taskUid === undefined) {
      throw new MeilisearchInvalidRequestProblem(
        { operation: providerOperation, ...context, upstreamCode: "missing-task-uid" },
        "Meilisearch task response is missing taskUid",
      );
    }

    const result = await this.runOperation(
      `${providerOperation}.waitForTask`,
      () =>
        client.waitForTask(taskUid, {
          ...(this.options.taskWait?.timeoutMs !== undefined && {
            timeOutMs: this.options.taskWait.timeoutMs,
          }),
          ...(this.options.taskWait?.intervalMs !== undefined && {
            intervalMs: this.options.taskWait.intervalMs,
          }),
        }),
      context,
      { operation, options },
      true,
      MEILISEARCH_TASK_WAIT_RETRY_POLICY,
    );

    if (this.isFailedTask(result)) {
      throw normalizeMeilisearchError(result.error, { operation: providerOperation, ...context });
    }

    if (this.isCanceledTask(result)) {
      throw new MeilisearchTaskCanceledProblem({ operation: providerOperation, ...context });
    }
  }

  private getOperationClient(
    operation: SearchOperation,
    options: SearchOperationOptions,
  ): MeiliSearch {
    throwIfSearchOperationAborted(operation, options);
    if (!options.signal) {
      return this.client;
    }

    return new MeiliSearch({
      host: this.options.host,
      apiKey: this.options.apiKey,
      requestConfig: { signal: options.signal },
    });
  }

  private getTaskUid(task: unknown): number | undefined {
    if (typeof task !== "object" || task === null || !("taskUid" in task)) {
      return undefined;
    }

    const taskUid = task.taskUid;
    return typeof taskUid === "number" && Number.isInteger(taskUid) ? taskUid : undefined;
  }

  private isFailedTask(task: unknown): task is { readonly error: unknown } {
    return (
      typeof task === "object" &&
      task !== null &&
      "status" in task &&
      task.status === "failed" &&
      "error" in task
    );
  }

  private isCanceledTask(task: unknown): boolean {
    return (
      typeof task === "object" && task !== null && "status" in task && task.status === "canceled"
    );
  }
}
