import {
  Container,
  type ContainerScope,
  type Constructor,
  type DependencyGraphManifest,
  type TokenIdentifier,
} from "@croco/framework-context";
import {
  createModuleGraphManifest,
  createModuleRuntimeForContainer,
  type ModuleRuntime,
} from "./ModuleRegistry";
import { getModuleTokenLabel } from "./moduleTokenLabels";
import { getProviderToken, isConstructorToken, isProviderDefinition } from "./moduleTokens";
import {
  isCrocoApplicationDefinition,
  resolveApplicationModules,
  resolveApplicationPlugins,
} from "./Plugin";
import {
  attachModuleCleanupFailures,
  InvalidModuleDefinitionProblem,
  ModuleLifecycleProblem,
  ModuleRuntimeDisposedProblem,
  ModuleRuntimeStaleContextProblem,
} from "./problems";
import type {
  ModuleCleanupFailure,
  ModuleDiagnosticsSnapshot,
  ModuleGraphManifest,
  ModuleLifecycleExecutionOptions,
  ModuleOptions,
  ResolvedModuleContribution,
} from "./types";
import type {
  ApplicationProviderReplacement,
  CrocoApplicationDefinition,
  CrocoPluginMetadata,
} from "./Plugin";

export type ApplicationRuntimeOptions = {
  readonly modules?: readonly ModuleOptions[];
};

export type ApplicationRuntimeGraphManifest = {
  readonly version: "croco.application-runtime.graph.v1";
  readonly status: "ready" | "failed";
  readonly moduleGraph: ModuleGraphManifest;
  readonly dependencyGraph: DependencyGraphManifest;
  readonly applicationName: string;
  readonly plugins: readonly CrocoPluginMetadata[];
  readonly contributions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly moduleName: string;
    readonly order: number;
  }[];
  readonly providerReplacements: readonly {
    readonly token: string;
    readonly replaces: readonly string[];
  }[];
};

type ApplicationRuntimeState =
  | "created"
  | "initializing"
  | "active"
  | "shutting-down"
  | "stopped"
  | "disposing"
  | "disposed";

/**
 * Owns one isolated DI scope and one module lifecycle for a Croco application.
 */
export class ApplicationRuntime implements AsyncDisposable {
  readonly scopeId: string;
  private readonly containerScope: ContainerScope;
  private readonly moduleRuntime: ModuleRuntime;
  private readonly graphProviderConstructors = new Map<
    TokenIdentifier<unknown>,
    Constructor<unknown>
  >();
  private readonly graphLeafProviders = new Set<TokenIdentifier<unknown>>();
  private readonly graphRoots = new Set<TokenIdentifier<unknown>>();
  private disposal: Promise<void> | undefined;
  private initialization: Promise<void> | undefined;
  private shutdownOperation: Promise<void> | undefined;
  private state: ApplicationRuntimeState = "created";
  private readonly applicationName: string;
  private readonly plugins: readonly CrocoPluginMetadata[];
  private readonly providerReplacements: readonly ApplicationProviderReplacement[];

  constructor(options: ApplicationRuntimeOptions | CrocoApplicationDefinition = {}) {
    const application = isCrocoApplicationDefinition(options) ? options : undefined;
    const modules = application
      ? resolveApplicationModules(application)
      : ((options as ApplicationRuntimeOptions).modules ?? []);
    this.applicationName = application?.name ?? "application";
    this.plugins = application
      ? resolveApplicationPlugins(application).map((plugin) => plugin.metadata)
      : [];
    assertUniqueSinglePluginCapabilities(this.plugins);
    this.providerReplacements = application?.providerReplacements ?? [];
    if (modules.length > 0) {
      createModuleGraphManifest(modules);
    }

    this.containerScope = Container.createScope();
    this.scopeId = this.containerScope.id;
    this.moduleRuntime = createModuleRuntimeForContainer(this.scopeId, this.providerReplacements);

    for (const module of modules) {
      this.use(module);
    }
    for (const replacement of this.providerReplacements) {
      this.collectGraphProvider(replacement.provider);
    }
  }

  use(module: ModuleOptions): void {
    this.assertAccessible();
    this.moduleRuntime.use(module);
    this.collectGraphRoots(module, new Set());
  }

