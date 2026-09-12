import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  Container,
  Context,
  LOGGER_TOKEN,
  TRANSACTION_CONTEXT_TOKEN,
  type ILogger,
  type RequestContext,
  type RuntimeContext,
  type RuntimeCapabilities,
  type Token,
  type TransactionContext,
} from "@croco/framework-context";
import {
  EventBusConfig,
  EventPublisher,
  getEventHandlerSubscriptions,
  type DomainEvent,
  type EventBus,
  type EventHandlerClass,
  type EventSubscription,
} from "@croco/events-core";
import { InMemoryEventBus, type InMemoryEventBusOptions } from "@croco/events-inmemory";
import { Logger } from "@croco/framework-logger";
import { emitOpenAPI, type EmitOpenAPIOptions } from "@croco/openapi-spec";
import { Problem, ProblemCategory, type ProblemDetails } from "@croco/problems-core";
import {
  createApp,
  type AppConfig,
  type CrocoApp,
  ErrorHandler,
  HealthCheckRegistry,
} from "@croco/transports-http";

type PrimitiveQueryValue = string | number | boolean | null | undefined;
type QueryValue = PrimitiveQueryValue | readonly PrimitiveQueryValue[];
type HttpMethod = "get" | "post" | "put" | "delete" | "patch" | "head" | "options" | "trace";
type OpenAPIOperation = {
  readonly operationId?: string;
  readonly responses?: Record<string, OpenAPIResponse>;
};
type OpenAPIResponse = {
  readonly content?: Record<string, unknown>;
};
type OpenAPIDocumentLike = {
  readonly paths?: Record<string, Partial<Record<HttpMethod, OpenAPIOperation>>>;
};
type TestingConstructor<T = unknown> = new (...args: never[]) => T;
type TestingToken<T = unknown> = TestingConstructor<T> | Token<T> | string | symbol;
type AfterCommitHook = () => void | Promise<void>;
type TestingTransactionFrame = {
  readonly afterCommitHooks: AfterCommitHook[];
  registrationOpen: boolean;
};
type TestingAfterCommitHookFailure = {
  readonly error: Error;
  readonly message: string;
  readonly name: string;
};

export type TestLogger = ILogger;
export type IsolatedTestingFidelity = {
  readonly boot: "isolated";
  readonly runtime: "node";
  readonly validation: "isolated";
};

export type TestingProvider<T = unknown> =
  | TestingConstructor<T>
  | {
      readonly token: TestingToken<T>;
      readonly useValue: T;
    }
  | {
      readonly token: TestingToken<T>;
      readonly useFactory: () => T;
    };

export type TestingHarnessOptions = {
  readonly baseUrl?: string;
};

export type TestingTransactionContextOptions = {
  readonly inTransaction?: boolean;
};

export type ResetCrocoTestingContextOptions = {
  readonly logger?: TestLogger;
  readonly providers?: readonly TestingProvider[];
  readonly transactionContext?:
    | TestingTransactionContext
    | TestingTransactionContextOptions
    | false;
};

export type TestingAppOptions = Omit<AppConfig, "controllers"> &
  TestingHarnessOptions & {
    readonly autoRegisterControllers?: boolean;
    readonly controllers: readonly TestingConstructor[];
    readonly logger?: TestLogger;
    readonly providers?: readonly TestingProvider[];
    readonly resetContainer?: boolean;
    readonly transactionContext?:
      | TestingTransactionContext
      | TestingTransactionContextOptions
      | false;
  };

export type TestingRequestOptions = Omit<RequestInit, "body"> & {
  readonly body?: BodyInit | null;
  readonly json?: unknown;
  readonly query?: Record<string, QueryValue>;
};

export type ProblemResponseExpectation = {
  readonly code?: string;
  readonly detailIncludes?: string | readonly string[];
  readonly instance?: string;
  readonly status?: number;
  readonly title?: string;
  readonly type?: string;
};

export type OpenAPIRouteExpectation = {
  readonly contentType?: string;
  readonly method: HttpMethod | Uppercase<HttpMethod>;
  readonly operationId?: string;
  readonly path: string;
  readonly status?: number | `${number}` | "default";
};

