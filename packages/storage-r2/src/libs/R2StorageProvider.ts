// Constructor dependencies must remain runtime values for emitted design:paramtypes metadata.
/* oxlint-disable typescript/consistent-type-imports */
import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConfigService } from "@croco/framework-config";
import { Component } from "@croco/framework-context";
import { Logger } from "@croco/framework-logger";
import type { RetryPolicy } from "@croco/retry-core";
import { RetryTemplate } from "@croco/retry-core";
import type {
  ObjectMetadata,
  PutOptions,
  SignedUrlOptions,
  StorageBody,
  StorageStream,
  StorageOperation,
  StorageOperationOptions,
} from "@croco/storage-core";
import { BaseStorageProvider, validateSignedUrlExpiry } from "@croco/storage-core";
import { storageStreamToNodeReadable } from "@croco/storage-core/node";
import { MissingR2ConfigProblem } from "./problems/MissingR2ConfigProblem";
import { EmptyR2BodyProblem } from "./problems/EmptyR2BodyProblem";
import { R2ObjectTooLargeProblem } from "./problems/R2ObjectTooLargeProblem";
import { validateR2Options } from "./R2Config";
import type { R2Options } from "./types";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "RequestTimeout",
  "RequestTimeoutException",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "TimeoutError",
  "TooManyRequestsException",
]);

type R2Error = Error & {
  code?: string;
  name?: string;
  status?: number;
  statusCode?: number;
  $metadata?: {
    httpStatusCode?: number;
  };
};

const getErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if ("$metadata" in error) {
    const metadata = error.$metadata as { httpStatusCode?: number };
    if (typeof metadata.httpStatusCode === "number") {
      return metadata.httpStatusCode;
    }
  }

  if ("statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }

  return undefined;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }

  if ("name" in error && typeof error.name === "string") {
    return error.name;
  }

  return undefined;
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return fallback;
};

const normalizeR2Error = (error: unknown, fallback: string): R2Error => {
  if (error instanceof Error) {
    return error as R2Error;
  }

  const normalizedError = new Error(getErrorMessage(error, fallback)) as R2Error;

  if (error && typeof error === "object") {
    if ("code" in error && typeof error.code === "string") {
      normalizedError.code = error.code;
    }

    if ("name" in error && typeof error.name === "string") {
      normalizedError.name = error.name;
    }

    if ("status" in error && typeof error.status === "number") {
      normalizedError.status = error.status;
    }

    if ("statusCode" in error && typeof error.statusCode === "number") {
      normalizedError.statusCode = error.statusCode;
    }

    if ("$metadata" in error && error.$metadata && typeof error.$metadata === "object") {
      normalizedError.$metadata = error.$metadata as { httpStatusCode?: number };
    }
  }

  return normalizedError;
};

const isRetryableR2Error = (error: unknown): boolean => {
  const status = getErrorStatus(error);

  if (typeof status === "number" && TRANSIENT_HTTP_STATUSES.has(status)) {
    return true;
  }

  const code = getErrorCode(error);
  return typeof code === "string" && TRANSIENT_ERROR_CODES.has(code);
};

const R2_RETRY_POLICY: RetryPolicy = {
  shouldRetry(error: unknown, attempt: number, maxAttempts: number): boolean {
    return attempt < maxAttempts && isRetryableR2Error(error);
  },
};

/**
 * Cloudflare R2 스토리지 제공자
 *
 * AWS S3 SDK를 사용하여 R2와 통신합니다.
 */
@Component()
export class R2StorageProvider extends BaseStorageProvider {
  private static readonly MAX_BUFFERED_GET_BYTES = 10 * 1024 * 1024;
  private readonly client: S3Client;
  private readonly options: R2Options;

