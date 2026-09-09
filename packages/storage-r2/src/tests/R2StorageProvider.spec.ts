import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type {
  PutObjectCommand as AwsPutObjectCommand,
  PutObjectCommandInput,
  S3Client as AwsS3Client,
  S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ConfigService } from "@croco/framework-config";
import { Container } from "@croco/framework-context";
import type { Logger } from "@croco/framework-logger";
import {
  DeleteFailedProblem,
  FileNotFoundProblem,
  MAX_SIGNED_URL_EXPIRY_SECONDS,
  readStorageBody,
  readStorageStream,
  StorageOperationAbortedProblem,
  UploadFailedProblem,
} from "@croco/storage-core";
import type { StorageStream } from "@croco/storage-core";
import { nodeReadableToStorageStream, storageStreamToNodeReadable } from "@croco/storage-core/node";
import { createStorageProviderConformanceSuite } from "@croco/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmptyR2BodyProblem } from "../libs/problems/EmptyR2BodyProblem";
import { MissingR2ConfigProblem } from "../libs/problems/MissingR2ConfigProblem";
import { R2ObjectTooLargeProblem } from "../libs/problems/R2ObjectTooLargeProblem";
import { R2StorageDiagnosticsProvider } from "../libs/R2StorageDiagnosticsProvider";
import { R2StorageProvider } from "../libs/R2StorageProvider";
import type { R2Options } from "../libs/types";

const mockSend = vi.fn();
const mockClientConstructor = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    constructor(options: unknown) {
      mockClientConstructor(options);
    }

    send = mockSend;
  },
  GetObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  HeadObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async (_client: unknown, command: MockS3Command) => {
    return `https://signed-url.example.com/${command.input.Key}`;
  }),
}));

type MockS3Command = {
  readonly constructor: {
    readonly name: string;
  };
  readonly input: {
    readonly Body?: Uint8Array | Readable;
    readonly ContentType?: string;
    readonly Key?: string;
    readonly Metadata?: Record<string, string>;
  };
};

type ActualS3Module = {
  readonly PutObjectCommand: new (input: PutObjectCommandInput) => AwsPutObjectCommand;
  readonly S3Client: new (config: S3ClientConfig) => AwsS3Client;
};

type StoredR2Object = {
  readonly data: Uint8Array;
  readonly contentType?: string;
  readonly lastModified: Date;
  readonly metadata?: Record<string, string>;
};