export type TestingRequestContextOptions = Omit<Partial<RequestContext>, "runtime"> & {
  readonly runtime?: Partial<RuntimeContext> | false;
};

export type EventTestingHarnessOptions<TEvent extends DomainEvent = DomainEvent> = {
  readonly eventBus?: EventBus<TEvent>;
  readonly handlers?: readonly EventHandlerClass<TEvent>[];
  readonly inMemoryEventBus?: InMemoryEventBusOptions;
  readonly logger?: TestLogger;
  readonly providers?: readonly TestingProvider[];
  readonly resetContainer?: boolean;
  readonly subscriptions?: readonly EventSubscription<TEvent>[];
  readonly transactionContext?:
    | TestingTransactionContext
    | TestingTransactionContextOptions
    | false;
};

const DEFAULT_BASE_URL = "http://localhost";
const DEFAULT_TEST_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  env: false,
  filesystem: true,
  flush: true,
  logger: true,
  nodeApi: true,
  requestLifecycle: true,
  streamingResponse: true,
  deadline: false,
  abortSignal: true,
  shutdown: false,
  trace: false,
  waitUntil: true,
};
const IGNORED_PARAM_TYPES = new Set<unknown>([Object, String, Number, Boolean, Array]);
let testingRequestContextCounter = 0;

class TestingTransactionContextNotActiveProblem extends Problem {
  constructor() {
    super(
      "testing/transaction-context-not-active",
      ProblemCategory.InternalServerError,
      "Testing transaction context is not active. Use runInTransaction() or createTestingTransactionContext({ inTransaction: true }).",
      { type: "https://docs.croco.dev/problems/testing/transaction-context-not-active" },
    );
  }
}

class TestingAfterCommitHooksProblem extends Problem {
  constructor(failures: readonly TestingAfterCommitHookFailure[]) {
    const cause = failures[0]?.error;

    super(
      "testing/after-commit-hooks-failed",
      ProblemCategory.InternalServerError,
      `${failures.length} testing afterCommit hook(s) failed after transaction commit`,
      {
        type: "https://docs.croco.dev/problems/testing/after-commit-hooks-failed",
        extensions: {
          committed: true,
          failureCount: failures.length,
          failures: failures.map(({ message, name }) => ({ message, name })),
        },
        ...(cause ? { cause } : {}),
      },
    );
  }
}

class SilentTestLogger implements TestLogger {
  debug(): void {}

  info(): void {}

  warn(): void {}

  error(): void {}

  fatal(): void {}

  child(): TestLogger {
    return this;
  }
}

function createTestingTransactionFrame(): TestingTransactionFrame {
  return { afterCommitHooks: [], registrationOpen: true };
}

function normalizeTestingError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function safeLogAfterCommitHookFailure(error: Error): void {
  try {
    const logger = Container.has(LOGGER_TOKEN)
      ? Container.get<TestLogger>(LOGGER_TOKEN)
      : new SilentTestLogger();
    logger.error("AfterCommit hook failed:", { error });
  } catch {
    // Logging must not hide the original after-commit hook failure.
  }
}

export class TestingTransactionContext implements TransactionContext {
  private readonly storage = new AsyncLocalStorage<TestingTransactionFrame | null>();
  private manualFrame: TestingTransactionFrame | null;

  constructor(options: TestingTransactionContextOptions = {}) {
    this.manualFrame = options.inTransaction ? createTestingTransactionFrame() : null;
  }

  isInTransaction(): boolean {
    return this.getCurrentFrame() !== null;
  }

  canRegisterAfterCommit(): boolean {
    return this.getCurrentFrame()?.registrationOpen ?? false;
  }

  onAfterCommit(hook: AfterCommitHook): void {
    const frame = this.getCurrentFrame();

    if (!frame?.registrationOpen) {
      throw new TestingTransactionContextNotActiveProblem();
    }

    frame.afterCommitHooks.push(hook);
  }

  async runInTransaction<T>(fn: () => Promise<T> | T): Promise<T> {
    const existingFrame = this.getCurrentFrame();

    if (existingFrame) {
      return await fn();
    }

    const frame = createTestingTransactionFrame();
    let result: T;
    try {
      result = await this.storage.run(frame, async () => await fn());
    } finally {
      frame.registrationOpen = false;
    }
    await this.executeAfterCommitHooks(frame);

    return result;
  }

