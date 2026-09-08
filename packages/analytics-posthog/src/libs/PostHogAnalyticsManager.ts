import { randomUUID } from "node:crypto";
import { AnalyticsManager } from "@croco/analytics-core";
import { Component, Container, Context, LOGGER_TOKEN, Token } from "@croco/framework-context";
import type { ILogger } from "@croco/framework-context";
import { PostHogClient } from "@croco/integrations-posthog";
import {
  PostHogAnalyticsCaptureProblem,
  PostHogAnalyticsFlushProblem,
  PostHogAnalyticsGroupProblem,
  PostHogAnalyticsIdentifyProblem,
} from "./problems/PostHogAnalyticsProblems";

export type PostHogAnalyticsManagerOptions = {
  readonly enabled?: boolean;
};

export const POSTHOG_ANALYTICS_MANAGER_OPTIONS = new Token<PostHogAnalyticsManagerOptions>(
  "POSTHOG_ANALYTICS_MANAGER_OPTIONS",
);

/**
 * Croco Context 정보를 활용해 PostHog 이벤트와 그룹 정보를 전송하는 분석 관리자입니다.
 */
@Component()
export class PostHogAnalyticsManager extends AnalyticsManager {
  private readonly options: PostHogAnalyticsManagerOptions;

  constructor(private readonly posthogClient: PostHogClient) {
    super();
    this.options = Container.getOptional(POSTHOG_ANALYTICS_MANAGER_OPTIONS) ?? {};
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      this.logDisabledOperation("capture", { event });
      return;
    }

    const distinctId = this.getDistinctId(properties);
    const groups = this.getGroups(properties);

    this.invokeProvider({ name: "capture", event }, () =>
      this.posthogClient.getClient().capture({
        distinctId,
        event,
        properties,
        groups,
      }),
    );
  }

  identify(distinctId: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      this.logDisabledOperation("identify");
      return;
    }

    this.invokeProvider({ name: "identify" }, () =>
      this.posthogClient.getClient().identify({
        distinctId,
        properties,
      }),
    );
  }

  group(groupType: string, groupKey: string, properties?: Record<string, unknown>): void {
    if (!this.isEnabled()) {
      this.logDisabledOperation("group", { groupType });
      return;
    }

    this.invokeProvider({ name: "group" }, () =>
      this.posthogClient.getClient().groupIdentify({
        groupType,
        groupKey,
        properties,
      }),
    );
  }

  async flush(): Promise<void> {
    if (!this.isEnabled()) {
      this.logDisabledOperation("flush");
      return;
    }

    try {
      await this.posthogClient.flush();
    } catch (error) {
      const problem = new PostHogAnalyticsFlushProblem(error instanceof Error ? error : undefined);
      this.getLogger().warn("PostHog analytics flush failed", {
        ...createSafeErrorLogMetadata(error),
        problemCode: problem.code,
      });
      throw problem;
    }
  }

  private getDistinctId(properties?: Record<string, unknown>): string {
    if (properties?.userId) return String(properties.userId);

    const user = Context.getCurrentUser();
    if (user?.id) return user.id;

    const requestId = Context.getRequestId();
    if (requestId) return `anonymous:${requestId}`;

    const tenantId = Context.getTenantId();
    if (tenantId) return `tenant:${tenantId}`;

    return `anonymous:${randomUUID()}`;
  }

  private getGroups(properties?: Record<string, unknown>): Record<string, string> | undefined {
    if (properties?.groups) return properties.groups as Record<string, string>;

    const tenantId = Context.getTenantId();
    if (tenantId) {
      return { tenant: tenantId };
    }

    return undefined;
  }

  private invokeProvider(operation: PostHogAnalyticsOperation, invocation: () => unknown): void {
    try {
      const result = invocation();
      void Promise.resolve(result).catch((error: unknown) => {
        this.logProviderFailure(operation, error);
      });
    } catch (error) {
      this.logProviderFailure(operation, error);
    }
  }

  private logProviderFailure(operation: PostHogAnalyticsOperation, error: unknown): void {
    const problemCode = createProviderFailureProblem(operation, error).code;
    this.getLogger().warn(`PostHog ${operation.name} failed`, {
      ...(operation.name === "capture"
        ? { event: operation.event }
        : { operation: operation.name }),
      ...createSafeErrorLogMetadata(error),
      problemCode,
    });
  }

  private isEnabled(): boolean {
    return this.options.enabled !== false;
  }

  private logDisabledOperation(operation: string, context: Record<string, unknown> = {}): void {
    this.getLogger().info("PostHog analytics operation skipped because analytics is disabled", {
      provider: "posthog",
      operation,
      ...context,
    });
  }

  private getLogger(): Pick<ILogger, "info" | "warn"> {
    return Container.getOptional(LOGGER_TOKEN) ?? console;
  }
}

// Source-mode test execution bypasses tsup/SWC, so preserve the DI edge explicitly there.
Reflect.defineMetadata("design:paramtypes", [PostHogClient], PostHogAnalyticsManager);

type SafePostHogErrorLogMetadata = {
  readonly errorName?: string;
  readonly errorType?: string;
  readonly upstreamCode?: string;
  readonly upstreamStatus?: number;
};

type PostHogAnalyticsOperation =
  | { readonly name: "capture"; readonly event: string }
  | { readonly name: "identify" }
  | { readonly name: "group" };

function createProviderFailureProblem(operation: PostHogAnalyticsOperation, error: unknown) {
  const cause = toErrorCause(error);

  switch (operation.name) {
    case "capture":
      return new PostHogAnalyticsCaptureProblem(operation.event, cause);
    case "identify":
      return new PostHogAnalyticsIdentifyProblem(cause);
    case "group":
      return new PostHogAnalyticsGroupProblem(cause);
  }
}

function createSafeErrorLogMetadata(error: unknown): SafePostHogErrorLogMetadata {
  if (!error || typeof error !== "object") {
    return { errorType: typeof error };
  }

  const errorName = getErrorName(error);
  const upstreamCode = getErrorStringProperty(error, "code");
  const upstreamStatus =
    getErrorNumberProperty(error, "status") ?? getErrorNumberProperty(error, "statusCode");

  return {
    ...(errorName && { errorName }),
    ...(upstreamCode && { upstreamCode }),
    ...(upstreamStatus !== undefined && { upstreamStatus }),
  };
}

function getErrorName(error: object): string | undefined {
  return getErrorStringProperty(error, "name");
}

function getErrorStringProperty(error: object, key: string): string | undefined {
  try {
    const value = Reflect.get(error, key);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function getErrorNumberProperty(error: object, key: string): number | undefined {
  try {
    const value = Reflect.get(error, key);
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function toErrorCause(error: unknown): Error | undefined {
  try {
    return error instanceof Error ? error : undefined;
  } catch {
    return undefined;
  }
}