  constructor(
    private readonly config: ConfigService,
    readonly _logger: Logger,
  ) {
    super();
    this.options = validateR2Options({
      accountId: this.config.get("R2_ACCOUNT_ID"),
      accessKeyId: this.config.get("R2_ACCESS_KEY_ID"),
      secretAccessKey: this.config.get("R2_SECRET_ACCESS_KEY"),
      bucket: this.config.get("R2_BUCKET"),
      publicUrlBase: this.config.get("R2_PUBLIC_URL_BASE"),
    });

    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${this.options.accountId}.r2.cloudflarestorage.com`,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
    });
  }

  async put(key: string, data: StorageBody, options?: PutOptions): Promise<void> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "put", key);

    try {
      const replayable = data instanceof Uint8Array;
      const upload = async (shouldRetry: boolean) => {
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        const body = replayable
          ? data
          : storageStreamToNodeReadable(this.bindOperationSignal(data, options, "put", key));

        const command = new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: body,
          ContentType: options?.contentType,
          CacheControl: options?.cacheControl,
          Metadata: options?.metadata,
        });

        const send = async () =>
          await this.executeR2Operation(
            () => this.client.send(command, { abortSignal: options?.signal }),
            "Unknown upload error",
          );

        if (shouldRetry) {
          await this.executeWithRetry(send, options, "put", key);
          return;
        }

        await send();
      };

      await upload(replayable);
      this.assertOperationNotAborted(options, "put", key);
    } catch (error) {
      this.rethrowOperationAbort(error, options, "put", key);
      this.throwUploadFailed(key, error);
    }
  }

  async getStream(key: string, options?: StorageOperationOptions): Promise<StorageStream> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getStream", key);

    const { GetObjectCommand } = await import("@aws-sdk/client-s3");

    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    });

    try {
      const response = await this.executeWithRetry(
        async () =>
          await this.executeR2Operation(
            () => this.client.send(command, { abortSignal: options?.signal }),
            "Unknown download error",
          ),
        options,
        "getStream",
        key,
      );

      if (!response.Body) {
        throw new EmptyR2BodyProblem(key);
      }

      return this.bindOperationSignal(
        response.Body.transformToWebStream() as StorageStream,
        options,
        "getStream",
        key,
      );
    } catch (error) {
      this.rethrowOperationAbort(error, options, "getStream", key);
      return this.handleNotFoundError(key, error);
    }
  }

  async get(key: string, options?: StorageOperationOptions): Promise<Uint8Array> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "get", key);

    try {
      const chunks: Uint8Array[] = [];
      const stream = await this.getStream(key, options);
      let totalBytes = 0;

      for await (const chunk of stream) {
        totalBytes += chunk.byteLength;

        if (totalBytes > R2StorageProvider.MAX_BUFFERED_GET_BYTES) {
          throw new R2ObjectTooLargeProblem(key, R2StorageProvider.MAX_BUFFERED_GET_BYTES);
        }

        chunks.push(chunk);
      }

      const bytes = new Uint8Array(totalBytes);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      this.assertOperationNotAborted(options, "get", key);
      return bytes;
    } catch (error) {
      this.rethrowOperationAbort(error, options, "get", key);
      return this.handleNotFoundError(key, error);
    }
  }

  async delete(key: string, options?: StorageOperationOptions): Promise<void> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "delete", key);

    try {
      await this.executeWithRetry(
        async () => {
          const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");

          const command = new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: key,
          });

          await this.executeR2Operation(
            () => this.client.send(command, { abortSignal: options?.signal }),
            "Unknown delete error",
          );
        },
        options,
        "delete",
        key,
      );
    } catch (error) {
      this.rethrowOperationAbort(error, options, "delete", key);
      this.throwDeleteFailed(key, error);
    }
  }

  async exists(key: string, options?: StorageOperationOptions): Promise<boolean> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "exists", key);

    try {
      await this.executeWithRetry(
        async () => {
          const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
          const command = new HeadObjectCommand({
            Bucket: this.options.bucket,
            Key: key,
          });

          await this.executeR2Operation(
            () => this.client.send(command, { abortSignal: options?.signal }),
            "Unknown existence check error",
          );
        },
        options,
        "exists",
        key,
      );
      return true;
    } catch (error) {
      this.rethrowOperationAbort(error, options, "exists", key);
      if (this.isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  getPublicUrl(key: string): string {
    this.validateKey(key);

    if (this.options.publicUrlBase) {
      const normalizedBase = this.options.publicUrlBase.replace(/\/+$/, "");
      return `${normalizedBase}/${key}`;
    }

    throw new MissingR2ConfigProblem("R2_PUBLIC_URL_BASE");
  }

  async getSignedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getSignedUrl", key);
    const expiresIn = validateSignedUrlExpiry(options.expiresIn);

    const { GetObjectCommand } = await import("@aws-sdk/client-s3");

    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
    });

    try {
      const signedUrl = await getSignedUrl(this.client, command, {
        expiresIn,
      });
      this.assertOperationNotAborted(options, "getSignedUrl", key);
      return signedUrl;
    } catch (error) {
      this.rethrowOperationAbort(error, options, "getSignedUrl", key);
      throw error;
    }
  }

  async getMetadata(key: string, options?: StorageOperationOptions): Promise<ObjectMetadata> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getMetadata", key);

    try {
      const response = await this.executeWithRetry(
        async () => {
          const { HeadObjectCommand } = await import("@aws-sdk/client-s3");

          const command = new HeadObjectCommand({
            Bucket: this.options.bucket,
            Key: key,
          });

          return await this.executeR2Operation(
            () => this.client.send(command, { abortSignal: options?.signal }),
            "Unknown metadata error",
          );
        },
        options,
        "getMetadata",
        key,
      );

      return {
        size: response.ContentLength ?? 0,
        contentType: response.ContentType,
        lastModified: response.LastModified ?? new Date(),
        etag: response.ETag,
        metadata: response.Metadata,
      };
    } catch (error) {
      this.rethrowOperationAbort(error, options, "getMetadata", key);
      return this.handleNotFoundError(key, error);
    }
  }

  private isNotFoundError(error: unknown): boolean {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) {
      return true;
    }
    if (error && typeof error === "object" && "$metadata" in error) {
      const metadata = error.$metadata as { httpStatusCode?: number };
      return metadata.httpStatusCode === 404;
    }
    return false;
  }

  private handleNotFoundError(key: string, error: unknown): never {
    if (this.isNotFoundError(error)) {
      this.throwNotFound(key, error);
    }
    throw error;
  }

  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    options: StorageOperationOptions | undefined,
    operationName: StorageOperation,
    key: string,
  ): Promise<T> {
    const retryTemplate = new RetryTemplate({
      maxAttempts: 3,
      backoff: {
        delay: 10,
        multiplier: 2,
        maxDelay: 50,
        jitter: false,
      },
      retryPolicy: R2_RETRY_POLICY,
      signal: options?.signal,
    });

    return await retryTemplate.execute(async () => {
      this.assertOperationNotAborted(options, operationName, key);
      try {
        const result = await operation();
        this.assertOperationNotAborted(options, operationName, key);
        return result;
      } catch (error) {
        this.rethrowOperationAbort(error, options, operationName, key);
        throw error;
      }
    });
  }

  private async executeR2Operation<T>(
    operation: () => Promise<T>,
    fallbackMessage: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeR2Error(error, fallbackMessage);
    }
  }
}
