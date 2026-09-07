import { createHash } from "node:crypto";
import { Container } from "@croco/framework-context";
import type {
  ObjectMetadata,
  PutOptions,
  SignedUrlOptions,
  TransformOptions,
  UploadIntent,
} from "@croco/storage-core";
import {
  FileNotFoundProblem,
  InvalidKeyProblem,
  MAX_SIGNED_URL_EXPIRY_SECONDS,
  storageStreamFromBytes,
} from "@croco/storage-core";
import { createStorageProviderConformanceSuite } from "@croco/testing";
import { v2 as cloudinary } from "cloudinary";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudinaryProvider } from "../libs/CloudinaryProvider";

type StoredCloudinaryObject = {
  readonly context?: string;
  readonly createdAt: string;
  readonly data: Buffer;
  readonly etag: string;
};

// Cloudinary SDK 모킹
vi.mock("cloudinary", async (importOriginal) => {
  const original = await importOriginal<{ v2: typeof cloudinary }>();

  return {
    v2: {
      ...original.v2,
      config: vi.fn(),
      uploader: {
        ...original.v2.uploader,
        destroy: vi.fn(),
      },
      api: {
        resource: vi.fn(),
      },
      url: vi.fn(() => "https://res.cloudinary.com/test-cloud/image/upload/test-key"),
    },
  };
});

// fetch 모킹
global.fetch = vi.fn();