  initialize(options: ModuleLifecycleExecutionOptions = {}): Promise<void> {
    if (this.state === "disposing") {
      return Promise.reject(new ModuleRuntimeDisposedProblem());
    }
    if (this.state === "disposed") {
      try {
        this.containerScope.run(() => undefined);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.state === "shutting-down") {
      return Promise.reject(new ModuleRuntimeStaleContextProblem());
    }
    if (this.initialization) {
      return this.initialization;
    }

    const resumeState = this.state === "stopped" ? "stopped" : "created";
    this.state = "initializing";
    const attempt = this.initializeOnce(resumeState, options);
    this.initialization = attempt;
    void attempt.then(
      () => this.clearInitialization(attempt),
      () => this.clearInitialization(attempt),
    );
    return attempt;
  }

  private async initializeOnce(
    resumeState: "created" | "stopped",
    options: ModuleLifecycleExecutionOptions,
  ): Promise<void> {
    try {
      await this.containerScope.runWithRollback(() => this.moduleRuntime.initialize(options));
      if (this.state === "disposing" || this.state === "disposed") {
        throw new ModuleRuntimeDisposedProblem();
      }
      if (this.state !== "initializing") {
        throw new ModuleRuntimeStaleContextProblem();
      }
      this.state = "active";
    } catch (error) {
      if (this.state === "initializing") {
        this.state = resumeState;
      }
      if (this.hasCleanupFailures(error)) {
        try {
          await this.dispose();
        } catch (disposalError) {
          throw this.attachDisposalFailure(error, disposalError);
        }
      }
      throw error;
    }
  }

  private clearInitialization(attempt: Promise<void>): void {
    if (this.initialization === attempt) {
      this.initialization = undefined;
    }
  }

  shutdown(options: ModuleLifecycleExecutionOptions = {}): Promise<void> {
    return this.startShutdown(options);
  }

  shutdownWithCleanup(
    cleanup: () => Promise<void> | void,
    options: ModuleLifecycleExecutionOptions = {},
  ): Promise<void> {
    return this.startShutdown(options, cleanup);
  }

  private startShutdown(
    options: ModuleLifecycleExecutionOptions,
    cleanup?: () => Promise<void> | void,
  ): Promise<void> {
    if (this.disposal) {
      return cleanup ? Promise.reject(new ModuleRuntimeDisposedProblem()) : this.disposal;
    }
    if (this.state === "disposed") {
      return Promise.reject(new ModuleRuntimeDisposedProblem());
    }
    if (this.shutdownOperation) {
      if (!cleanup) {
        return this.shutdownOperation;
      }

      return this.trackShutdownOperation(
        this.continueShutdownWithCleanup(this.shutdownOperation, cleanup),
      );
    }
    if (this.state === "stopped") {
      return cleanup
        ? this.trackShutdownOperation(this.runShutdownCleanup(cleanup))
        : Promise.resolve();
    }

    this.state = "shutting-down";
    const attempt = this.shutdownOnce(options, cleanup);
    return this.trackShutdownOperation(attempt);
  }

  run<T>(fn: () => Promise<T>): Promise<T>;
  run<T>(fn: () => T): T;
  run<T>(fn: () => Promise<T> | T): Promise<T> | T {
    this.assertAccessible();
    return this.containerScope.run(fn);
  }

  bindHostCallback<TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
  ): (...args: TArgs) => TResult {
    this.assertAccessible();
    return (...args) => this.run(() => callback(...args));
  }

  get<T>(token: TokenIdentifier<T>): T {
    this.assertAccessible();
    return this.containerScope.run(() => Container.get(token));
  }

  has<T>(token: TokenIdentifier<T>): boolean {
    this.assertAccessible();
    return this.containerScope.run(() => Container.has(token));
  }

  createGraphManifest(
    options: { readonly roots?: readonly TokenIdentifier<unknown>[] } = {},
  ): ApplicationRuntimeGraphManifest {
    this.assertAccessible();
    return this.containerScope.run(() => {
      const moduleGraph = this.moduleRuntime.createGraphManifest();
      const dependencyGraph = Container.createDependencyGraphManifest({
        knownProviders: this.graphLeafProviders,
        providerConstructors: this.graphProviderConstructors,
        rejectUnknownProviders: true,
        roots: options.roots ?? [...this.graphRoots],
      });

      const manifest: ApplicationRuntimeGraphManifest = {
        version: "croco.application-runtime.graph.v1",
        status:
          moduleGraph.status === "ready" && dependencyGraph.status === "ready" ? "ready" : "failed",
        moduleGraph,
        dependencyGraph,
        applicationName: this.applicationName,
        plugins: [...this.plugins].sort((left, right) => left.name.localeCompare(right.name)),
        contributions: moduleGraph.modules
          .flatMap((module) =>
            module.contributions.map((contribution) => ({
              ...contribution,
              moduleName: module.name,
            })),
          )
          .sort(
            (left, right) =>
              left.kind.localeCompare(right.kind) ||
              left.order - right.order ||
              left.id.localeCompare(right.id) ||
              left.moduleName.localeCompare(right.moduleName),
          ),
        providerReplacements: this.providerReplacements
          .map((replacement) => ({
            token: getModuleTokenLabel(replacement.provider.provide),
            replaces: [...replacement.replaces].sort(),
          }))
          .sort((left, right) => left.token.localeCompare(right.token)),
      };
      return manifest;
    });
  }