describe("R2StorageProvider", () => {
  let provider!: R2StorageProvider;
  let configService!: ConfigService;
  let logger!: Logger;

  const defaultEnvs: Record<string, string> = {
    R2_ACCOUNT_ID: "test-account-id",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
    R2_BUCKET: "test-bucket",
  };
  const defaultOptions: R2Options = {
    accountId: defaultEnvs.R2_ACCOUNT_ID,
    accessKeyId: defaultEnvs.R2_ACCESS_KEY_ID,
    secretAccessKey: defaultEnvs.R2_SECRET_ACCESS_KEY,
    bucket: defaultEnvs.R2_BUCKET,
  };

  beforeEach(() => {
    Container.reset();
    mockSend.mockReset();
    mockClientConstructor.mockReset();
    vi.mocked(getSignedUrl).mockClear();

    configService = {
      get: vi.fn((key: string) => defaultEnvs[key]),
    } as unknown as ConfigService;

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: () => logger,
    } as unknown as Logger;

    provider = new R2StorageProvider(configService, logger);
  });

  describe("missing object errors", () => {
    describe.each(["NoSuchKey", "NotFound"])("%s", (name) => {
      it.each([
        ["absent", {}],
        ["empty", { $metadata: {} }],
        ["non-404", { $metadata: { httpStatusCode: 400 } }],
      ])("recognizes the name with %s metadata", async (_label, metadata) => {
        const error = Object.assign(new Error("Missing object"), { name }, metadata);
        mockSend.mockRejectedValue(error);

        for (const operation of ["get", "getStream", "getMetadata"] as const) {
          const result = provider[operation]("missing.txt");
          await expect(result).rejects.toBeInstanceOf(FileNotFoundProblem);
          await expect(result).rejects.toMatchObject({ cause: error });
        }
        await expect(provider.exists("missing.txt")).resolves.toBe(false);
      });
    });

    it.each(["AccessDenied", "ServiceUnavailable"])(
      "preserves unrelated %s errors",
      async (name) => {
        const error = Object.assign(new Error("Storage failure"), {
          name,
          $metadata: { httpStatusCode: 403 },
        });
        mockSend.mockRejectedValue(error);

        for (const operation of ["get", "getStream", "getMetadata", "exists"] as const) {
          await expect(provider[operation]("test.txt")).rejects.toBe(error);
        }
      },
    );
  });

  describe("storage provider conformance", () => {
    it.each(
      createStorageProviderConformanceSuite({
        createProvider: () => {
          useInMemoryR2Backend();
          return provider;
        },
        keyPrefix: "r2-conformance",
        metadata: {
          contentType: "required",
          customMetadata: "required",
        },
        providerName: "storage-r2",
        publicUrl: "https://test-bucket.test-account-id.r2.dev/",
        signedUrl: "https://signed-url.example.com",
      }).cases,
    )("$name", async ({ run }) => {
      await run();
    });
  });

  describe("constructor", () => {
    it("configures streaming uploads without optional checksum calculation", () => {
      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ requestChecksumCalculation: "WHEN_REQUIRED" }),
      );
    });

    it("rejects blank configuration before constructing an R2 client", () => {
      mockClientConstructor.mockClear();
      vi.mocked(configService.get).mockImplementation((key: string) => {
        if (key === "R2_SECRET_ACCESS_KEY") {
          return " \t\n ";
        }

        return defaultEnvs[key];
      });

      expect(() => new R2StorageProvider(configService, logger)).toThrow(
        "Missing required R2 configuration: R2_SECRET_ACCESS_KEY",
      );
      expect(mockClientConstructor).not.toHaveBeenCalled();
    });

    it.each([["R2_ACCOUNT_ID"], ["R2_ACCESS_KEY_ID"], ["R2_SECRET_ACCESS_KEY"], ["R2_BUCKET"]])(
      "should throw MissingR2ConfigProblem when %s is missing",
      (missingKey) => {
        vi.mocked(configService.get).mockImplementation((key: string) => {
          if (key === missingKey) {
            return undefined;
          }

          return defaultEnvs[key];
        });

        expect(() => new R2StorageProvider(configService, logger)).toThrow(MissingR2ConfigProblem);
        expect(() => new R2StorageProvider(configService, logger)).toThrow(
          `Missing required R2 configuration: ${missingKey}`,
        );
      },
    );

    it("should throw MissingR2ConfigProblem with all missing keys", () => {
      vi.mocked(configService.get).mockReturnValue(undefined);

      expect(() => new R2StorageProvider(configService, logger)).toThrow(
        "Missing required R2 configuration: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET",
      );
    });
  });

  describe("diagnostics", () => {
    it("reports missing required configuration without leaking secret values", async () => {
      const diagnostics = new R2StorageDiagnosticsProvider({
        accountId: "test-account-id",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
        bucket: "",
      });

      const health = await diagnostics.getHealth();

      expect(health).toMatchObject({
        status: "unhealthy",
        component: "storage-r2",
        details: expect.objectContaining({
          provider: "cloudflare-r2",
          hasAccountId: true,
          hasAccessKeyId: true,
          hasSecretAccessKey: true,
          hasBucket: false,
          missingConfig: ["R2_BUCKET"],
          liveCheck: "not_started",
          problemCode: "STORAGE_R2_MISSING_CONFIG",
        }),
      });
      expect(JSON.stringify(health)).not.toContain("test-access-key");
      expect(JSON.stringify(health)).not.toContain("test-secret-key");
    });

    it("reports healthy readiness when required config exists and no live check is configured", async () => {
      const diagnostics = new R2StorageDiagnosticsProvider(defaultOptions);

      const health = await diagnostics.getHealth();

      expect(health).toMatchObject({
        status: "healthy",
        component: "storage-r2",
        details: expect.objectContaining({
          provider: "cloudflare-r2",
          hasAccountId: true,
          hasAccessKeyId: true,
          hasSecretAccessKey: true,
          hasBucket: true,
          missingConfig: [],
          liveCheck: "not_configured",
        }),
      });
      expect(JSON.stringify(health)).not.toContain(defaultOptions.accessKeyId);
      expect(JSON.stringify(health)).not.toContain(defaultOptions.secretAccessKey);
    });

    it("sanitizes live readiness details before returning diagnostics", async () => {
      const controller = new AbortController();
      const diagnostics = new R2StorageDiagnosticsProvider(defaultOptions, {
        readinessCheck: async ({ config, signal }) => {
          expect(config.bucket).toBe(defaultOptions.bucket);
          expect(signal).toBe(controller.signal);

          return {
            details: {
              accessKeyId: "leaked-access-key",
              nested: {
                secretAccessKey: "leaked-secret-key",
                bucket: "visible-bucket",
              },
            },
          };
        },
      });

      const health = await diagnostics.getHealth(controller.signal);

      expect(health.status).toBe("healthy");
      expect(health.details).toMatchObject({
        liveCheck: "passed",
        readiness: {
          accessKeyId: "[redacted]",
          nested: {
            secretAccessKey: "[redacted]",
            bucket: "visible-bucket",
          },
        },
      });
      expect(JSON.stringify(health)).not.toContain("leaked-access-key");
      expect(JSON.stringify(health)).not.toContain("leaked-secret-key");
    });

    it("reports upstream readiness failures as degraded instead of falling back to healthy", async () => {
      const diagnostics = new R2StorageDiagnosticsProvider(defaultOptions, {
        readinessCheck: async () => {
          throw {
            $metadata: { httpStatusCode: 503 },
            message: `R2 unavailable for ${defaultOptions.secretAccessKey}`,
            name: "ServiceUnavailable",
          };
        },
      });

      const health = await diagnostics.getHealth();

      expect(health).toMatchObject({
        status: "degraded",
        component: "storage-r2",
        details: expect.objectContaining({
          liveCheck: "failed",
          problemCode: "STORAGE_R2_READINESS_FAILED",
          upstreamCode: "ServiceUnavailable",
          upstreamStatus: 503,
        }),
      });
      expect(JSON.stringify(health)).not.toContain(defaultOptions.secretAccessKey);
    });
  });

  describe("getPublicUrl", () => {
    it("should return default R2 public URL when publicUrlBase is not set", () => {
      const url = provider.getPublicUrl("test/file.txt");
      expect(url).toBe("https://test-bucket.test-account-id.r2.dev/test/file.txt");
    });

    it("should return custom public URL when publicUrlBase is set", () => {
      vi.mocked(configService.get).mockImplementation((key: string) => {
        if (key === "R2_PUBLIC_URL_BASE") return "https://cdn.example.com";
        if (key === "R2_BUCKET") return "test-bucket";
        return "test-value";
      });

      const customProvider = new R2StorageProvider(configService, logger);
      const url = customProvider.getPublicUrl("test/file.txt");
      expect(url).toBe("https://cdn.example.com/test/file.txt");
    });
  });

  describe("getSignedUrl", () => {
    it("should generate signed URL with expiration", async () => {
      const url = await provider.getSignedUrl("test/file.txt", {
        expiresIn: MAX_SIGNED_URL_EXPIRY_SECONDS,
      });
      expect(url).toBe("https://signed-url.example.com/test/file.txt");
      expect(vi.mocked(getSignedUrl)).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        expiresIn: MAX_SIGNED_URL_EXPIRY_SECONDS,
      });
    });

    it("rejects when the signal aborts while presigning", async () => {
      const controller = new AbortController();
      const reason = new Error("presigning cancelled");
      vi.mocked(getSignedUrl).mockImplementationOnce(async () => {
        controller.abort(reason);
        return "https://signed-url.example.com/test/file.txt";
      });

      const signedUrlPromise = provider.getSignedUrl("test/file.txt", {
        expiresIn: 60,
        signal: controller.signal,
      });

      await expect(signedUrlPromise).rejects.toMatchObject({
        cause: reason,
        code: "STORAGE_OPERATION_ABORTED",
      });
    });
  });

  describe("getStream", () => {
    it("should return a readable stream from S3", async () => {
      mockSend.mockResolvedValue({
        Body: createMockR2Body([new TextEncoder().encode("stream")]),
      });

      const stream = await provider.getStream("test/file.txt");

      expect(stream).toBeInstanceOf(ReadableStream);
      await expect(readStorageStream(stream)).resolves.toEqual(new TextEncoder().encode("stream"));
    });

    it("should throw FileNotFoundProblem when S3 returns 404", async () => {
      mockSend.mockRejectedValue({
        $metadata: { httpStatusCode: 404 },
        name: "NotFound",
      });

      await expect(provider.getStream("test/file.txt")).rejects.toThrow(FileNotFoundProblem);
    });

    it("should throw error when response body is empty", async () => {
      mockSend.mockResolvedValue({
        Body: undefined,
      });

      const streamPromise = provider.getStream("test/file.txt");

      await expect(streamPromise).rejects.toBeInstanceOf(EmptyR2BodyProblem);
      await expect(streamPromise).rejects.toThrow("Empty response body");
    });

    it("keeps the returned stream linked to the operation signal", async () => {
      const controller = new AbortController();
      const reason = new Error("stream cancelled");
      mockSend.mockResolvedValue({
        Body: {
          transformToWebStream: () => new ReadableStream<Uint8Array>({ pull() {} }),
        },
      });

      const stream = await provider.getStream("test/file.txt", { signal: controller.signal });
      const streamRead = stream.getReader().read();
      controller.abort(reason);

      await expect(streamRead).rejects.toMatchObject({
        cause: reason,
        code: "STORAGE_OPERATION_ABORTED",
      });
    });
  });

  describe("get", () => {
    it("should buffer a small object into a Uint8Array", async () => {
      mockSend.mockResolvedValue({
        Body: createMockR2Body([
          new TextEncoder().encode("hello "),
          new TextEncoder().encode("world"),
        ]),
      });

      const bytes = await provider.get("test/file.txt");

      expect(bytes).toEqual(new TextEncoder().encode("hello world"));
    });

    it("should throw R2ObjectTooLargeProblem when buffered bytes exceed the limit", async () => {
      const oversizedChunk = new Uint8Array(6 * 1024 * 1024);
      mockSend.mockResolvedValue({
        Body: createMockR2Body([oversizedChunk, oversizedChunk]),
      });

      const getPromise = provider.get("test/file.txt");

      await expect(getPromise).rejects.toThrow(R2ObjectTooLargeProblem);
      await expect(getPromise).rejects.toThrow(
        "R2 object 'test/file.txt' exceeds the in-memory download limit of 10485760 bytes",
      );
    });

    it("should retry transient get failures before succeeding", async () => {
      mockSend
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 }, name: "ServiceUnavailable" })
        .mockResolvedValueOnce({
          Body: createMockR2Body([new TextEncoder().encode("hello world")]),
        });

      const bytes = await provider.get("test/file.txt");

      expect(bytes).toEqual(new TextEncoder().encode("hello world"));
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("put", () => {
    it("should upload object data", async () => {
      mockSend.mockResolvedValue({});

      await expect(provider.put("test/file.txt", Buffer.from("data"))).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should retry transient put failures for buffers before succeeding", async () => {
      mockSend
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 }, name: "ServiceUnavailable" })
        .mockResolvedValueOnce({});

      await expect(provider.put("test/file.txt", Buffer.from("data"))).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should not retry Web stream uploads on transient failures", async () => {
      mockSend.mockRejectedValueOnce({
        $metadata: { httpStatusCode: 503 },
        name: "ServiceUnavailable",
      });

      await expect(
        provider.put("test/file.txt", createStorageStream([new TextEncoder().encode("data")])),
      ).rejects.toThrow(UploadFailedProblem);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("adapts Web stream uploads to the Node AWS transport without buffering", async () => {
      mockSend.mockImplementation(async (command: MockS3Command) => {
        const body = command.input.Body;

        expect(body).toBeInstanceOf(Readable);
        await expect(readBody(body as Readable)).resolves.toEqual(
          new TextEncoder().encode("streamed data"),
        );
        return {};
      });

      await expect(
        provider.put(
          "test/file.txt",
          createStorageStream([
            new TextEncoder().encode("streamed "),
            new TextEncoder().encode("data"),
          ]),
        ),
      ).resolves.toBeUndefined();
    });

    it("sends an unknown-length stream through the real S3 middleware and Node transport", async () => {
      const receivedChunks: Uint8Array[] = [];
      const server = createServer(async (request, response) => {
        for await (const chunk of request) {
          receivedChunks.push(chunk);
        }
        response.statusCode = 200;
        response.end();
      });

      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Local S3 test server did not expose a TCP address");
      }

      const actualS3 = await vi.importActual<ActualS3Module>("@aws-sdk/client-s3");
      const client = new actualS3.S3Client({
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        endpoint: `http://127.0.0.1:${address.port}`,
        forcePathStyle: true,
        region: "auto",
        requestChecksumCalculation: "WHEN_REQUIRED",
      });

      try {
        await client.send(
          new actualS3.PutObjectCommand({
            Body: storageStreamToNodeReadable(
              createStorageStream([new TextEncoder().encode("streamed data")]),
            ),
            Bucket: "test-bucket",
            Key: "test/file.txt",
          }),
        );
      } finally {
        client.destroy();
        server.close();
        await once(server, "close");
      }

      expect(new TextDecoder().decode(Buffer.concat(receivedChunks))).toContain("streamed data");
    });
  });

  describe("delete", () => {
    it("should delete an object", async () => {
      mockSend.mockResolvedValue({});

      await expect(provider.delete("test/file.txt")).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("should retry transient delete failures before succeeding", async () => {
      mockSend
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 }, name: "ServiceUnavailable" })
        .mockResolvedValueOnce({});

      await expect(provider.delete("test/file.txt")).resolves.toBeUndefined();
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it("should throw DeleteFailedProblem for terminal delete failures", async () => {
      mockSend.mockRejectedValue(new Error("delete failed"));

      await expect(provider.delete("test/file.txt")).rejects.toThrow(DeleteFailedProblem);
    });
  });

  describe("getMetadata", () => {
    it("should return metadata for an object", async () => {
      const lastModified = new Date("2024-01-01T00:00:00.000Z");
      mockSend.mockResolvedValue({
        ContentLength: 123,
        ContentType: "image/png",
        LastModified: lastModified,
        ETag: "etag-123",
        Metadata: { foo: "bar" },
      });

      await expect(provider.getMetadata("test/file.txt")).resolves.toEqual({
        size: 123,
        contentType: "image/png",
        lastModified,
        etag: "etag-123",
        metadata: { foo: "bar" },
      });
    });

    it("should throw FileNotFoundProblem when metadata lookup returns 404", async () => {
      mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 }, name: "NotFound" });

      await expect(provider.getMetadata("test/file.txt")).rejects.toThrow(FileNotFoundProblem);
    });

    it("should retry transient metadata failures before succeeding", async () => {
      const lastModified = new Date("2024-01-01T00:00:00.000Z");
      mockSend
        .mockRejectedValueOnce({
          $metadata: { httpStatusCode: 429 },
          name: "TooManyRequestsException",
        })
        .mockResolvedValueOnce({
          ContentLength: 456,
          ContentType: "text/plain",
          LastModified: lastModified,
          ETag: "etag-456",
          Metadata: undefined,
        });

      await expect(provider.getMetadata("test/file.txt")).resolves.toEqual({
        size: 456,
        contentType: "text/plain",
        lastModified,
        etag: "etag-456",
        metadata: undefined,
      });
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("cancellation", () => {
    it("does not call the SDK or presigner for pre-aborted operations", async () => {
      const controller = new AbortController();
      const reason = new Error("cancelled before start");
      controller.abort(reason);

      const operations = [
        () => provider.put("test/file.txt", Buffer.from("data"), { signal: controller.signal }),
        () => provider.get("test/file.txt", { signal: controller.signal }),
        () => provider.getStream("test/file.txt", { signal: controller.signal }),
        () => provider.delete("test/file.txt", { signal: controller.signal }),
        () => provider.exists("test/file.txt", { signal: controller.signal }),
        () =>
          provider.getSignedUrl("test/file.txt", {
            expiresIn: 60,
            signal: controller.signal,
          }),
        () => provider.getMetadata("test/file.txt", { signal: controller.signal }),
      ];

      for (const operation of operations) {
        await expect(operation()).rejects.toMatchObject({
          cause: reason,
          code: "STORAGE_OPERATION_ABORTED",
        });
      }

      expect(mockSend).not.toHaveBeenCalled();
      expect(vi.mocked(getSignedUrl)).not.toHaveBeenCalled();
    });

    it.each([
      [
        "put",
        (signal: AbortSignal) => provider.put("test/file.txt", Buffer.from("data"), { signal }),
      ],
      ["delete", (signal: AbortSignal) => provider.delete("test/file.txt", { signal })],
    ])("surfaces in-flight %s cancellation without failure wrappers", async (_name, operation) => {
      const controller = new AbortController();
      const reason = new Error("cancelled in flight");
      mockSend.mockImplementation(
        async (_command: unknown, requestOptions: { abortSignal?: AbortSignal }) =>
          await new Promise((_resolve, reject) => {
            requestOptions.abortSignal?.addEventListener(
              "abort",
              () => {
                const abortError = new Error("aborted by SDK");
                abortError.name = "AbortError";
                reject(abortError);
              },
              { once: true },
            );
          }),
      );

      const operationPromise = operation(controller.signal);
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
      expect(mockSend.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
      controller.abort(reason);

      await expect(operationPromise).rejects.toBeInstanceOf(StorageOperationAbortedProblem);
      await expect(operationPromise).rejects.toMatchObject({
        cause: reason,
        code: "STORAGE_OPERATION_ABORTED",
      });
    });

    it("terminates the upload source when a streaming put is aborted", async () => {
      const controller = new AbortController();
      const reason = new Error("cancel streaming upload");
      let resolveSourceCancellation!: (reason: unknown) => void;
      const sourceCancellation = new Promise<unknown>((resolve) => {
        resolveSourceCancellation = resolve;
      });
      const source = new ReadableStream<Uint8Array>({
        pull() {},
        cancel(cancellationReason) {
          resolveSourceCancellation(cancellationReason);
        },
      });
      mockSend.mockImplementation(
        async (command: MockS3Command, requestOptions: { abortSignal?: AbortSignal }) => {
          const body = command.input.Body;
          if (body instanceof Readable) {
            body.once("error", () => undefined);
          }

          return await new Promise((_resolve, reject) => {
            requestOptions.abortSignal?.addEventListener(
              "abort",
              () => {
                const abortError = new Error("aborted by SDK");
                abortError.name = "AbortError";
                reject(abortError);
              },
              { once: true },
            );
          });
        },
      );

      const upload = provider.put("test/file.txt", source, { signal: controller.signal });
      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      await expect(sourceCancellation).resolves.toMatchObject({
        cause: reason,
        code: "STORAGE_OPERATION_ABORTED",
      });
      await expect(upload).rejects.toMatchObject({
        cause: reason,
        code: "STORAGE_OPERATION_ABORTED",
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("rejects immediately when the signal aborts during retry backoff", async () => {
      const controller = new AbortController();
      const reason = new Error("cancel during backoff");
      let rejectFirstAttempt!: (reason: unknown) => void;
      mockSend
        .mockImplementationOnce(
          async () =>
            await new Promise((_resolve, reject) => {
              rejectFirstAttempt = reject;
            }),
        )
        .mockResolvedValueOnce({});

      const putPromise = provider.put("test/file.txt", Buffer.from("data"), {
        signal: controller.signal,
      });
      let rejection: unknown;
      let settled = false;
      void putPromise.catch((error: unknown) => {
        rejection = error;
        settled = true;
      });

      await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
      vi.useFakeTimers();

      try {
        rejectFirstAttempt({
          $metadata: { httpStatusCode: 503 },
          name: "ServiceUnavailable",
        });

        for (let index = 0; index < 20 && vi.getTimerCount() === 0; index += 1) {
          await Promise.resolve();
        }
        expect(vi.getTimerCount()).toBe(1);

        controller.abort(reason);
        for (let index = 0; index < 20 && !settled; index += 1) {
          await Promise.resolve();
        }

        expect(settled).toBe(true);
        expect(rejection).toMatchObject({
          cause: reason,
          code: "STORAGE_OPERATION_ABORTED",
        });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

function useInMemoryR2Backend(): void {
  const objects = new Map<string, StoredR2Object>();

  mockSend.mockImplementation(async (command: MockS3Command) => {
    const key = command.input.Key;

    if (!key) {
      throw new Error("R2 command is missing Key");
    }

    if (command.constructor.name === "PutObjectCommand") {
      const body = command.input.Body;

      if (!body) {
        throw new Error("R2 PutObjectCommand is missing Body");
      }

      objects.set(key, {
        contentType: command.input.ContentType,
        data: await readBody(body),
        lastModified: new Date("2026-01-01T00:00:00.000Z"),
        metadata: command.input.Metadata,
      });
      return {};
    }

    if (command.constructor.name === "GetObjectCommand") {
      const object = objects.get(key);
      if (!object) {
        throw { $metadata: { httpStatusCode: 404 }, name: "NotFound" };
      }

      return {
        Body: createMockR2Body([object.data]),
      };
    }

    if (command.constructor.name === "HeadObjectCommand") {
      const object = objects.get(key);
      if (!object) {
        throw { $metadata: { httpStatusCode: 404 }, name: "NotFound" };
      }

      return {
        ContentLength: object.data.length,
        ContentType: object.contentType,
        ETag: `"${key}"`,
        LastModified: object.lastModified,
        Metadata: object.metadata,
      };
    }

    if (command.constructor.name === "DeleteObjectCommand") {
      objects.delete(key);
      return {};
    }

    throw new Error(`Unsupported R2 command: ${command.constructor.name}`);
  });
}

async function readBody(body: Uint8Array | Readable): Promise<Uint8Array> {
  return readStorageBody(body instanceof Uint8Array ? body : nodeReadableToStorageStream(body));
}

function createMockR2Body(chunks: readonly Uint8Array[]): {
  transformToWebStream(): StorageStream;
} {
  return {
    transformToWebStream: () => createStorageStream(chunks),
  };
}

function createStorageStream(chunks: readonly Uint8Array[]): StorageStream {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