  async flushAfterCommitHooks(): Promise<void> {
    const frame = this.getCurrentFrame();

    if (!frame) {
      return;
    }

    if (this.manualFrame === frame) {
      this.manualFrame = null;
    }

    frame.registrationOpen = false;
    await this.executeAfterCommitHooks(frame);
  }

  getPendingAfterCommitHookCount(): number {
    return this.getCurrentFrame()?.afterCommitHooks.length ?? 0;
  }

  private getCurrentFrame(): TestingTransactionFrame | null {
    return this.storage.getStore() ?? this.manualFrame;
  }

  private async executeAfterCommitHooks(frame: TestingTransactionFrame): Promise<void> {
    const hooks = frame.afterCommitHooks.splice(0);
    const failures: TestingAfterCommitHookFailure[] = [];

    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        const normalizedError = normalizeTestingError(error);
        failures.push({
          error: normalizedError,
          message: normalizedError.message,
          name: normalizedError.name,
        });
        safeLogAfterCommitHookFailure(normalizedError);
      }
    }

    if (failures.length > 0) {
      throw new TestingAfterCommitHooksProblem(failures);
    }
  }
}

export class CrocoTestingApp {
  readonly fidelity: IsolatedTestingFidelity = {
    boot: "isolated",
    runtime: "node",
    validation: "isolated",
  };

  constructor(
    readonly app: CrocoApp,
    readonly baseUrl: string = DEFAULT_BASE_URL,
  ) {}

  request(path: string | URL | Request, options: TestingRequestOptions = {}): Promise<Response> {
    return this.app.fetch(createTestingRequest(path, options, this.baseUrl));
  }

  get(path: string | URL, options: Omit<TestingRequestOptions, "method"> = {}): Promise<Response> {
    return this.request(path, { ...options, method: "GET" });
  }

  post(path: string | URL, options: Omit<TestingRequestOptions, "method"> = {}): Promise<Response> {
    return this.request(path, { ...options, method: "POST" });
  }

  put(path: string | URL, options: Omit<TestingRequestOptions, "method"> = {}): Promise<Response> {
    return this.request(path, { ...options, method: "PUT" });
  }

  patch(
    path: string | URL,
    options: Omit<TestingRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "PATCH" });
  }

  delete(
    path: string | URL,
    options: Omit<TestingRequestOptions, "method"> = {},
  ): Promise<Response> {
    return this.request(path, { ...options, method: "DELETE" });
  }

  readJson<T = unknown>(response: Response): Promise<T> {
    return readResponseJson<T>(response);
  }

  readProblem(response: Response): Promise<ProblemDetails> {
    return readProblemResponse(response);
  }

  assertProblem(
    response: Response,
    expected: ProblemResponseExpectation = {},
  ): Promise<ProblemDetails> {
    return assertProblemResponse(response, expected);
  }

  rpcFetch(): typeof fetch {
    return createRpcTestFetch(this.app, { baseUrl: this.baseUrl });
  }
}

export function createTestingApp(options: TestingAppOptions): CrocoTestingApp {
  const {
    autoRegisterControllers = true,
    baseUrl = DEFAULT_BASE_URL,
    logger,
    providers = [],
    resetContainer = true,
    transactionContext,
    ...appConfig
  } = options;

  if (resetContainer) {
    resetCrocoTestingContext({ logger, providers, transactionContext });
  } else {
    seedCrocoTestingDefaults(logger);
    registerTestingProviders(providers);
    seedTestingTransactionContext(transactionContext);
  }

  if (autoRegisterControllers) {
    registerConstructors(appConfig.controllers);
  }

  return createTestingHarness(
    createApp({
      ...appConfig,
      controllers: appConfig.controllers as AppConfig["controllers"],
      diValidation: appConfig.diValidation ?? "off",
      securityValidation: appConfig.securityValidation ?? "off",
    }),
    { baseUrl },
  );
}

export function createTestingHarness(
  app: CrocoApp,
  options: TestingHarnessOptions = {},
): CrocoTestingApp {
  return new CrocoTestingApp(app, options.baseUrl ?? DEFAULT_BASE_URL);
}