describe("CloudinaryProvider", () => {
  let provider!: CloudinaryProvider;

  const mockConfig = {
    cloudName: "test-cloud",
    apiKey: "test-api-key",
    apiSecret: "test-api-secret",
    secure: true,
  };

  beforeEach(() => {
    Container.reset();
    vi.clearAllMocks();

    provider = new CloudinaryProvider(mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("storage provider conformance", () => {
    it.each(
      createStorageProviderConformanceSuite({
        createProvider: () => {
          useInMemoryCloudinaryBackend();
          return provider;
        },
        keyPrefix: "cloudinary-conformance",
        metadata: {
          contentType: "unsupported",
          customMetadata: "required",
        },
        putContentType: "application/octet-stream",
        providerName: "storage-cloudinary",
        publicUrl: "https://res.cloudinary.com/test-cloud/raw/upload/",
        signedUrl: /s=mock-signature/,
      }).cases,
    )("$name", async ({ run }) => {
      await run();
    });
  });

  it("should not mutate global cloudinary config during construction", () => {
    expect(cloudinary.config).not.toHaveBeenCalled();
  });

  it("should run Cloudinary operations from different instances concurrently", async () => {
    const firstProvider = new CloudinaryProvider(mockConfig);
    const secondProvider = new CloudinaryProvider({
      cloudName: "other-cloud",
      apiKey: "other-api-key",
      apiSecret: "other-api-secret",
      secure: true,
    });
    let activeUploads = 0;
    let maxActiveUploads = 0;
    const resolvers: Array<() => void> = [];
    vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
      const upload = await parseMultipartUpload(init);
      return await new Promise<Response>((resolve) => {
        activeUploads += 1;
        maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
        resolvers.push(() => {
          activeUploads -= 1;
          resolve(jsonResponse({ public_id: upload.publicId }));
        });
      });
    });

    const firstUpload = firstProvider.put("first-key", Buffer.from("first"));
    const secondUpload = secondProvider.put("second-key", Buffer.from("second"));

    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    expect(maxActiveUploads).toBe(2);

    for (const resolve of resolvers) {
      resolve();
    }
    await expect(Promise.all([firstUpload, secondUpload])).resolves.toEqual([undefined, undefined]);
  });

  describe("operation cancellation", () => {
    it("should reject pre-aborted operations before starting provider work", async () => {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      controller.abort(reason);

      await expect(
        provider.put("test-key", Buffer.from("test data"), { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      await expect(provider.get("test-key", { signal: controller.signal })).rejects.toMatchObject({
        code: "STORAGE_OPERATION_ABORTED",
        cause: reason,
      });
      await expect(
        provider.getStream("test-key", { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      await expect(
        provider.delete("test-key", { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      await expect(
        provider.exists("test-key", { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      await expect(
        provider.getSignedUrl("test-key", { expiresIn: 60, signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      await expect(
        provider.getMetadata("test-key", { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      await expect(
        provider.getUploadIntent("test-key", { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(cloudinary.uploader.destroy).not.toHaveBeenCalled();
      expect(cloudinary.api.resource).not.toHaveBeenCalled();
      expect(cloudinary.url).not.toHaveBeenCalled();
    });

    it("should pass the caller signal to fetch and reject an in-flight abort without retrying", async () => {
      const controller = new AbortController();
      const reason = new Error("stop download");
      vi.mocked(global.fetch).mockImplementation(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const getPromise = provider.get("test-key", { signal: controller.signal });
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      await expect(getPromise).rejects.toMatchObject({
        code: "STORAGE_OPERATION_ABORTED",
        cause: reason,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key",
        { signal: controller.signal },
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should cancel the underlying in-flight Cloudinary API request without retrying", async () => {
      const controller = new AbortController();
      const reason = new Error("stop delete");
      vi.mocked(global.fetch).mockImplementation(
        async (_input: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const deletePromise = provider.delete("test-key", { signal: controller.signal });
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      await expect(deletePromise).rejects.toMatchObject({
        code: "STORAGE_OPERATION_ABORTED",
        cause: reason,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should abort retry backoff before starting another request", async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();
        const reason = new Error("stop retry backoff");
        vi.mocked(global.fetch).mockResolvedValue(
          jsonResponse({ error: { message: "Service unavailable" } }, 503),
        );

        const deletePromise = provider.delete("test-key", { signal: controller.signal });
        await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
        controller.abort(reason);

        await expect(deletePromise).rejects.toMatchObject({
          code: "STORAGE_OPERATION_ABORTED",
          cause: reason,
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("should reject when the signal aborts while parsing a successful API response", async () => {
      const controller = new AbortController();
      const reason = new Error("stop after response");
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn(async () => {
          controller.abort(reason);
          return { result: "ok" };
        }),
      } as unknown as Response);

      await expect(
        provider.delete("test-key", { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: "STORAGE_OPERATION_ABORTED",
        cause: reason,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should abort an in-flight buffer upload fetch without retrying", async () => {
      const controller = new AbortController();
      const reason = new Error("stop upload");
      vi.mocked(global.fetch).mockImplementation(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const putPromise = provider.put("test-key", Buffer.from("test data"), {
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      await expect(putPromise).rejects.toMatchObject({
        code: "STORAGE_OPERATION_ABORTED",
        cause: reason,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should not return upload success when abort occurs during response parsing", async () => {
      const controller = new AbortController();
      const reason = new Error("stop upload response");
      vi.mocked(global.fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn(async () => {
          controller.abort(reason);
          return { public_id: "test-key" };
        }),
      } as unknown as Response);

      await expect(
        provider.put("test-key", Buffer.from("test data"), { signal: controller.signal }),
      ).rejects.toMatchObject({ code: "STORAGE_OPERATION_ABORTED", cause: reason });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should terminate a readable source safely when upload fetch aborts", async () => {
      const controller = new AbortController();
      const reason = new Error("stop stream upload");
      let cancelled = false;
      const source = new ReadableStream<Uint8Array>({
        pull(streamController) {
          streamController.enqueue(Buffer.from("stream data"));
        },
        cancel() {
          cancelled = true;
        },
      });
      vi.mocked(global.fetch).mockImplementation(
        async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );

      const putPromise = provider.put("test-key", source, { signal: controller.signal });
      await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
      controller.abort(reason);

      await expect(putPromise).rejects.toMatchObject({
        code: "STORAGE_OPERATION_ABORTED",
        cause: reason,
      });
      expect(cancelled).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("put()", () => {
    it("should send a signed multipart buffer upload with signal and metadata", async () => {
      const now = 1_800_000_000_000;
      const controller = new AbortController();
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ public_id: "test-key" }));

      await provider.put("test-key", Buffer.from("test data"), {
        contentType: "image/jpeg",
        metadata: { alt: "value=with|separators" },
        signal: controller.signal,
      });

      const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
      const body = Buffer.from(init?.body as Uint8Array).toString();
      const context = "alt=value%3Dwith%7Cseparators";
      const signature = createHash("sha1")
        .update(
          `context=${context}&public_id=test-key&timestamp=${now / 1000}${mockConfig.apiSecret}`,
        )
        .digest("hex");

      expect(url).toBe("https://api.cloudinary.com/v1_1/test-cloud/image/upload");
      expect(init).toMatchObject({ method: "POST", signal: controller.signal });
      expect(init?.headers).toMatchObject({
        "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
      });
      expect(body).toContain('name="api_key"\r\n\r\ntest-api-key');
      expect(body).toContain(`name="context"\r\n\r\n${context}`);
      expect(body).toContain('name="public_id"\r\n\r\ntest-key');
      expect(body).toContain(`name="signature"\r\n\r\n${signature}`);
      expect(body).toContain('filename="test-key"\r\nContent-Type: image/jpeg');
      expect(body).toContain("test data");
    });

    it("should stream multipart readable data through fetch without SDK upload work", async () => {
      const controller = new AbortController();
      let requestBody = "";
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        requestBody = await new Response(init?.body).text();
        return jsonResponse({ public_id: "test-key" });
      });

      await provider.put("test-key", storageStreamFromBytes(Buffer.from("stream data")), {
        contentType: "image/png",
        signal: controller.signal,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
        expect.objectContaining({ duplex: "half", signal: controller.signal }),
      );
      expect(requestBody).toContain('name="file"; filename="test-key"');
      expect(requestBody).toContain("stream data");
    });

    it("should throw validation provider Problem on upload HTTP 400", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        jsonResponse({ error: { message: "Upload failed" } }, 400),
      );

      await expect(provider.put("test-key", Buffer.from("test data"))).rejects.toMatchObject({
        code: "storage-cloudinary/validation-failed",
      });
    });

    it("should retry transient buffer upload errors before succeeding", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(jsonResponse({ error: { message: "Unavailable" } }, 503))
        .mockResolvedValueOnce(jsonResponse({ error: { message: "Unavailable" } }, 503))
        .mockResolvedValueOnce(jsonResponse({ public_id: "test-key" }));

      await expect(provider.put("test-key", Buffer.from("test data"))).resolves.not.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it.each([
      ["empty", new Response(null, { status: 200 })],
      ["malformed", new Response("not-json", { status: 200 })],
    ])("should reject an %s successful upload response", async (_name, response) => {
      vi.mocked(global.fetch).mockResolvedValue(response);

      await expect(provider.put("test-key", Buffer.from("test data"))).rejects.toMatchObject({
        code: "storage-cloudinary/terminal-upstream",
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should reject a successful upload response for a different public ID", async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ public_id: "different-key" }));

      await expect(provider.put("test-key", Buffer.from("test data"))).rejects.toMatchObject({
        code: "storage-cloudinary/terminal-upstream",
        extensions: { upstreamCode: "invalid-upload-response" },
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should throw terminal provider Problem when source stream emits error", async () => {
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        await new Response(init?.body).arrayBuffer();
        return jsonResponse({ public_id: "test-key" });
      });

      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("Stream broken"));
        },
      });
      const putPromise = provider.put("test-key", source);

      await expect(putPromise).rejects.toMatchObject({
        code: "storage-cloudinary/terminal-upstream",
      });
    });

    it("should not retry readable stream uploads on transient HTTP errors", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        jsonResponse({ error: { message: "Service unavailable" } }, 503),
      );

      await expect(
        provider.put("test-key", storageStreamFromBytes(Buffer.from("test data"))),
      ).rejects.toMatchObject({
        code: "storage-cloudinary/retryable-upstream",
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should throw InvalidKeyProblem for empty key", async () => {
      const buffer = Buffer.from("test data");

      await expect(provider.put("", buffer)).rejects.toThrow(InvalidKeyProblem);
    });

    it("should throw InvalidKeyProblem for key starting with /", async () => {
      const buffer = Buffer.from("test data");

      await expect(provider.put("/invalid-key", buffer)).rejects.toThrow(InvalidKeyProblem);
    });

    it("should throw InvalidKeyProblem for key ending with /", async () => {
      const buffer = Buffer.from("test data");

      await expect(provider.put("invalid-key/", buffer)).rejects.toThrow(InvalidKeyProblem);
    });

    it("should throw InvalidKeyProblem for key containing //", async () => {
      const buffer = Buffer.from("test data");

      await expect(provider.put("invalid//key", buffer)).rejects.toThrow(InvalidKeyProblem);
    });
  });

  describe("get()", () => {
    it("should fetch resource successfully", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(new Uint8Array(10)));

      const result = await provider.get("test-key");

      expect(result).toBeInstanceOf(Uint8Array);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key",
        { signal: undefined },
      );
    });

    it("should throw FileNotFoundProblem on 404", async () => {
      const mockResponse = {
        ok: false,
        status: 404,
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as unknown as Response);

      await expect(provider.get("test-key")).rejects.toThrow(FileNotFoundProblem);
    });

    it("should throw retryable provider Problem on retryable HTTP error", async () => {
      const mockResponse = {
        ok: false,
        status: 500,
      };

      vi.mocked(global.fetch).mockResolvedValue(mockResponse as unknown as Response);

      await expect(provider.get("test-key")).rejects.toMatchObject({
        code: "storage-cloudinary/retryable-upstream",
      });
    });

    it("should throw retryable provider Problem on fetch error", async () => {
      vi.mocked(global.fetch).mockRejectedValue(new Error("Network error"));

      await expect(provider.get("test-key")).rejects.toMatchObject({
        code: "storage-cloudinary/retryable-upstream",
      });
    });

    it("should normalize a response body read failure", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(
                Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
              );
            },
          }),
        ),
      );

      await expect(provider.get("test-key")).rejects.toMatchObject({
        code: "storage-cloudinary/retryable-upstream",
        extensions: {
          key: "test-key",
          operation: "get",
        },
      });
    });

    it("should retry transient fetch failures before succeeding", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response)
        .mockResolvedValueOnce(new Response(new Uint8Array(4)));

      const result = await provider.get("test-key");

      expect(result).toBeInstanceOf(Uint8Array);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should not retry not found fetch failures", async () => {
      vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 404 } as unknown as Response);

      await expect(provider.get("test-key")).rejects.toThrow(FileNotFoundProblem);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("should throw InvalidKeyProblem for invalid key", async () => {
      await expect(provider.get("")).rejects.toThrow(InvalidKeyProblem);
    });
  });

  describe("getStream()", () => {
    it("should return readable stream", async () => {
      vi.mocked(global.fetch).mockResolvedValue(new Response(new Uint8Array(10)));

      const stream = await provider.getStream("test-key");

      expect(stream).toBeInstanceOf(ReadableStream);
    });
  });

  describe("delete()", () => {
    it("should delete resource successfully", async () => {
      const now = 1_800_000_000_000;
      const controller = new AbortController();
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ result: "ok" }));

      await expect(
        provider.delete("test-key", { signal: controller.signal }),
      ).resolves.not.toThrow();

      const [url, init] = vi.mocked(global.fetch).mock.calls[0] ?? [];
      expect(url).toBe("https://api.cloudinary.com/v1_1/test-cloud/image/destroy");
      expect(init).toMatchObject({ method: "POST", signal: controller.signal });
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      expect((init?.body as URLSearchParams).get("api_key")).toBe(mockConfig.apiKey);
      expect((init?.body as URLSearchParams).get("public_id")).toBe("test-key");
      expect((init?.body as URLSearchParams).get("timestamp")).toBe(String(now / 1000));
      expect((init?.body as URLSearchParams).get("signature")).toBe(
        createHash("sha1")
          .update(`public_id=test-key&timestamp=${now / 1000}${mockConfig.apiSecret}`)
          .digest("hex"),
      );
    });

    it("should handle not found result gracefully", async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ result: "not found" }));

      await expect(provider.delete("test-key")).resolves.not.toThrow();
    });

    it("should throw terminal provider Problem on delete failure", async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ result: "error" }));

      await expect(provider.delete("test-key")).rejects.toMatchObject({
        code: "storage-cloudinary/terminal-upstream",
      });
    });

    it("should retry transient delete failures before succeeding", async () => {
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(jsonResponse({ error: { message: "Service unavailable" } }, 503))
        .mockResolvedValueOnce(jsonResponse({ result: "ok" }));

      await expect(provider.delete("test-key")).resolves.not.toThrow();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should throw InvalidKeyProblem for invalid key", async () => {
      await expect(provider.delete("")).rejects.toThrow(InvalidKeyProblem);
    });
  });

  describe("exists()", () => {
    it("should return true for existing resource", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));

      const result = await provider.exists("test-key");

      expect(result).toBe(true);
    });

    it("should return false for non-existing resource", async () => {
      vi.mocked(global.fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));

      const result = await provider.exists("test-key");

      expect(result).toBe(false);
    });

    it("should throw InvalidKeyProblem for invalid key", async () => {
      await expect(provider.exists("")).rejects.toThrow(InvalidKeyProblem);
    });
  });

  describe("getPublicUrl()", () => {
    it("should return public URL", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key",
      );

      const url = provider.getPublicUrl("test-key");

      expect(url).toBe("https://res.cloudinary.com/test-cloud/image/upload/test-key");
      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
      });
    });

    it("should return HTTP URL when secure is false", () => {
      const httpProvider = new CloudinaryProvider({ ...mockConfig, secure: false });
      vi.mocked(cloudinary.url).mockReturnValue(
        "http://res.cloudinary.com/test-cloud/image/upload/test-key",
      );

      httpProvider.getPublicUrl("test-key");

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: false,
      });
    });

    it("should throw InvalidKeyProblem for invalid key", () => {
      expect(() => provider.getPublicUrl("")).toThrow(InvalidKeyProblem);
    });
  });

  describe("getSignedUrl()", () => {
    it("should return signed URL with expiration", async () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key?s=sig",
      );

      const options: SignedUrlOptions = { expiresIn: MAX_SIGNED_URL_EXPIRY_SECONDS };
      const url = await provider.getSignedUrl("test-key", options);

      expect(url).toBe("https://res.cloudinary.com/test-cloud/image/upload/test-key?s=sig");

      const now = Date.now() / 1000;
      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        api_secret: "test-api-secret",
        secure: true,
        sign_url: true,
        expiration: Math.floor(now) + MAX_SIGNED_URL_EXPIRY_SECONDS,
      });
    });

    it("should throw InvalidKeyProblem for invalid key", async () => {
      const options: SignedUrlOptions = { expiresIn: 3600 };

      await expect(provider.getSignedUrl("", options)).rejects.toThrow(InvalidKeyProblem);
    });
  });

  describe("getMetadata()", () => {
    it("should return resource metadata", async () => {
      const mockResource = {
        bytes: 1024,
        format: "jpg",
        created_at: "2024-01-01T00:00:00Z",
        etag: "abc123",
        context: { custom: { alt: "test", author: "test" } },
      };

      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(mockResource));

      const metadata = await provider.getMetadata("test-key");

      const expectedMetadata: ObjectMetadata = {
        size: 1024,
        contentType: "jpg",
        lastModified: new Date("2024-01-01T00:00:00Z"),
        etag: "abc123",
        metadata: { alt: "test", author: "test" },
      };

      expect(metadata).toEqual(expectedMetadata);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/resources/image/upload/test-key",
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${mockConfig.apiKey}:${mockConfig.apiSecret}`).toString("base64")}`,
          },
          signal: undefined,
        },
      );
    });

    it("should decode escaped metadata values", async () => {
      const mockResource = {
        bytes: 1024,
        format: "jpg",
        created_at: "2024-01-01T00:00:00Z",
        context: {
          custom: {
            alt: "value%3Dwith%7Cseparators",
            "special%7Ckey": "hello%3Dworld",
          },
        },
      };

      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(mockResource));

      const metadata = await provider.getMetadata("test-key");

      expect(metadata.metadata).toEqual({
        alt: "value=with|separators",
        "special|key": "hello=world",
      });
    });

    it("should handle missing optional metadata fields", async () => {
      const mockResource = {
        bytes: 0,
        format: "png",
        created_at: "2024-01-01T00:00:00Z",
      };

      vi.mocked(global.fetch).mockResolvedValue(jsonResponse(mockResource));

      const metadata = await provider.getMetadata("test-key");

      expect(metadata.size).toBe(0);
      expect(metadata.etag).toBeUndefined();
      expect(metadata.metadata).toBeUndefined();
    });

    it("should URL-encode the complete public ID as one Admin API path segment", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        jsonResponse({
          bytes: 1,
          created_at: "2024-01-01T00:00:00Z",
        }),
      );

      await provider.getMetadata("folder/test image");

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/resources/image/upload/folder%2Ftest%20image",
        expect.any(Object),
      );
    });

    it("should throw FileNotFoundProblem on resource not found", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        jsonResponse({ error: { message: "Not found" } }, 404),
      );

      await expect(provider.getMetadata("test-key")).rejects.toThrow(FileNotFoundProblem);
    });

    it("should throw FileNotFoundProblem when Cloudinary returns 404 code", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        jsonResponse({ error: { message: "Resource not found" } }, 404),
      );

      await expect(provider.getMetadata("test-key")).rejects.toThrow(FileNotFoundProblem);
    });

    it("should throw validation provider Problem for non-404 metadata validation errors", async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        jsonResponse({ error: { message: "Forbidden" } }, 403),
      );

      await expect(provider.getMetadata("test-key")).rejects.toMatchObject({
        code: "storage-cloudinary/validation-failed",
      });
    });

    it("should retry transient metadata failures before succeeding", async () => {
      const mockResource = {
        bytes: 1024,
        format: "jpg",
        created_at: "2024-01-01T00:00:00Z",
      };

      vi.mocked(global.fetch)
        .mockResolvedValueOnce(jsonResponse({ error: { message: "Too many requests" } }, 429))
        .mockResolvedValueOnce(jsonResponse(mockResource));

      const metadata = await provider.getMetadata("test-key");

      expect(metadata.size).toBe(1024);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should throw InvalidKeyProblem for invalid key", async () => {
      await expect(provider.getMetadata("")).rejects.toThrow(InvalidKeyProblem);
    });
  });

  describe("getTransformUrl()", () => {
    it("should generate transform URL with width and height", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/w_200,h_200/test-key",
      );

      const options: TransformOptions = { width: 200, height: 200 };
      const url = provider.getTransformUrl("test-key", options);

      expect(url).toBe("https://res.cloudinary.com/test-cloud/image/upload/w_200,h_200/test-key");
      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "w_200,h_200",
      });
    });

    it("should generate transform URL with fit mode", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/c_fill/test-key",
      );

      const options: TransformOptions = { fit: "cover" };
      provider.getTransformUrl("test-key", options);

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "c_fill",
      });
    });

    it("should generate transform URL with quality", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/q_80/test-key",
      );

      const options: TransformOptions = { quality: 80 };
      provider.getTransformUrl("test-key", options);

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "q_80",
      });
    });

    it("should generate transform URL with format", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/f_webp/test-key",
      );

      const options: TransformOptions = { format: "webp" };
      provider.getTransformUrl("test-key", options);

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "f_webp",
      });
    });

    it("should ignore auto format", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key",
      );

      const options: TransformOptions = { format: "auto" };
      provider.getTransformUrl("test-key", options);

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: undefined,
      });
    });

    it("should generate transform URL with DPR", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/dpr_2.0/test-key",
      );

      const options: TransformOptions = { dpr: 2 };
      provider.getTransformUrl("test-key", options);

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "dpr_2",
      });
    });

    it("should generate transform URL with combined options", () => {
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/w_200,h_200,c_fill,q_80/test-key",
      );

      const options: TransformOptions = {
        width: 200,
        height: 200,
        fit: "cover",
        quality: 80,
      };
      provider.getTransformUrl("test-key", options);

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "w_200,h_200,c_fill,q_80",
      });
    });

    it("should throw InvalidKeyProblem for invalid key", () => {
      const options: TransformOptions = { width: 200 };

      expect(() => provider.getTransformUrl("", options)).toThrow(InvalidKeyProblem);
    });
  });

  describe("getUploadIntent()", () => {
    it("should return a deterministic signed multipart upload intent without exposing the API secret", async () => {
      const now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key",
      );

      const intent = await provider.getUploadIntent("test-key");
      const repeatedIntent = await provider.getUploadIntent("test-key");
      const timestamp = String(now / 1000);
      const signature = createHash("sha1")
        .update(`public_id=test-key&timestamp=${timestamp}${mockConfig.apiSecret}`)
        .digest("hex");

      const expectedIntent: UploadIntent = {
        uploadUrl: "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
        publicUrl: "https://res.cloudinary.com/test-cloud/image/upload/test-key",
        fields: {
          api_key: mockConfig.apiKey,
          public_id: "test-key",
          signature,
          timestamp,
        },
        expiresAt: new Date(now + 3600 * 1000),
      };

      expect(intent).toEqual(expectedIntent);
      expect(repeatedIntent).toEqual(expectedIntent);
      expect(Object.values(intent.fields ?? {})).not.toContain(mockConfig.apiSecret);
    });

    it("should apply ttlInSeconds option to upload intent", async () => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/test-cloud/image/upload/test-key",
      );

      const intent = await provider.getUploadIntent("test-key", { ttlInSeconds: 120 });

      expect(intent.expiresAt.getTime()).toBe(now + 120 * 1000);
    });

    it("should reject TTL values outside Cloudinary's one-hour signature validity", async () => {
      for (const ttlInSeconds of [0, -1, 3601]) {
        await expect(provider.getUploadIntent("test-key", { ttlInSeconds })).rejects.toMatchObject({
          code: "storage-cloudinary/invalid-upload-intent-ttl",
        });
      }

      expect(cloudinary.url).not.toHaveBeenCalled();
    });

    it("should reject an invalid configured TTL instead of silently issuing a longer intent", async () => {
      const invalidTtlProvider = new CloudinaryProvider({ ...mockConfig, ttl: 3601 });

      await expect(invalidTtlProvider.getUploadIntent("test-key")).rejects.toMatchObject({
        code: "storage-cloudinary/invalid-upload-intent-ttl",
      });
      expect(cloudinary.url).not.toHaveBeenCalled();
    });

    it("should throw Problem when ttlInSeconds is not a finite integer", async () => {
      for (const ttlInSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        await expect(provider.getUploadIntent("test-key", { ttlInSeconds })).rejects.toMatchObject({
          code: "storage-cloudinary/invalid-upload-intent-ttl",
        });
      }
    });

    it("should throw InvalidKeyProblem for invalid key", async () => {
      await expect(provider.getUploadIntent("")).rejects.toThrow(InvalidKeyProblem);
    });

    it("should reject image keys whose last segment includes a file extension", async () => {
      await expect(provider.getUploadIntent("uploads/avatar.png")).rejects.toThrow(
        InvalidKeyProblem,
      );
      expect(cloudinary.url).not.toHaveBeenCalled();
    });

    it("should scope a custom upload base URL to upload intent generation", async () => {
      const customProvider = new CloudinaryProvider({
        ...mockConfig,
        uploadBaseUrl: "https://uploads.example.com/cloudinary",
      });
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(jsonResponse({ public_id: "test-key" }))
        .mockResolvedValueOnce(jsonResponse({ result: "ok" }))
        .mockResolvedValueOnce(jsonResponse({ bytes: 1, created_at: "2024-01-01T00:00:00Z" }));

      const intent = await customProvider.getUploadIntent("test-key");
      await customProvider.put("test-key", Buffer.from("test data"));
      await customProvider.delete("test-key");
      await customProvider.getMetadata("test-key");

      expect(intent.uploadUrl).toBe("https://uploads.example.com/v1_1/test-cloud/image/upload");
      expect(new URL(intent.uploadUrl).username).toBe("");
      expect(new URL(intent.uploadUrl).password).toBe("");
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
        expect.any(Object),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        "https://api.cloudinary.com/v1_1/test-cloud/image/destroy",
        expect.any(Object),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        3,
        "https://api.cloudinary.com/v1_1/test-cloud/resources/image/upload/test-key",
        expect.any(Object),
      );
    });

    it("should scope a custom API base URL to server-side Cloudinary requests", async () => {
      const customProvider = new CloudinaryProvider({
        ...mockConfig,
        apiBaseUrl: "https://api-eu.example.com",
      });
      vi.mocked(global.fetch)
        .mockResolvedValueOnce(jsonResponse({ public_id: "test-key" }))
        .mockResolvedValueOnce(jsonResponse({ result: "ok" }))
        .mockResolvedValueOnce(jsonResponse({ bytes: 1, created_at: "2024-01-01T00:00:00Z" }));

      const intent = await customProvider.getUploadIntent("test-key");
      await customProvider.put("test-key", Buffer.from("test data"));
      await customProvider.delete("test-key");
      await customProvider.getMetadata("test-key");

      expect(intent.uploadUrl).toBe("https://api.cloudinary.com/v1_1/test-cloud/image/upload");
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        "https://api-eu.example.com/v1_1/test-cloud/image/upload",
        expect.any(Object),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        "https://api-eu.example.com/v1_1/test-cloud/image/destroy",
        expect.any(Object),
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        3,
        "https://api-eu.example.com/v1_1/test-cloud/resources/image/upload/test-key",
        expect.any(Object),
      );
    });

    it.each([
      "not-a-url",
      "ftp://api.example.com",
      "https://user:secret@api.example.com",
      "https://api.example.com?region=eu",
      "https://api.example.com#region",
    ])("should reject invalid API base URL %s", (apiBaseUrl) => {
      expect(() => new CloudinaryProvider({ ...mockConfig, apiBaseUrl })).toThrowError(
        expect.objectContaining({ code: "storage-cloudinary/validation-failed" }),
      );
    });

    it.each([
      "/uploads",
      "https://[invalid",
      "ftp://uploads.example.com",
      "https://user:secret@uploads.example.com",
      "https://uploads.example.com?region=eu",
      "https://uploads.example.com#region",
    ])("should reject invalid upload base URL %s", (uploadBaseUrl) => {
      expect(() => new CloudinaryProvider({ ...mockConfig, uploadBaseUrl })).toThrowError(
        expect.objectContaining({
          code: "storage-cloudinary/validation-failed",
          extensions: expect.objectContaining({ upstreamCode: "invalid-upload-base-url" }),
        }),
      );
    });
  });

  describe("fit mode mapping", () => {
    it("should map cover to fill", () => {
      vi.mocked(cloudinary.url).mockReturnValue("");

      provider.getTransformUrl("test-key", { fit: "cover" });

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "c_fill",
      });
    });

    it("should map contain to fit", () => {
      vi.mocked(cloudinary.url).mockReturnValue("");

      provider.getTransformUrl("test-key", { fit: "contain" });

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "c_fit",
      });
    });

    it("should map fill to pad", () => {
      vi.mocked(cloudinary.url).mockReturnValue("");

      provider.getTransformUrl("test-key", { fit: "fill" });

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "c_pad",
      });
    });

    it("should map inside to limit", () => {
      vi.mocked(cloudinary.url).mockReturnValue("");

      provider.getTransformUrl("test-key", { fit: "inside" });

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "c_limit",
      });
    });

    it("should map outside to crop", () => {
      vi.mocked(cloudinary.url).mockReturnValue("");

      provider.getTransformUrl("test-key", { fit: "outside" });

      expect(cloudinary.url).toHaveBeenCalledWith("test-key", {
        cloud_name: "test-cloud",
        secure: true,
        transformation: "c_crop",
      });
    });

    it("should generate URLs with each provider own cloud name", () => {
      const otherProvider = new CloudinaryProvider({
        cloudName: "other-cloud",
        apiKey: "other-api-key",
        apiSecret: "other-api-secret",
        secure: true,
      });

      vi.mocked(cloudinary.url).mockReturnValue(
        "https://res.cloudinary.com/other-cloud/image/upload/test-key",
      );

      otherProvider.getPublicUrl("test-key");

      expect(cloudinary.url).toHaveBeenLastCalledWith("test-key", {
        cloud_name: "other-cloud",
        secure: true,
      });
    });
  });

  describe("resource type contract", () => {
    it.each(["reports/invoice.pdf", "contracts/doc.zip", "notes/readme.txt"])(
      "should upload raw key %s without interpreting its bytes as an image",
      async (key) => {
        vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ public_id: key }));
        await provider.put(key, Buffer.from([0, 255, 13, 10]));
        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.cloudinary.com/v1_1/test-cloud/raw/upload",
          expect.objectContaining({ method: "POST" }),
        );
        const intent = await provider.getUploadIntent(key);
        expect(intent.uploadUrl).toBe("https://api.cloudinary.com/v1_1/test-cloud/raw/upload");
        expect(intent.fields?.public_id).toBe(key);
      },
    );
    it("should upload image content in the image namespace", async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ public_id: "test-key" }));

      const buffer = Buffer.from("test data");
      await provider.put("test-key", buffer, { contentType: "image/png" });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it.each(["video/mp4", "application/pdf"])(
      "should reject unsupported %s content before upload",
      async (contentType) => {
        await expect(
          provider.put("test-key", Buffer.from("test data"), { contentType }),
        ).rejects.toMatchObject({
          code: "storage-cloudinary/validation-failed",
          extensions: {
            key: "test-key",
            operation: "put",
            provider: "cloudinary",
            upstreamCode: "unsupported-resource-type",
          },
        });
      },
    );

    it("should reject an unsupported readable stream before consuming bytes", async () => {
      let consumed = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            consumed = true;
            controller.enqueue(Buffer.from("video data"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );

      await expect(
        provider.put("test-key", stream, { contentType: "video/mp4" }),
      ).rejects.toMatchObject({
        code: "storage-cloudinary/validation-failed",
      });

      expect(consumed).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should reject content types containing multipart header delimiters", async () => {
      await expect(
        provider.put("test-key", Buffer.from("test data"), {
          contentType: "image/png\r\nX-Injected: true",
        }),
      ).rejects.toMatchObject({ code: "storage-cloudinary/validation-failed" });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should preserve the accepted image lifecycle after provider reconstruction", async () => {
      useInMemoryCloudinaryBackend();
      const key = "restart/image.png";
      const data = Buffer.from("image data");

      await provider.put(key, data, { contentType: "image/png" });

      const reconstructedProvider = new CloudinaryProvider(mockConfig);
      await expect(reconstructedProvider.get(key)).resolves.toEqual(new Uint8Array(data));
      await expect(reconstructedProvider.exists(key)).resolves.toBe(true);
      await expect(reconstructedProvider.getMetadata(key)).resolves.toMatchObject({
        size: data.length,
      });
      await expect(reconstructedProvider.delete(key)).resolves.toBeUndefined();
      await expect(reconstructedProvider.exists(key)).resolves.toBe(false);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/image/destroy",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("should use the image namespace when content type is not provided", async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ public_id: "test-key" }));

      const buffer = Buffer.from("test data");
      await provider.put("test-key", buffer);

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.cloudinary.com/v1_1/test-cloud/image/upload",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function useInMemoryCloudinaryBackend(): void {
  const objects = new Map<string, StoredCloudinaryObject>();

  vi.mocked(cloudinary.url).mockImplementation((key: string, options?: unknown) => {
    const optionRecord = typeof options === "object" && options !== null ? options : undefined;
    const cloudNameValue = optionRecord ? Reflect.get(optionRecord, "cloud_name") : undefined;
    const secureValue = optionRecord ? Reflect.get(optionRecord, "secure") : undefined;
    const transformationValue = optionRecord
      ? Reflect.get(optionRecord, "transformation")
      : undefined;
    const signUrlValue = optionRecord ? Reflect.get(optionRecord, "sign_url") : undefined;
    const cloudName = typeof cloudNameValue === "string" ? cloudNameValue : "test-cloud";
    const protocol = secureValue === false ? "http" : "https";
    const transformation =
      typeof transformationValue === "string" && transformationValue.length > 0
        ? `${transformationValue}/`
        : "";
    const query = signUrlValue ? "?expires=60&s=mock-signature" : "";

    const resourceType = optionRecord
      ? (Reflect.get(optionRecord, "resource_type") ?? "image")
      : "image";
    return `${protocol}://res.cloudinary.com/${cloudName}/${resourceType}/upload/${transformation}${key}${query}`;
  });

  vi.mocked(global.fetch).mockImplementation(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const resourceType = url.pathname.includes("/raw/") ? "raw" : "image";
      if (url.pathname === `/v1_1/test-cloud/${resourceType}/upload`) {
        const upload = await parseMultipartUpload(init);
        objects.set(upload.publicId, {
          context: upload.context,
          createdAt: "2026-01-01T00:00:00Z",
          data: upload.data,
          etag: `${upload.publicId}:etag`,
        });
        return jsonResponse({ public_id: upload.publicId });
      }

      if (url.pathname === `/v1_1/test-cloud/${resourceType}/destroy`) {
        const key = init?.body instanceof URLSearchParams ? init.body.get("public_id") : undefined;
        const existed = key === null || key === undefined ? false : objects.delete(key);
        return jsonResponse({ result: existed ? "ok" : "not found" });
      }

      const resourcePrefix = `/v1_1/test-cloud/resources/${resourceType}/upload/`;
      if (url.pathname.startsWith(resourcePrefix)) {
        const key = decodeURIComponent(url.pathname.slice(resourcePrefix.length));
        const object = objects.get(key);
        if (!object) {
          return jsonResponse({ error: { message: "Resource not found" } }, 404);
        }

        return jsonResponse({
          bytes: object.data.length,
          context: object.context,
          created_at: object.createdAt,
          etag: object.etag,
        });
      }

      const key = parseCloudinaryDeliveryKey(String(input), "test-cloud");
      if (!key) {
        return new Response("Not found", { status: 404 });
      }

      const object = objects.get(key);
      if (!object) {
        return new Response("Not found", { status: 404 });
      }

      return new Response(new Uint8Array(object.data));
    },
  );
}

async function parseMultipartUpload(
  init: RequestInit | undefined,
): Promise<{ context?: string; data: Buffer; publicId: string }> {
  const contentType = (init?.headers as Record<string, string> | undefined)?.["Content-Type"];
  const boundary = contentType?.match(/boundary=(.+)$/)?.[1];
  if (!boundary || init?.body === undefined || init.body === null) {
    throw new Error("Invalid multipart upload request");
  }

  const body = Buffer.from(await new Response(init.body).arrayBuffer());
  const text = body.toString();
  const publicId = text.match(/name="public_id"\r\n\r\n([^\r]+)\r\n/)?.[1];
  if (!publicId) {
    throw new Error("Missing multipart public_id");
  }

  const context = text.match(/name="context"\r\n\r\n([^\r]+)\r\n/)?.[1];
  const fileHeaderEnd = text.indexOf("\r\n\r\n", text.indexOf('name="file"'));
  const fileEnd = body.indexOf(Buffer.from(`\r\n--${boundary}--`), fileHeaderEnd + 4);
  if (fileHeaderEnd === -1 || fileEnd === -1) {
    throw new Error("Missing multipart file");
  }

  return {
    ...(context === undefined ? {} : { context }),
    data: body.subarray(fileHeaderEnd + 4, fileEnd),
    publicId,
  };
}

function parseCloudinaryDeliveryKey(url: string, cloudName: string): string | null {
  const parsed = new URL(url);
  const resourceType = parsed.pathname.includes("/raw/") ? "raw" : "image";
  const marker = `/${cloudName}/${resourceType}/upload/`;
  const markerIndex = parsed.pathname.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const rawKey = parsed.pathname.slice(markerIndex + marker.length);
  if (rawKey.length === 0) {
    return null;
  }

  const segments = rawKey.split("/");
  if (segments[0]?.includes("_") && segments.length > 1) {
    segments.shift();
  }

  return segments.map(decodeURIComponent).join("/");
}
