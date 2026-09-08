import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Context } from "@croco/framework-context";
import "reflect-metadata";
import type { LlmMeteringService } from "../LlmMeteringService";
import { LlmMeteringServiceRequiredProblem } from "../problems/LlmMeteringProblems";
import { createMeteredAsyncIterable, isAsyncIterable } from "../streamMetering";

export const AI_METERED_METADATA_KEY = Symbol("llm-meter:ai-metered");

export type AiMeteredOptions = {
  /**
   * 계량 service가 필요한지 또는 의도적으로 비활성화했는지 지정합니다.
   *
   * @defaultValue "required"
   */
  metering?: "required" | "disabled";
  /**
   * LlmMeteringService에서 자동으로 추출하므로 생략 가능
   */
  tenantId?: string;
  /**
   * 메서드에서 usage를 추출하는 함수
   */
  usageExtractor?: (
    args: unknown[],
    result: unknown,
  ) => {
    promptTokens: number;
    completionTokens: number;
    accuracy?: "EXACT" | "ESTIMATED" | "UNKNOWN";
  } | null;
  /**
   * 메서드에서 embedding usage를 추출하는 함수
   */
  embeddingUsageExtractor?: (
    args: unknown[],
    result: unknown,
  ) => { tokens: number; accuracy?: "EXACT" | "ESTIMATED" | "UNKNOWN" } | null;
  /**
   * idempotencyKey 추출기
   */
  idempotencyKeyExtractor?: (args: unknown[]) => string | undefined;
  /**
   * 추가 메타데이터 추출기
   */
  metadataExtractor?: (args: unknown[], result: unknown) => Record<string, unknown> | undefined;
};

export type AiMeteredMetadata = {
  metering: "required" | "disabled";
  tenantId?: string;
  usageExtractor?: (
    args: unknown[],
    result: unknown,
  ) => {
    promptTokens: number;
    completionTokens: number;
    accuracy?: "EXACT" | "ESTIMATED" | "UNKNOWN";
  } | null;
  embeddingUsageExtractor?: (
    args: unknown[],
    result: unknown,
  ) => { tokens: number; accuracy?: "EXACT" | "ESTIMATED" | "UNKNOWN" } | null;
  idempotencyKeyExtractor?: (args: unknown[]) => string | undefined;
  metadataExtractor?: (args: unknown[], result: unknown) => Record<string, unknown> | undefined;
};

let llmMeteringServiceInstance: LlmMeteringService | null = null;
const llmMeteringServiceScope = new AsyncLocalStorage<LlmMeteringService>();

function getResultModelMetadata(result: unknown): { modelId: string; provider: string } {
  const metadata =
    result && typeof result === "object"
      ? ((result as { metadata?: { modelId?: string; provider?: string } }).metadata ?? {})
      : {};

  return {
    modelId: metadata.modelId ?? "unknown",
    provider: metadata.provider ?? "unknown",
  };
}

/**
 * LlmMeteringService 인스턴스 설정 (앱 부트스트랩에서 호출)
 */
export function setLlmMeteringService(service: LlmMeteringService | null): void {
  llmMeteringServiceInstance = service;
}

/**
 * 지정한 실행 범위에서 사용할 LlmMeteringService를 바인딩합니다.
 */
export function runWithLlmMeteringService<T>(service: LlmMeteringService, fn: () => T): T {
  return llmMeteringServiceScope.run(service, fn);
}

/**
 * LlmMeteringService 인스턴스 조회
 */
export function getLlmMeteringService(): LlmMeteringService | null {
  return llmMeteringServiceInstance;
}

function resolveLlmMeteringService(metering: "required" | "disabled"): LlmMeteringService | null {
  if (metering === "disabled") {
    return null;
  }

  const service = llmMeteringServiceScope.getStore() ?? llmMeteringServiceInstance;
  if (!service) {
    throw new LlmMeteringServiceRequiredProblem();
  }

  return service;
}

/**
 * @AiMetered 메서드 데코레이터
 *
 * @description
 * 메서드 호출 시 자동으로 LLM 사용량을 기록합니다.
 * LlmService의 generate/stream/embed 메서드에서 사용됩니다.
 *
 * @example
 * ```typescript
 * class MyService {
 *   @AiMetered()
 *   async generateText(prompt: string): Promise<string> {
 *     // LlmService.generate() 호출
 *     return await llmService.generate({ prompt });
 *   }
 *
 *   @AiMetered({
 *     idempotencyKeyExtractor: (args) => args[0]?.id,
 *   })
 *   async embedWithKey(text: string, id: string): Promise<number[]> {
 *     // ...
 *   }
 * }
 * ```
 */