export function resetCrocoTestingContext(options: ResetCrocoTestingContextOptions = {}): void {
  Container.reset();
  EventBusConfig.setInstance(new EventBusConfig());
  testingRequestContextCounter = 0;
  seedCrocoTestingDefaults(options.logger);
  seedTestingTransactionContext(options.transactionContext);
  registerTestingProviders(options.providers ?? []);
}

export function createTestingTransactionContext(
  options: TestingTransactionContextOptions = {},
): TestingTransactionContext {
  return new TestingTransactionContext(options);
}

export function createTestingRequestContext(
  options: TestingRequestContextOptions = {},
): RequestContext {
  const { runtime: runtimeInput, ...contextOptions } = options;
  const requestId = options.requestId ?? `test-request-${++testingRequestContextCounter}`;
  const runtime =
    runtimeInput === false ? undefined : createTestingRuntimeContext(requestId, runtimeInput);
  const context: RequestContext = {
    ...contextOptions,
    requestId,
    ...(runtime ? { runtime } : {}),
  };

  return context;
}

export function runWithTestingContext<T>(
  fn: () => Promise<T> | T,
  options: RequestContext | TestingRequestContextOptions = {},
): Promise<T> | T {
  const requestContext = isRequestContext(options) ? options : createTestingRequestContext(options);

  return Context.run(requestContext, fn);
}

export class CrocoEventTestingHarness<TEvent extends DomainEvent = DomainEvent> {
  readonly transactionContext: TestingTransactionContext | null;

  constructor(
    readonly eventBus: EventBus<TEvent>,
    readonly config: EventBusConfig,
    transactionContext: TestingTransactionContext | null,
  ) {
    this.transactionContext = transactionContext;
  }

  publish(event: TEvent): Promise<void> {
    return this.eventBus.publish(event);
  }

  dispatch(event: TEvent): Promise<void> {
    return this.publish(event);
  }

  publishAfterCommit(event: TEvent): void {
    new EventPublisher(this.config).publishAfterCommit(event);
  }

  flushAfterCommitHooks(): Promise<void> {
    return this.transactionContext?.flushAfterCommitHooks() ?? Promise.resolve();
  }

  clear(): void {
    this.config.clear();
  }
}

export async function createEventTestingHarness<TEvent extends DomainEvent = DomainEvent>(
  options: EventTestingHarnessOptions<TEvent> = {},
): Promise<CrocoEventTestingHarness<TEvent>> {
  const {
    eventBus = new InMemoryEventBus<TEvent>(options.inMemoryEventBus),
    handlers = [],
    logger,
    providers = [],
    resetContainer = true,
    subscriptions = [],
    transactionContext: transactionContextInput,
  } = options;
  const decoratedSubscriptions = handlers.flatMap((handler) =>
    getEventHandlerSubscriptions(handler as EventHandlerClass),
  ) as EventSubscription<TEvent>[];
  const transactionContext = normalizeTestingTransactionContext(transactionContextInput);

  if (resetContainer) {
    resetCrocoTestingContext({
      logger,
      providers,
      transactionContext: transactionContext ?? false,
    });
  } else {
    seedCrocoTestingDefaults(logger);
    seedTestingTransactionContext(transactionContext ?? false);
    registerTestingProviders(providers);
  }

  registerConstructors(handlers as readonly TestingConstructor[]);

  const config = new EventBusConfig();
  EventBusConfig.setInstance(config);
  Container.set(EventBusConfig, config);
  config.setEventBus(eventBus);

  for (const subscription of [...decoratedSubscriptions, ...subscriptions]) {
    config.subscribe(subscription);
  }

  await config.start({ handlers: [], resolver: { resolve: Container.get } });

  return new CrocoEventTestingHarness(eventBus, config, transactionContext);
}

export async function readResponseJson<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function readProblemResponse(response: Response): Promise<ProblemDetails> {
  const body = await readResponseJson<unknown>(response);

  if (!isProblemDetails(body)) {
    throw new Error("Expected response body to be RFC 7807 Problem Details.");
  }

  return body;
}

