import type { EventBus } from "@croco/events-core";
import { Container, Context, type ILogger, LOGGER_TOKEN } from "@croco/framework-context";
import type { MeteringService } from "@croco/metering-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiMetered,
  runWithLlmMeteringService,
  setLlmMeteringService,
} from "../../libs/decorators/AiMetered";
import { LlmMeteringService } from "../../libs/LlmMeteringService";
import {
  LlmMeteringRecordFailedProblem,
  LlmMeteringServiceRequiredProblem,
} from "../../libs/problems/LlmMeteringProblems";

describe("@AiMetered decorator", () => {
  let mockMeteringService!: MeteringService;
  let mockEventBus!: EventBus;
  let mockLogger!: ILogger;
  let llmMeteringService!: LlmMeteringService;

  beforeEach(() => {
    Container.reset();

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as ILogger;
    Container.set(LOGGER_TOKEN, mockLogger);

    // Mock MeteringService
    mockMeteringService = {
      record: vi.fn().mockResolvedValue({ id: "test-record-id", tenantId: "tenant-123" }),
      getUsage: vi.fn().mockResolvedValue(1000),
    } as unknown as MeteringService;

    // Mock EventBus
    mockEventBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
    } as unknown as EventBus;

    llmMeteringService = new LlmMeteringService({
      meteringService: mockMeteringService,
      eventBus: mockEventBus,
    });

    // Set service for decorator
    setLlmMeteringService(llmMeteringService);
  });

  describe("generate/stream methods", () => {
    it("should automatically record usage when method returns GenerateResult", async () => {
      class TestService {
        tenantId = "tenant-123";

        @AiMetered()
        async generateText(_prompt: string) {
          // Simulate LlmService.generate() response
          return {
            text: "Hello, world!",
            usage: {
              promptTokens: 10,
              completionTokens: 20,
              totalTokens: 30,
              accuracy: "EXACT" as const,
            },
            metadata: {
              modelId: "gpt-4",
              provider: "openai",
            },
          };
        }
      }

      const service = new TestService();
      const result = await service.generateText("test");

      expect(result.text).toBe("Hello, world!");
      expect(mockMeteringService.record).toHaveBeenCalled();
    });

    it("should extract usage from result and record 3 meters", async () => {
      class TestService {
        @AiMetered()
        async generate() {
          return {
            text: "Response",
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
            },
            metadata: {
              modelId: "gpt-4",
              provider: "openai",
            },
          };
        }
      }

      const service = new TestService();
      await service.generate();

      // Verify 3 records: prompt, completion, cost
      expect(mockMeteringService.record).toHaveBeenCalledTimes(3);
    });

    it("should record usage returned by a custom usage extractor", async () => {
      const usageExtractor = vi.fn((_args: unknown[], _result: unknown) => ({
        promptTokens: 17,
        completionTokens: 29,
        accuracy: "ESTIMATED" as const,
      }));

      class TestService {
        @AiMetered({ usageExtractor })
        async generate(prompt: string) {
          return {
            data: { prompt, response: "custom" },
            metadata: { modelId: "custom-model", provider: "custom-provider" },
          };
        }
      }

      const result = await new TestService().generate("hello");

      expect(usageExtractor).toHaveBeenCalledWith(["hello"], result);
      expect(mockMeteringService.record).toHaveBeenCalledTimes(3);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.prompt_tokens",
          value: 17,
          metadata: expect.objectContaining({
            accuracy: "ESTIMATED",
            modelId: "custom-model",
            provider: "custom-provider",
          }),
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.completion_tokens", value: 29 }),
      );
    });

    it("should prefer custom usage over automatically detected usage", async () => {
      const embeddingUsageExtractor = vi.fn(() => ({ tokens: 29 }));

      class TestService {
        @AiMetered({
          usageExtractor: () => ({ promptTokens: 7, completionTokens: 11 }),
          embeddingUsageExtractor,
        })
        async generate() {
          return {
            usage: { promptTokens: 101, completionTokens: 103, totalTokens: 204 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      await new TestService().generate();

      expect(mockMeteringService.record).toHaveBeenCalledTimes(3);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.prompt_tokens", value: 7 }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.completion_tokens", value: 11 }),
      );
      expect(embeddingUsageExtractor).not.toHaveBeenCalled();
    });

    it("should fall back to automatic usage detection when custom extractors return null", async () => {
      const usageExtractor = vi.fn().mockReturnValue(null);
      const embeddingUsageExtractor = vi.fn().mockReturnValue(null);

      class TestService {
        @AiMetered({ usageExtractor, embeddingUsageExtractor })
        async generate() {
          return {
            usage: { promptTokens: 13, completionTokens: 19, totalTokens: 32 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      await new TestService().generate();

      expect(usageExtractor).toHaveBeenCalledOnce();
      expect(embeddingUsageExtractor).toHaveBeenCalledOnce();
      expect(mockMeteringService.record).toHaveBeenCalledTimes(3);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.prompt_tokens", value: 13 }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.completion_tokens", value: 19 }),
      );
    });

    it("should not inspect metadata when custom extractors return null without usage", async () => {
      const metadataGetter = vi.fn(() => {
        throw new Error("metadata should not be read");
      });

      class TestService {
        @AiMetered({
          usageExtractor: () => null,
          embeddingUsageExtractor: () => null,
        })
        async generate() {
          return Object.defineProperty({ data: "unchanged" }, "metadata", {
            get: metadataGetter,
          });
        }
      }

      const result = await new TestService().generate();

      expect(result.data).toBe("unchanged");
      expect(metadataGetter).not.toHaveBeenCalled();
      expect(mockMeteringService.record).not.toHaveBeenCalled();
    });

    it("should use custom idempotencyKeyExtractor", async () => {
      class TestService {
        @AiMetered({
          idempotencyKeyExtractor: (args) => args[0] as string,
        })
        async generate(_id: string, text: string) {
          return {
            text,
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      const service = new TestService();
      await service.generate("custom-key-123", "test");
      await service.generate("custom-key-123", "test");

      expect(
        vi.mocked(mockMeteringService.record).mock.calls.map(([record]) => record.idempotencyKey),
      ).toEqual([
        "custom-key-123:prompt",
        "custom-key-123:completion",
        "custom-key-123:cost",
        "custom-key-123:prompt",
        "custom-key-123:completion",
        "custom-key-123:cost",
      ]);
    });

    it("should use custom metadataExtractor", async () => {
      class TestService {
        @AiMetered({
          metadataExtractor: (args, _result) => ({
            customField: "custom-value",
            prompt: args[0],
          }),
        })
        async generate(_prompt: string) {
          return {
            text: "Response",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      const service = new TestService();
      await service.generate("my prompt");

      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            customField: "custom-value",
            prompt: "my prompt",
          }),
        }),
      );
    });

    it("BUG-07 스트림 결과의 토큰 사용량 기록", async () => {
      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield { delta: "Hello " };
          yield {
            delta: "world",
            usage: {
              promptTokens: 11,
              completionTokens: 12,
              totalTokens: 23,
              accuracy: "EXACT" as const,
            },
          };
        }
      }

      const service = new TestService();
      const stream = await Promise.resolve(service.stream());
      const chunks: string[] = [];

      for await (const chunk of stream) {
        chunks.push(chunk.delta);
      }

      expect(chunks.join("")).toBe("Hello world");
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.prompt_tokens",
          value: 11,
          metadata: expect.objectContaining({
            operationType: "stream",
          }),
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.completion_tokens",
          value: 12,
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.cost_usd_nanos",
          metadata: expect.objectContaining({
            operationType: "stream",
          }),
        }),
      );
    });

    it("should record stream usage when the consumer exits early", async () => {
      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield {
            delta: "enough",
            usage: {
              promptTokens: 13,
              completionTokens: 17,
              totalTokens: 30,
              accuracy: "EXACT" as const,
            },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
          yield { delta: "unused" };
        }
      }

      const stream = await Promise.resolve(new TestService().stream());

      for await (const _chunk of stream) {
        break;
      }

      expect(mockMeteringService.record).toHaveBeenCalledTimes(3);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.prompt_tokens",
          value: 13,
          metadata: expect.objectContaining({ operationType: "stream" }),
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.completion_tokens",
          value: 17,
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.cost_usd_nanos",
          metadata: expect.objectContaining({ operationType: "stream" }),
        }),
      );
    });

    it("should record stream usage and preserve an error thrown by the consumer", async () => {
      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield {
            delta: "enough",
            usage: {
              promptTokens: 19,
              completionTokens: 23,
              totalTokens: 42,
            },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
          yield { delta: "unused" };
        }
      }

      const consumerError = new Error("consumer failed");
      const stream = await Promise.resolve(new TestService().stream());
      const consumeStream = async () => {
        for await (const _chunk of stream) {
          throw consumerError;
        }
      };

      await expect(consumeStream()).rejects.toBe(consumerError);
      expect(mockMeteringService.record).toHaveBeenCalledTimes(3);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.prompt_tokens",
          value: 19,
          metadata: expect.objectContaining({ operationType: "stream" }),
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.completion_tokens",
          value: 23,
        }),
      );
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.cost_usd_nanos" }),
      );
    });
  });

  describe("independent invocation metering", () => {
    class TestService {
      @AiMetered()
      async generate(_prompt: string) {
        return {
          text: "Response",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          metadata: { modelId: "gpt-4", provider: "openai" },
        };
      }

      @AiMetered()
      async embed(_prompt: string) {
        return {
          embedding: [0.1, 0.2],
          usage: { tokens: 10 },
          metadata: { modelId: "text-embedding-3-small", provider: "openai" },
        };
      }

      @AiMetered()
      async *stream(_prompt: string) {
        yield {
          delta: "Response",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          metadata: { modelId: "gpt-4", provider: "openai" },
        };
      }
    }

    describe.each(["generate", "embed", "stream"] as const)("%s", (method) => {
      it.each(["without context", "same request", "concurrent same request"])(
        "should retain both identical invocations %s",
        async (execution) => {
          const persisted = new Map<string, Parameters<MeteringService["record"]>[0]>();
          vi.mocked(mockMeteringService.record).mockImplementation(async (record) => {
            const key = `${record.tenantId}:${record.meterId}:${record.idempotencyKey}`;
            if (!persisted.has(key)) {
              persisted.set(key, record);
            }
            return { id: key, tenantId: record.tenantId } as Awaited<
              ReturnType<MeteringService["record"]>
            >;
          });
          const service = new TestService();
          const invoke = async () => {
            if (method === "stream") {
              const stream = await service.stream("identical prompt");
              for await (const _chunk of stream) {
                // Consume the complete provider operation.
              }
            } else {
              await service[method]("identical prompt");
            }
          };
          const invokeTwice = async () => {
            if (execution === "concurrent same request") {
              await Promise.all([invoke(), invoke()]);
            } else {
              await invoke();
              await invoke();
            }
          };

          if (execution === "without context") {
            await invokeTwice();
          } else {
            await Context.run(
              { requestId: "shared-request", tenantId: "tenant-context" },
              invokeTwice,
            );
          }

          const tokenMeter = method === "embed" ? "llm.embedding_tokens" : "llm.prompt_tokens";
          const tokenRecords = [...persisted.values()].filter(
            (record) => record.meterId === tokenMeter,
          );
          expect(tokenRecords.map((record) => record.value)).toEqual([10, 10]);
          expect(persisted.size).toBe(method === "embed" ? 4 : 6);
          expect(new Set([...persisted.values()].map((record) => record.tenantId))).toEqual(
            new Set([execution === "without context" ? "default" : "tenant-context"]),
          );
        },
      );
    });

    it("should use a fresh default key when the custom extractor returns undefined", async () => {
      class TestService {
        @AiMetered({ idempotencyKeyExtractor: () => undefined })
        async generate() {
          return {
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      const service = new TestService();
      await service.generate();
      await service.generate();

      const keys = vi
        .mocked(mockMeteringService.record)
        .mock.calls.filter(([record]) => record.meterId === "llm.prompt_tokens")
        .map(([record]) => record.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
    });
  });

  describe("tenant resolution", () => {
    it.each([
      {
        name: "explicit tenant over Context and instance",
        explicit: "explicit",
        context: "context",
        instance: "instance",
        expected: "explicit",
      },
      {
        name: "Context tenant over instance",
        explicit: undefined,
        context: "context",
        instance: "instance",
        expected: "context",
      },
      {
        name: "Context tenant without instance",
        explicit: undefined,
        context: "context",
        instance: undefined,
        expected: "context",
      },
      {
        name: "instance tenant without Context",
        explicit: undefined,
        context: undefined,
        instance: "instance",
        expected: "instance",
      },
      {
        name: "default tenant without Context or instance",
        explicit: undefined,
        context: undefined,
        instance: undefined,
        expected: "default",
      },
    ])("should use $name", async ({ explicit, context, instance, expected }) => {
      class TestService {
        tenantId = instance;

        @AiMetered({ tenantId: explicit })
        async generate() {
          return {
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      const service = new TestService();
      if (context === undefined) {
        await service.generate();
      } else {
        await Context.run({ requestId: "tenant-request", tenantId: context }, () =>
          service.generate(),
        );
      }

      expect(
        vi.mocked(mockMeteringService.record).mock.calls.map(([record]) => record.tenantId),
      ).toEqual([expected, expected, expected]);
    });

    it("should isolate Context tenants during concurrent calls on one instance", async () => {
      class TestService {
        tenantId = "instance";

        @AiMetered()
        async generate() {
          await Promise.resolve();
          return {
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      const service = new TestService();
      await Promise.all(
        ["tenant-a", "tenant-b"].map((tenantId) =>
          Context.run({ requestId: tenantId, tenantId }, () => service.generate()),
        ),
      );

      const tenants = vi
        .mocked(mockMeteringService.record)
        .mock.calls.filter(([record]) => record.meterId === "llm.prompt_tokens")
        .map(([record]) => record.tenantId);
      expect(tenants.sort()).toEqual(["tenant-a", "tenant-b"]);
    });
  });

  describe("embed/embedMany methods", () => {
    it("should record embedding usage for embed results", async () => {
      class TestService {
        @AiMetered()
        async embed(_text: string) {
          return {
            embedding: [0.1, 0.2, 0.3],
            usage: {
              tokens: 5,
            },
            metadata: {
              modelId: "text-embedding-3-small",
              provider: "openai",
            },
          };
        }
      }

      const service = new TestService();
      const result = await service.embed("test");

      expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
      expect(mockMeteringService.record).toHaveBeenCalled();
    });

    it("should record tokens returned by a custom embedding usage extractor", async () => {
      const embeddingUsageExtractor = vi.fn((_args: unknown[], _result: unknown) => ({
        tokens: 23,
        accuracy: "EXACT" as const,
      }));

      class TestService {
        @AiMetered({ embeddingUsageExtractor })
        async embed(text: string) {
          return {
            data: { text, vector: [0.1, 0.2] },
            metadata: { modelId: "custom-embedding", provider: "custom-provider" },
          };
        }
      }

      const result = await new TestService().embed("hello");

      expect(embeddingUsageExtractor).toHaveBeenCalledWith(["hello"], result);
      expect(mockMeteringService.record).toHaveBeenCalledTimes(2);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          meterId: "llm.embedding_tokens",
          value: 23,
          metadata: expect.objectContaining({
            accuracy: "EXACT",
            model: "custom-embedding",
            provider: "custom-provider",
          }),
        }),
      );
    });

    it("should fall back to automatic embedding usage when the custom extractor returns null", async () => {
      const embeddingUsageExtractor = vi.fn().mockReturnValue(null);

      class TestService {
        @AiMetered({ embeddingUsageExtractor })
        async embed() {
          return {
            embedding: [0.1, 0.2],
            usage: { tokens: 31 },
            metadata: { modelId: "text-embedding-3-small", provider: "openai" },
          };
        }
      }

      await new TestService().embed();

      expect(embeddingUsageExtractor).toHaveBeenCalledOnce();
      expect(mockMeteringService.record).toHaveBeenCalledTimes(2);
      expect(mockMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ meterId: "llm.embedding_tokens", value: 31 }),
      );
    });
  });

  describe("metering failure behavior", () => {
    it("should throw when metering fails", async () => {
      class TestService {
        @AiMetered()
        async generate() {
          return {
            text: "Response",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      // Mock record to throw
      vi.mocked(mockMeteringService.record).mockRejectedValue(new Error("Metering failed"));

      const service = new TestService();
      await expect(service.generate()).rejects.toThrow(LlmMeteringRecordFailedProblem);
    });

    it("should throw when stream metering fails after completion", async () => {
      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield { delta: "Hello " };
          yield {
            delta: "world",
            usage: {
              promptTokens: 10,
              completionTokens: 10,
              totalTokens: 20,
            },
          };
        }
      }

      vi.mocked(mockMeteringService.record).mockRejectedValue(new Error("Stream metering failed"));

      const service = new TestService();
      const stream = await Promise.resolve(service.stream());
      const consumeStream = async () => {
        for await (const _chunk of stream) {
          // Consume the stream so completion metering runs.
        }
      };

      await expect(consumeStream()).rejects.toThrow(LlmMeteringRecordFailedProblem);
    });

    it("should surface stream metering failure when the consumer exits early", async () => {
      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield {
            delta: "enough",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          };
          yield { delta: "unused" };
        }
      }

      vi.mocked(mockMeteringService.record).mockRejectedValue(new Error("Stream metering failed"));

      const stream = await Promise.resolve(new TestService().stream());
      const consumeStream = async () => {
        for await (const _chunk of stream) {
          break;
        }
      };

      await expect(consumeStream()).rejects.toThrow(LlmMeteringRecordFailedProblem);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[LlmMetering] Failed to finalize stream usage recording",
        expect.objectContaining({
          meteringError: expect.any(LlmMeteringRecordFailedProblem),
        }),
      );
    });

    it("should preserve a provider stream error and report a concurrent metering failure", async () => {
      const providerError = new Error("Provider stream failed");

      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield {
            delta: "partial",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          };
          throw providerError;
        }
      }

      vi.mocked(mockMeteringService.record).mockRejectedValue(new Error("Stream metering failed"));

      const stream = await Promise.resolve(new TestService().stream());
      const consumeStream = async () => {
        for await (const _chunk of stream) {
          // Consume until the provider fails.
        }
      };

      await expect(consumeStream()).rejects.toBe(providerError);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[LlmMetering] Failed to finalize stream usage recording",
        expect.objectContaining({
          iterationError: providerError,
          meteringError: expect.any(LlmMeteringRecordFailedProblem),
        }),
      );
    });

    it("should preserve a consumer error and report a concurrent metering failure", async () => {
      class TestService {
        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield {
            delta: "partial",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          };
          yield { delta: "unused" };
        }
      }

      vi.mocked(mockMeteringService.record).mockRejectedValue(new Error("Stream metering failed"));

      const consumerError = new Error("Consumer failed");
      const stream = await Promise.resolve(new TestService().stream());
      const consumeStream = async () => {
        for await (const _chunk of stream) {
          throw consumerError;
        }
      };

      await expect(consumeStream()).rejects.toBe(consumerError);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "[LlmMetering] Failed to finalize stream usage recording",
        expect.objectContaining({
          meteringError: expect.any(LlmMeteringRecordFailedProblem),
        }),
      );
    });

    it("should fail before the original method runs when LlmMeteringService is not set", async () => {
      setLlmMeteringService(null);
      const originalMethod = vi.fn().mockResolvedValue({
        text: "Response",
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        metadata: { modelId: "gpt-4", provider: "openai" },
      });

      class TestService {
        @AiMetered()
        async generate() {
          return originalMethod();
        }
      }

      const service = new TestService();

      await expect(service.generate()).rejects.toThrow(LlmMeteringServiceRequiredProblem);
      expect(originalMethod).not.toHaveBeenCalled();
      expect(mockMeteringService.record).not.toHaveBeenCalled();
    });

    it("should skip metering only when the decorator explicitly disables it", async () => {
      setLlmMeteringService(null);

      class TestService {
        @AiMetered({ metering: "disabled" })
        async generate() {
          return {
            text: "Response",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      const result = await new TestService().generate();

      expect(result.text).toBe("Response");
      expect(mockMeteringService.record).not.toHaveBeenCalled();
    });
  });

  describe("scoped metering service", () => {
    it("should isolate concurrent tenant executions", async () => {
      const firstMeteringService = {
        record: vi.fn().mockResolvedValue({ id: "first-record", tenantId: "tenant-1" }),
        getUsage: vi.fn().mockResolvedValue(0),
      } as unknown as MeteringService;
      const secondMeteringService = {
        record: vi.fn().mockResolvedValue({ id: "second-record", tenantId: "tenant-2" }),
        getUsage: vi.fn().mockResolvedValue(0),
      } as unknown as MeteringService;
      const firstLlmMeteringService = new LlmMeteringService({
        meteringService: firstMeteringService,
        eventBus: mockEventBus,
      });
      const secondLlmMeteringService = new LlmMeteringService({
        meteringService: secondMeteringService,
        eventBus: mockEventBus,
      });

      class TestService {
        constructor(readonly tenantId: string) {}

        @AiMetered()
        async generate(prompt: string) {
          await Promise.resolve();
          return {
            text: prompt,
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
            metadata: { modelId: "gpt-4", provider: "openai" },
          };
        }
      }

      await Promise.all([
        runWithLlmMeteringService(firstLlmMeteringService, () =>
          new TestService("tenant-1").generate("first"),
        ),
        runWithLlmMeteringService(secondLlmMeteringService, () =>
          new TestService("tenant-2").generate("second"),
        ),
      ]);

      expect(firstMeteringService.record).toHaveBeenCalledTimes(3);
      expect(firstMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-1" }),
      );
      expect(secondMeteringService.record).toHaveBeenCalledTimes(3);
      expect(secondMeteringService.record).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-2" }),
      );
      expect(mockMeteringService.record).not.toHaveBeenCalled();
    });

    it("should preserve the creation service and Context tenant until streaming completes", async () => {
      const scopedMeteringService = {
        record: vi.fn().mockResolvedValue({ id: "scoped-record", tenantId: "tenant-scoped" }),
        getUsage: vi.fn().mockResolvedValue(0),
      } as unknown as MeteringService;
      const scopedLlmMeteringService = new LlmMeteringService({
        meteringService: scopedMeteringService,
        eventBus: mockEventBus,
      });

      class TestService {
        tenantId = "tenant-scoped";

        @AiMetered()
        stream() {
          return this.createStream();
        }

        private async *createStream() {
          yield {
            delta: "done",
            usage: {
              promptTokens: 5,
              completionTokens: 7,
              totalTokens: 12,
            },
          };
        }
      }

      const stream = await Context.run(
        { requestId: "creation-request", tenantId: "tenant-creation" },
        () => runWithLlmMeteringService(scopedLlmMeteringService, () => new TestService().stream()),
      );

      await Context.run(
        { requestId: "consumption-request", tenantId: "tenant-consumption" },
        async () => {
          for await (const _chunk of stream) {
            // Consume outside the service and tenant scopes that created the stream.
          }
        },
      );

      expect(
        vi.mocked(scopedMeteringService.record).mock.calls.map(([record]) => record.tenantId),
      ).toEqual(["tenant-creation", "tenant-creation", "tenant-creation"]);
      expect(mockMeteringService.record).not.toHaveBeenCalled();
    });
  });

  describe("metadata storage", () => {
    it("should store metadata on the method", () => {
      class TestService {
        @AiMetered({
          tenantId: "custom-tenant",
        })
        async generate() {
          return {
            text: "test",
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          };
        }
      }

      const prototype = TestService.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "generate");
      expect(descriptor).not.toBeUndefined();
    });
  });
});