  getRegisteredModules(): readonly ModuleDiagnosticsSnapshot[] {
    this.assertAccessible();
    return this.containerScope.run(() => this.moduleRuntime.getRegisteredModules());
  }

  getContributions<T, TKind extends string = string>(
    kind: TKind,
  ): readonly ResolvedModuleContribution<T, TKind>[] {
    this.assertAccessible();
    return this.moduleRuntime.getContributions<T, TKind>(kind);
  }

  async dispose(): Promise<void> {
    if (this.disposal) {
      await this.disposal;
      return;
    }

    if (this.state === "disposed") {
      return;
    }

    this.state = "disposing";
    this.disposal = this.disposeOnce();
    await this.disposal;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private assertAccessible(): void {
    if (this.state === "disposing") {
      throw new ModuleRuntimeDisposedProblem();
    }
    if (this.state === "shutting-down" || this.state === "stopped") {
      throw new ModuleRuntimeStaleContextProblem();
    }
  }

  private async shutdownOnce(
    options: ModuleLifecycleExecutionOptions,
    cleanup?: () => Promise<void> | void,
  ): Promise<void> {
    let primaryFailure: unknown;
    try {
      await this.containerScope.run(() => this.moduleRuntime.shutdown(options));
    } catch (error) {
      primaryFailure = error;
    }

    try {
      if (cleanup) {
        await this.runShutdownCleanup(cleanup);
      }
    } catch (cleanupError) {
      if (primaryFailure !== undefined) {
        throw this.attachDisposalFailure(primaryFailure, cleanupError);
      }
      throw cleanupError;
    } finally {
      if (this.state === "shutting-down") {
        this.state = "stopped";
      }
    }

    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
  }

  private async continueShutdownWithCleanup(
    attempt: Promise<void>,
    cleanup: () => Promise<void> | void,
  ): Promise<void> {
    let primaryFailure: unknown;
    try {
      await attempt;
    } catch (error) {
      primaryFailure = error;
    }

    try {
      await this.runShutdownCleanup(cleanup);
    } catch (cleanupError) {
      if (primaryFailure !== undefined) {
        throw this.attachDisposalFailure(primaryFailure, cleanupError);
      }
      throw cleanupError;
    }

    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
  }

  private async runShutdownCleanup(cleanup: () => Promise<void> | void): Promise<void> {
    await this.containerScope.run(cleanup);
  }

  private trackShutdownOperation(attempt: Promise<void>): Promise<void> {
    this.shutdownOperation = attempt;
    void attempt.then(
      () => this.clearShutdownOperation(attempt),
      () => this.clearShutdownOperation(attempt),
    );
    return attempt;
  }

  private clearShutdownOperation(attempt: Promise<void>): void {
    if (this.shutdownOperation === attempt) {
      this.shutdownOperation = undefined;
    }
  }

  private collectGraphRoots(module: ModuleOptions, visited: Set<ModuleOptions>): void {
    if (visited.has(module)) {
      return;
    }
    visited.add(module);

    for (const provider of module.providers ?? []) {
      this.collectGraphProvider(provider);
    }
    for (const controller of module.controllers ?? []) {
      const token = controller as TokenIdentifier<unknown>;
      this.graphRoots.add(token);
      if (isConstructorToken(controller)) {
        this.graphProviderConstructors.set(token, controller);
      }
    }
    for (const importedModule of module.imports ?? []) {
      this.collectGraphRoots(importedModule, visited);
    }
  }

  private collectGraphProvider(provider: NonNullable<ModuleOptions["providers"]>[number]): void {
    const token = getProviderToken(provider) as TokenIdentifier<unknown>;
    this.graphRoots.add(token);
    this.graphProviderConstructors.delete(token);
    this.graphLeafProviders.delete(token);
    if (isProviderDefinition(provider)) {
      if ("useClass" in provider) {
        this.graphProviderConstructors.set(token, provider.useClass);
      } else {
        this.graphLeafProviders.add(token);
      }
    } else if (isConstructorToken(provider)) {
      this.graphProviderConstructors.set(token, provider);
    }
  }

  private hasCleanupFailures(error: unknown): boolean {
    if (!(error instanceof Error) || !("extensions" in error)) {
      return false;
    }

    const extensions = error.extensions;
    if (!extensions || typeof extensions !== "object" || !("cleanupFailures" in extensions)) {
      return false;
    }

    return Array.isArray(extensions.cleanupFailures) && extensions.cleanupFailures.length > 0;
  }

  private attachDisposalFailure(error: unknown, disposalError: unknown): ModuleLifecycleProblem {
    const failures = this.getCleanupFailures(disposalError);

    if (error instanceof ModuleLifecycleProblem) {
      const existingFailures = Array.isArray(error.extensions?.cleanupFailures)
        ? (error.extensions.cleanupFailures as unknown as ModuleCleanupFailure[])
        : [];
      return attachModuleCleanupFailures(error, [...existingFailures, ...failures]);
    }

    return new ModuleLifecycleProblem("<application-runtime>", "shutdown", error, failures);
  }

  private async disposeOnce(): Promise<void> {
    let primaryFailure: unknown;
    const shutdownOperation = this.shutdownOperation;
    if (shutdownOperation) {
      try {
        await shutdownOperation;
      } catch (error) {
        primaryFailure = error;
      }
    }

    try {
      await this.containerScope.run(() => this.moduleRuntime.dispose());
    } catch (error) {
      if (primaryFailure === undefined) {
        primaryFailure = error;
      } else if (error !== primaryFailure) {
        primaryFailure = this.attachDisposalFailure(primaryFailure, error);
      }
    }

    try {
      this.containerScope.dispose();
    } catch (error) {
      if (primaryFailure !== undefined) {
        throw this.attachDisposalFailure(primaryFailure, error);
      }
      throw error;
    } finally {
      this.state = "disposed";
    }

    if (primaryFailure !== undefined) {
      throw primaryFailure;
    }
  }

  private getCleanupFailures(error: unknown): ModuleCleanupFailure[] {
    if (error instanceof Error && "extensions" in error) {
      const extensions = error.extensions;
      if (
        extensions &&
        typeof extensions === "object" &&
        "cleanupFailures" in extensions &&
        Array.isArray(extensions.cleanupFailures)
      ) {
        const failures = extensions.cleanupFailures.flatMap((failure) => {
          if (!failure || typeof failure !== "object") {
            return [];
          }

          const code = "code" in failure && typeof failure.code === "string" ? failure.code : null;
          const message =
            "message" in failure && typeof failure.message === "string" ? failure.message : null;
          if (!code || !message) {
            return [];
          }

          return [{ moduleName: "<container-scope>", phase: "shutdown" as const, code, message }];
        });
        if (failures.length > 0) {
          return [this.createCleanupFailure(error), ...failures];
        }
      }
    }

    return [this.createCleanupFailure(error)];
  }

  private createCleanupFailure(error: unknown): ModuleCleanupFailure {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "framework-module/application-runtime-disposal-failed";
    return {
      moduleName: "<application-runtime>",
      phase: "shutdown",
      code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertUniqueSinglePluginCapabilities(plugins: readonly CrocoPluginMetadata[]): void {
  const ownersByCapability = new Map<string, string[]>();

  for (const plugin of plugins) {
    for (const capability of plugin.capabilities) {
      if (capability.kind !== "single") {
        continue;
      }

      const owners = ownersByCapability.get(capability.id) ?? [];
      owners.push(plugin.name);
      ownersByCapability.set(capability.id, owners);
    }
  }

  const conflict = [...ownersByCapability.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))[0];
  if (!conflict) {
    return;
  }

  const [capabilityId, owners] = conflict;
  const sortedOwners = [...owners].sort();
  throw new InvalidModuleDefinitionProblem(
    `Single capability '${capabilityId}' is claimed more than once by plugins: ${sortedOwners.join(", ")}.`,
    { capabilityId, owners: sortedOwners },
  );
}

export function createApplicationRuntime(
  options: ApplicationRuntimeOptions | CrocoApplicationDefinition = {},
): ApplicationRuntime {
  return new ApplicationRuntime(options);
}