export async function assertProblemResponse(
  response: Response,
  expected: ProblemResponseExpectation = {},
): Promise<ProblemDetails> {
  if (expected.status !== undefined && response.status !== expected.status) {
    throw new Error(`Expected HTTP status ${expected.status}, received ${response.status}.`);
  }

  const problem = await readProblemResponse(response);
  assertEqual(problem.status, expected.status, "Problem status");
  assertEqual(problem.code, expected.code, "Problem code");
  assertEqual(problem.title, expected.title, "Problem title");
  assertEqual(problem.type, expected.type, "Problem type");
  assertEqual(problem.instance, expected.instance, "Problem instance");

  const detailIncludes = toArray(expected.detailIncludes);
  for (const expectedDetail of detailIncludes) {
    if (!problem.detail?.includes(expectedDetail)) {
      throw new Error(`Expected Problem detail to include "${expectedDetail}".`);
    }
  }

  return problem;
}

export function assertOpenAPIRoute(
  controllersOrDocument: readonly TestingConstructor[] | OpenAPIDocumentLike,
  expected: OpenAPIRouteExpectation,
  options: EmitOpenAPIOptions = {},
): OpenAPIOperation {
  const document = (
    Array.isArray(controllersOrDocument)
      ? emitOpenAPI(controllersOrDocument as Parameters<typeof emitOpenAPI>[0], options)
      : controllersOrDocument
  ) as OpenAPIDocumentLike;
  const path = normalizeOpenAPIPath(expected.path);
  const method = expected.method.toLowerCase() as HttpMethod;
  const operation = document.paths?.[path]?.[method];

  if (!operation) {
    throw new Error(`Expected OpenAPI operation ${method.toUpperCase()} ${path}.`);
  }

  assertEqual(operation.operationId, expected.operationId, "OpenAPI operationId");

  if (expected.status !== undefined) {
    const response = operation.responses?.[String(expected.status)];
    if (!response) {
      throw new Error(
        `Expected OpenAPI operation ${method.toUpperCase()} ${path} to document ${expected.status}.`,
      );
    }

    if (expected.contentType !== undefined && !response.content?.[expected.contentType]) {
      throw new Error(
        `Expected OpenAPI ${expected.status} response to document ${expected.contentType}.`,
      );
    }
  }

  return operation;
}

export function createRpcTestFetch(
  app: CrocoApp | CrocoTestingApp,
  options: TestingHarnessOptions = {},
): typeof fetch {
  const targetApp = app instanceof CrocoTestingApp ? app.app : app;
  const baseUrl =
    options.baseUrl ?? (app instanceof CrocoTestingApp ? app.baseUrl : DEFAULT_BASE_URL);

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request =
      input instanceof Request
        ? createTestingRequest(input, init ?? {}, baseUrl)
        : createTestingRequest(String(input), init ?? {}, baseUrl);

    return targetApp.fetch(request);
  };
}

function seedCrocoTestingDefaults(logger: TestLogger = new SilentTestLogger()): void {
  Container.set(LOGGER_TOKEN, logger);
  Container.set(Logger, logger as Logger);
  Container.set(ErrorHandler, new ErrorHandler(logger as Logger));
  Container.set(HealthCheckRegistry, new HealthCheckRegistry());
}

function seedTestingTransactionContext(
  input: TestingTransactionContext | TestingTransactionContextOptions | false | undefined,
): TestingTransactionContext | null {
  const transactionContext = normalizeTestingTransactionContext(input);

  if (transactionContext) {
    Container.set(TRANSACTION_CONTEXT_TOKEN, transactionContext);
  }

  return transactionContext;
}

function normalizeTestingTransactionContext(
  input: TestingTransactionContext | TestingTransactionContextOptions | false | undefined,
): TestingTransactionContext | null {
  if (input === false) {
    return null;
  }

  if (input instanceof TestingTransactionContext) {
    return input;
  }

  return new TestingTransactionContext(input);
}

function registerTestingProviders(providers: readonly TestingProvider[]): void {
  for (const provider of providers) {
    if (typeof provider === "function") {
      registerConstructors([provider]);
      continue;
    }

    if ("useValue" in provider) {
      Container.set(provider.token, provider.useValue);
      continue;
    }

    Container.set(provider.token, provider.useFactory());
  }
}

function registerConstructors(constructors: readonly TestingConstructor[]): void {
  const constructing = new Set<TestingConstructor>();

  for (const constructor of constructors) {
    registerConstructor(constructor, constructing);
  }
}