export function AiMetered(options: AiMeteredOptions = {}): MethodDecorator {
  return (
    _target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const originalMethod = descriptor.value;

    const metadata: AiMeteredMetadata = {
      metering: options.metering ?? "required",
      tenantId: options.tenantId,
      usageExtractor: options.usageExtractor,
      embeddingUsageExtractor: options.embeddingUsageExtractor,
      idempotencyKeyExtractor: options.idempotencyKeyExtractor,
      metadataExtractor: options.metadataExtractor,
    };

    // 메타데이터 저장
    Reflect.defineMetadata(AI_METERED_METADATA_KEY, metadata, _target, propertyKey);

    descriptor.value = async function (...args: unknown[]): Promise<unknown> {
      const service = resolveLlmMeteringService(metadata.metering);

      // 원본 메서드 실행
      const result = await originalMethod.apply(this, args);

      if (!service) {
        return result;
      }

      const tenantId =
        metadata.tenantId ??
        Context.getTenantId() ??
        (this as { tenantId?: string }).tenantId ??
        "default";
      const idempotencyKey =
        metadata.idempotencyKeyExtractor?.(args) ?? `${String(propertyKey)}:${randomUUID()}`;
      const additionalMetadata = metadata.metadataExtractor?.(args, result);

      if (isAsyncIterable(result)) {
        return createMeteredAsyncIterable(result, {
          onComplete: async (usageInfo) => {
            if (!usageInfo) {
              return;
            }

            await service.recordUsage({
              tenantId,
              modelId: usageInfo.modelId,
              provider: usageInfo.provider,
              usage: usageInfo.usage,
              idempotencyKey,
              metadata: {
                ...additionalMetadata,
                operationType: "stream",
                modelId: usageInfo.modelId,
              },
            });
          },
        });
      }

      const extractedUsage = metadata.usageExtractor?.(args, result);

      if (extractedUsage) {
        const { modelId, provider } = getResultModelMetadata(result);

        await service.recordUsage({
          tenantId,
          modelId,
          provider,
          usage: {
            promptTokens: extractedUsage.promptTokens,
            completionTokens: extractedUsage.completionTokens,
            totalTokens: extractedUsage.promptTokens + extractedUsage.completionTokens,
            accuracy: extractedUsage.accuracy,
          },
          idempotencyKey,
          metadata: { ...additionalMetadata, operationType: "generate", modelId },
        });

        return result;
      }

      const extractedEmbeddingUsage = metadata.embeddingUsageExtractor?.(args, result);

      if (extractedEmbeddingUsage) {
        const { modelId, provider } = getResultModelMetadata(result);

        await service.recordEmbeddingUsage({
          tenantId,
          modelId,
          provider,
          embeddingTokens: extractedEmbeddingUsage.tokens,
          idempotencyKey,
          accuracy: extractedEmbeddingUsage.accuracy,
        });

        return result;
      }

      // GenerateResult 타입 감지 (usage 필드 확인)
      if (result && typeof result === "object" && "usage" in result) {
        const usageData = (result as { usage: unknown }).usage;

        if (usageData && typeof usageData === "object") {
          // LlmUsage 타입: promptTokens + completionTokens
          if ("promptTokens" in usageData && "completionTokens" in usageData) {
            const usage = usageData as {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
              accuracy?: "EXACT" | "ESTIMATED" | "UNKNOWN";
            };
            const { modelId, provider } = getResultModelMetadata(result);

            // recordUsage 호출
            await service.recordUsage({
              tenantId,
              modelId,
              provider,
              usage: {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                accuracy: usage.accuracy,
              },
              idempotencyKey,
              metadata: { ...additionalMetadata, operationType: "generate", modelId },
            });
          }
          // EmbedResult 타입: tokens (또는 embedding 존재)
          else if ("tokens" in usageData || "embedding" in result) {
            const tokens = "tokens" in usageData ? (usageData as { tokens: number }).tokens : 0;
            const accuracy =
              "accuracy" in usageData
                ? (usageData as { accuracy?: "EXACT" | "ESTIMATED" | "UNKNOWN" }).accuracy
                : undefined;
            const { modelId, provider } = getResultModelMetadata(result);

            // recordEmbeddingUsage 호출
            await service.recordEmbeddingUsage({
              tenantId,
              modelId,
              provider,
              embeddingTokens: tokens,
              idempotencyKey,
              accuracy,
            });
          }
        }
      }

      return result;
    };

    return descriptor;
  };
}

/**
 * 메서드에서 AiMetered 메타데이터 조회
 */
export function getAiMeteredMetadata(
  target: object,
  propertyKey: string | symbol,
): AiMeteredMetadata | undefined {
  return Reflect.getMetadata(AI_METERED_METADATA_KEY, target, propertyKey);
}