function registerConstructor<T>(
  constructor: TestingConstructor<T>,
  constructing: Set<TestingConstructor>,
): T {
  if (Container.has(constructor)) {
    return Container.get(constructor);
  }

  if (constructing.has(constructor)) {
    throw new Error(
      `Circular testing provider dependency detected for ${getConstructorName(constructor)}.`,
    );
  }

  constructing.add(constructor);
  const paramTypes = getConstructorParamTypes(constructor);
  const dependencies = paramTypes.map((dependency) =>
    registerConstructor(dependency, constructing),
  );
  const instance = Reflect.construct(constructor, dependencies) as T;
  Container.set(constructor, instance);
  constructing.delete(constructor);

  return instance;
}

function getConstructorName(constructor: TestingConstructor): string {
  return (constructor as { readonly name?: string }).name ?? "anonymous";
}

function getConstructorParamTypes<T>(constructor: TestingConstructor<T>): TestingConstructor[] {
  const paramTypes = Reflect.getMetadata("design:paramtypes", constructor) as unknown;

  if (!Array.isArray(paramTypes)) {
    return [];
  }

  return paramTypes.filter(
    (value): value is TestingConstructor =>
      typeof value === "function" && !IGNORED_PARAM_TYPES.has(value),
  );
}

export function createTestingRequest(
  input: string | URL | Request,
  options: TestingRequestOptions | RequestInit,
  baseUrl: string,
): Request {
  const inputRequest =
    input instanceof Request
      ? new Request(toAbsoluteUrl(input.url, baseUrl).toString(), input)
      : undefined;
  const url = toAbsoluteUrl(inputRequest?.url ?? String(input), baseUrl);
  appendQuery(url, "query" in options ? options.query : undefined);
  const headers = new Headers(options.headers ?? inputRequest?.headers);
  const body =
    "json" in options && options.json !== undefined
      ? JSON.stringify(options.json)
      : "body" in options
        ? options.body
        : undefined;

  if ("json" in options && options.json !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const { body: _body, ...requestOptions } = options;
  const filteredOptions =
    "json" in requestOptions
      ? (({ json: _json, query: _query, ...standardOptions }) => standardOptions)(requestOptions)
      : requestOptions;
  const requestInit: RequestInit = {
    ...filteredOptions,
    ...(body !== undefined ? { body } : {}),
    headers,
  };

  return inputRequest
    ? new Request(new Request(url.toString(), inputRequest), requestInit)
    : new Request(url.toString(), requestInit);
}

function toAbsoluteUrl(input: string, baseUrl: string): URL {
  return new URL(input, baseUrl);
}

function appendQuery(url: URL, query: Record<string, QueryValue> | undefined): void {
  if (!query) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    for (const item of toArray(value)) {
      if (item === null || item === undefined) {
        continue;
      }

      url.searchParams.append(key, String(item));
    }
  }
}

function isProblemDetails(value: unknown): value is ProblemDetails {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "number" &&
    typeof value.code === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.instance === undefined || typeof value.instance === "string")
  );
}

function normalizeOpenAPIPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

function assertEqual<T>(actual: T, expected: T | undefined, label: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`${label} expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? ([...value] as T[]) : [value as T];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createTestingRuntimeContext(
  requestId: string,
  options: Partial<RuntimeContext> | undefined,
): RuntimeContext {
  const {
    capabilities: capabilityOverrides,
    requestId: runtimeRequestId,
    ...runtimeOptions
  } = options ?? {};
  const waitUntilPromises: Promise<unknown>[] = [];
  const capabilities = {
    ...DEFAULT_TEST_RUNTIME_CAPABILITIES,
    ...capabilityOverrides,
  };
  const defaultRuntime = {
    env: {},
    platform: "node",
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    async flush() {
      await Promise.allSettled(waitUntilPromises.splice(0));
    },
    async shutdown() {},
  } satisfies Omit<RuntimeContext, "capabilities" | "requestId">;

  return {
    ...defaultRuntime,
    ...runtimeOptions,
    capabilities,
    requestId: runtimeRequestId ?? requestId,
  };
}

function isRequestContext(value: unknown): value is RequestContext {
  return isRecord(value) && typeof value.requestId === "string";
}
