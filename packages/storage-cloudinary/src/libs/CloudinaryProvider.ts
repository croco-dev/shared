import { randomBytes } from "node:crypto";
import { Component } from "@croco/framework-context";
import { ProblemFactory } from "@croco/problems-core";
import type { RetryPolicy } from "@croco/retry-core";
import { RetryTemplate } from "@croco/retry-core";
import type {
  ImageProvider,
  ObjectMetadata,
  PutOptions,
  SignedUrlOptions,
  StorageBody,
  StorageStream,
  StorageOperation,
  StorageOperationOptions,
  TransformOptions,
  UploadIntent,
  UploadIntentOptions,
} from "@croco/storage-core";
import {
  BaseStorageProvider,
  InvalidKeyProblem,
  validateSignedUrlExpiry,
} from "@croco/storage-core";
import { v2 as cloudinary } from "cloudinary";
import {
  CloudinaryTerminalUpstreamProblem,
  CloudinaryValidationProblem,
  getCloudinaryErrorMessage,
  isRetryableCloudinaryStorageError,
  normalizeCloudinaryStorageError,
} from "./CloudinaryDiagnosticsProvider";
import type { CloudinaryConfig, CloudinaryTransformOptions } from "./types";
import {
  CLOUDINARY_UPLOAD_SIGNATURE_VALIDITY_SECONDS,
  isValidCloudinaryUploadIntentTtl,
} from "./uploadIntentTtl";

const CLOUDINARY_RETRY_POLICY: RetryPolicy = {
  shouldRetry(error: unknown, attempt: number, maxAttempts: number) {
    if (attempt >= maxAttempts) {
      return false;
    }

    return isRetryableCloudinaryStorageError(error);
  },
};

const DEFAULT_CLOUDINARY_API_BASE_URL = "https://api.cloudinary.com";

type CloudinaryResourceType = "image" | "video" | "raw";

function resolveResourceType(key: string): CloudinaryResourceType {
  const filename = key.slice(key.lastIndexOf("/") + 1);
  if (
    !filename.includes(".") ||
    /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|psd|svg|tiff?|webp)$/i.test(filename)
  ) {
    return "image";
  }
  if (
    /\.(aac|aiff?|avi|flac|flv|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|ogg|ogv|opus|wav|webm|wmv)$/i.test(
      filename,
    )
  ) {
    return "video";
  }
  return "raw";
}

function resolveDeliveryKey(key: string): string {
  return resolveResourceType(key) === "video"
    ? `${key}${key.slice(key.lastIndexOf(".")).toLowerCase()}`
    : key;
}

type CloudinarySdkError = Error & {
  code?: string;
  http_code?: number;
  status?: number;
  statusCode?: number;
};

function toCloudinarySdkError(error: unknown, fallbackMessage: string): CloudinarySdkError {
  if (error instanceof Error) {
    return error as CloudinarySdkError;
  }

  const sdkError = new Error(
    getCloudinaryErrorMessage(error, fallbackMessage),
  ) as CloudinarySdkError;
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
  const nestedError =
    typeof record?.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : undefined;

  const code = firstString(
    record?.code,
    record?.name,
    nestedError?.code,
    nestedError?.name,
    typeof record?.error === "string" ? record.error : undefined,
  );
  if (code !== undefined) {
    sdkError.code = code;
  }

  const status = firstNumber(
    record?.http_code,
    record?.status,
    record?.statusCode,
    nestedError?.http_code,
    nestedError?.status,
    nestedError?.statusCode,
  );
  if (status !== undefined) {
    sdkError.http_code = status;
    sdkError.status = status;
    sdkError.statusCode = status;
  }

  return sdkError;
}

function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function normalizeCloudinaryBaseUrl(
  value: string | undefined,
  configurationKey: "apiBaseUrl" | "uploadBaseUrl",
): string {
  let url: URL;
  const upstreamCode =
    configurationKey === "apiBaseUrl" ? "invalid-api-base-url" : "invalid-upload-base-url";

  try {
    url = new URL(value ?? DEFAULT_CLOUDINARY_API_BASE_URL);
  } catch {
    throw new CloudinaryValidationProblem(
      {
        provider: "cloudinary",
        operation: "configuration",
        upstreamCode,
      },
      `Cloudinary ${configurationKey} must be an absolute HTTP or HTTPS URL`,
    );
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new CloudinaryValidationProblem(
      {
        provider: "cloudinary",
        operation: "configuration",
        upstreamCode,
      },
      `Cloudinary ${configurationKey} must be an absolute HTTP or HTTPS URL without credentials, query, or fragment`,
    );
  }

  return url.origin;
}

function normalizeDownloadStream(stream: StorageStream, key: string): StorageStream {
  const reader = stream.getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }

        controller.enqueue(result.value);
      } catch (error) {
        controller.error(normalizeCloudinaryStorageError(error, { key, operation: "get" }));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Cloudinary를 이용해 파일 저장과 이미지 변환 URL 생성을 제공하는 구현체입니다.
 */
@Component()
export class CloudinaryProvider extends BaseStorageProvider implements ImageProvider {
  private readonly cloudName: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly secure: boolean;
  private readonly apiBaseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly ttl: number;

  constructor(config: CloudinaryConfig) {
    super();
    this.cloudName = config.cloudName;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.secure = config.secure ?? true;
    this.apiBaseUrl = normalizeCloudinaryBaseUrl(config.apiBaseUrl, "apiBaseUrl");
    this.uploadBaseUrl = normalizeCloudinaryBaseUrl(config.uploadBaseUrl, "uploadBaseUrl");
    this.ttl = config.ttl ?? 3600;
  }

  async put(key: string, data: StorageBody, options?: PutOptions): Promise<void> {
    this.validateKey(key);
    this.validateSupportedContentType(key, options?.contentType);
    this.assertOperationNotAborted(options, "put", key);

    const upload = async () => await this.uploadResource(key, data, options);
    const uploadPromise =
      data instanceof Uint8Array ? this.executeWithRetry(upload, options, "put", key) : upload();

    return uploadPromise.catch((error) => {
      this.rethrowOperationAbort(error, options, "put", key);
      throw normalizeCloudinaryStorageError(error, { key, operation: "put" });
    });
  }

  async getStream(key: string, options?: StorageOperationOptions): Promise<StorageStream> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getStream", key);

    const url = this.buildDeliveryUrl(key, resolveResourceType(key));

    try {
      const response = await this.executeWithRetry(
        async () => {
          const fetchedResponse = await fetch(url, { signal: options?.signal });

          if (!fetchedResponse.ok) {
            if (fetchedResponse.status === 404) {
              this.throwNotFound(key);
            }

            throw normalizeCloudinaryStorageError(
              {
                message: `Failed to fetch file: HTTP ${fetchedResponse.status}`,
                status: fetchedResponse.status,
              },
              { key, operation: "get", status: fetchedResponse.status },
            );
          }

          return fetchedResponse;
        },
        options,
        "getStream",
        key,
      );

      if (response.body === null) {
        throw normalizeCloudinaryStorageError(
          { message: "Cloudinary response body is missing" },
          { key, operation: "get" },
        );
      }

      return this.bindOperationSignal(
        normalizeDownloadStream(response.body, key),
        options,
        "getStream",
        key,
      );
    } catch (error) {
      this.rethrowOperationAbort(error, options, "getStream", key);
      throw normalizeCloudinaryStorageError(error, { key, operation: "get" });
    }
  }

  async delete(key: string, options?: StorageOperationOptions): Promise<void> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "delete", key);

    try {
      const result = await this.executeWithRetry(
        async () => await this.destroyResource(key, options),
        options,
        "delete",
        key,
      );

      if (result.result !== "ok" && result.result !== "not found") {
        throw new CloudinaryTerminalUpstreamProblem({
          provider: "cloudinary",
          operation: "delete",
          key,
          upstreamCode: result.result,
        });
      }
    } catch (error) {
      this.rethrowOperationAbort(error, options, "delete", key);
      throw normalizeCloudinaryStorageError(error, { key, operation: "delete" });
    }
  }

  getPublicUrl(key: string): string {
    this.validateKey(key);
    return cloudinary.url(resolveDeliveryKey(key), {
      cloud_name: this.cloudName,
      secure: this.secure,
      ...(resolveResourceType(key) === "image" ? {} : { resource_type: resolveResourceType(key) }),
    });
  }

  async getSignedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getSignedUrl", key);
    const expiresIn = validateSignedUrlExpiry(options.expiresIn);

    const url = cloudinary.url(resolveDeliveryKey(key), {
      cloud_name: this.cloudName,
      api_secret: this.apiSecret,
      secure: this.secure,
      sign_url: true,
      ...(resolveResourceType(key) === "image" ? {} : { resource_type: resolveResourceType(key) }),
      expiration: Math.floor(Date.now() / 1000) + expiresIn,
    });

    return url;
  }

  async getMetadata(key: string, options?: StorageOperationOptions): Promise<ObjectMetadata> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getMetadata", key);

    try {
      const resource = (await this.executeWithRetry(
        async () => await this.fetchResource(key, options),
        options,
        "getMetadata",
        key,
      )) as {
        bytes?: number;
        format?: string;
        created_at: string;
        etag?: string;
        context?: unknown;
      };

      return {
        size: resource.bytes ?? 0,
        contentType: resource.format,
        lastModified: new Date(resource.created_at),
        etag: resource.etag,
        metadata: resource.context ? this.parseContext(resource.context) : undefined,
      };
    } catch (error) {
      this.rethrowOperationAbort(error, options, "getMetadata", key);
      if (this.isNotFoundError(error)) {
        this.throwNotFound(key);
      }

      throw normalizeCloudinaryStorageError(error, { key, operation: "metadata" });
    }
  }

  getTransformUrl(key: string, options: TransformOptions): string {
    this.validateKey(key);

    const transformOptions = this.toCloudinaryTransformOptions(options);
    const params = this.buildTransformParams(transformOptions);

    return cloudinary.url(key, {
      cloud_name: this.cloudName,
      secure: this.secure,
      transformation: params,
    });
  }

  async getUploadIntent(key: string, options?: UploadIntentOptions): Promise<UploadIntent> {
    this.validateKey(key);
    this.assertOperationNotAborted(options, "getUploadIntent", key);
    const resourceType = resolveResourceType(key);
    if (resourceType === "image" && key.slice(key.lastIndexOf("/") + 1).includes(".")) {
      throw new InvalidKeyProblem(
        key,
        "Cloudinary image upload intent keys must omit the file extension",
      );
    }

    const ttl = options?.ttlInSeconds ?? this.ttl;
    if (!isValidCloudinaryUploadIntentTtl(ttl)) {
      throw ProblemFactory.invalidArgument(
        "storage-cloudinary/invalid-upload-intent-ttl",
        `ttlInSeconds must be an integer between 1 and ${CLOUDINARY_UPLOAD_SIGNATURE_VALIDITY_SECONDS}`,
      );
    }

    const now = Date.now();
    const timestamp = Math.floor(now / 1000);
    const signedFields = {
      public_id: key,
      timestamp,
    };
    const uploadUrl = new URL(
      `/v1_1/${this.cloudName}/${resourceType}/upload`,
      this.uploadBaseUrl,
    ).toString();
    const publicUrl = this.getPublicUrl(key);
    const expiresAt = new Date(now + ttl * 1000);

    return {
      uploadUrl,
      publicUrl,
      fields: {
        api_key: this.apiKey,
        public_id: signedFields.public_id,
        signature: cloudinary.utils.api_sign_request(signedFields, this.apiSecret),
        timestamp: String(signedFields.timestamp),
      },
      expiresAt,
    };
  }

  private buildDeliveryUrl(key: string, resourceType: string): string {
    const protocol = this.secure ? "https" : "http";
    return `${protocol}://res.cloudinary.com/${this.cloudName}/${resourceType}/upload/${resolveDeliveryKey(key)}`;
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
      retryPolicy: CLOUDINARY_RETRY_POLICY,
      signal: options?.signal,
    });
    return await retryTemplate.execute(async () => {
      this.assertOperationNotAborted(options, operationName, key);
      const result = await operation();
      this.assertOperationNotAborted(options, operationName, key);
      return result;
    });
  }

  private async uploadResource(
    key: string,
    data: StorageBody,
    options?: PutOptions,
  ): Promise<void> {
    const resourceType = resolveResourceType(key);
    const timestamp = Math.floor(Date.now() / 1000);
    const context = options?.metadata ? this.formatContext(options.metadata) : undefined;
    const signedFields = {
      ...(context === undefined ? {} : { context }),
      public_id: key,
      timestamp,
    };
    const fields = {
      api_key: this.apiKey,
      ...(context === undefined ? {} : { context }),
      public_id: key,
      signature: cloudinary.utils.api_sign_request(signedFields, this.apiSecret),
      timestamp: String(timestamp),
    };
    const boundary = `----croco-cloudinary-${randomBytes(12).toString("hex")}`;
    const prefix = this.buildMultipartPrefix(
      boundary,
      fields,
      key,
      options?.contentType ?? "application/octet-stream",
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const signal = options?.signal;
    let body: BodyInit;
    let duplex: "half" | undefined;

    if (data instanceof Uint8Array) {
      body = Buffer.concat([prefix, data, suffix]);
    } else {
      body = this.createMultipartBody(
        prefix,
        this.bindOperationSignal(data, options, "put", key),
        suffix,
      );
      duplex = "half";
    }

    const response = await fetch(this.buildCloudinaryApiUrl(resourceType, "upload"), {
      body,
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      method: "POST",
      signal,
      ...(duplex === undefined ? {} : { duplex }),
    } as RequestInit & { duplex?: "half" });
    const result = await this.readCloudinaryResponse(response, "Cloudinary upload request failed");
    if (typeof result !== "object" || result === null || Reflect.get(result, "public_id") !== key) {
      const responseError = new Error(
        "Cloudinary upload response did not confirm the requested public ID",
      ) as CloudinarySdkError;
      responseError.code = "invalid-upload-response";
      throw responseError;
    }
    this.assertOperationNotAborted(options, "put", key);
  }

  private buildMultipartPrefix(
    boundary: string,
    fields: Readonly<Record<string, string>>,
    key: string,
    contentType: string,
  ): Buffer {
    const fieldParts = Object.entries(fields).map(([name, value]) =>
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
    const filename = key.slice(key.lastIndexOf("/") + 1).replace(/["\r\n]/g, "_");
    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    return Buffer.concat([...fieldParts, fileHeader]);
  }

  private createMultipartBody(
    prefix: Uint8Array,
    source: StorageStream,
    suffix: Uint8Array,
  ): StorageStream {
    const reader = source.getReader();
    let prefixSent = false;

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!prefixSent) {
          prefixSent = true;
          controller.enqueue(prefix);
          return;
        }

        const result = await reader.read();
        if (!result.done) {
          controller.enqueue(result.value);
          return;
        }

        controller.enqueue(suffix);
        controller.close();
      },
      cancel: async (reason) => {
        await reader.cancel(reason);
      },
    });
  }

  private async destroyResource(
    key: string,
    options?: StorageOperationOptions,
  ): Promise<{ result: string }> {
    const resourceType = resolveResourceType(key);
    const timestamp = Math.floor(Date.now() / 1000);
    const signedFields = { public_id: key, timestamp };
    const body = new URLSearchParams({
      api_key: this.apiKey,
      public_id: key,
      signature: cloudinary.utils.api_sign_request(signedFields, this.apiSecret),
      timestamp: String(timestamp),
    });
    const response = await fetch(this.buildCloudinaryApiUrl(resourceType, "destroy"), {
      body,
      method: "POST",
      signal: options?.signal,
    });
    return (await this.readCloudinaryResponse(response, "Cloudinary destroy request failed")) as {
      result: string;
    };
  }

  private async fetchResource(key: string, options?: StorageOperationOptions): Promise<unknown> {
    const resourceType = resolveResourceType(key);
    const response = await fetch(
      this.buildCloudinaryApiUrl("resources", resourceType, "upload", key),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")}`,
        },
        signal: options?.signal,
      },
    );
    return await this.readCloudinaryResponse(response, "Cloudinary resource request failed");
  }

  private buildCloudinaryApiUrl(...segments: readonly string[]): string {
    const encodedPath = ["v1_1", this.cloudName, ...segments].map(encodeURIComponent).join("/");
    return new URL(`/${encodedPath}`, this.apiBaseUrl).toString();
  }

  private async readCloudinaryResponse(
    response: Response,
    fallbackMessage: string,
  ): Promise<unknown> {
    let result: unknown;
    try {
      result = await response.json();
    } catch (error) {
      if (response.ok) {
        const responseError = new Error(
          `${fallbackMessage}: expected a valid JSON response`,
        ) as CloudinarySdkError;
        Object.defineProperty(responseError, "cause", {
          configurable: true,
          value: error,
        });
        responseError.http_code = response.status;
        responseError.status = response.status;
        responseError.statusCode = response.status;
        throw responseError;
      }

      result = undefined;
    }

    if (response.ok) {
      return result;
    }

    const error = toCloudinarySdkError(result, fallbackMessage);
    error.http_code = response.status;
    error.status = response.status;
    error.statusCode = response.status;
    throw error;
  }

  private buildTransformParams(options: CloudinaryTransformOptions): string | undefined {
    const params: string[] = [];

    if (options.width !== undefined) {
      params.push(`w_${options.width}`);
    }

    if (options.height !== undefined) {
      params.push(`h_${options.height}`);
    }

    if (options.crop !== undefined) {
      params.push(`c_${options.crop}`);
    }

    if (options.quality !== undefined) {
      params.push(`q_${options.quality}`);
    }

    if (options.format !== undefined) {
      params.push(`f_${options.format}`);
    }

    if (options.dpr !== undefined) {
      params.push(`dpr_${options.dpr}`);
    }

    return params.length > 0 ? params.join(",") : undefined;
  }

  private toCloudinaryTransformOptions(options: TransformOptions): CloudinaryTransformOptions {
    const transformOptions: CloudinaryTransformOptions = {};

    if (options.width !== undefined) {
      transformOptions.width = options.width;
    }

    if (options.height !== undefined) {
      transformOptions.height = options.height;
    }

    if (options.fit !== undefined) {
      transformOptions.crop = this.mapFitMode(options.fit);
    }

    if (options.quality !== undefined) {
      transformOptions.quality = options.quality;
    }

    if (options.format !== undefined && options.format !== "auto") {
      transformOptions.format = options.format;
    }

    if (options.dpr !== undefined) {
      transformOptions.dpr = options.dpr;
    }

    return transformOptions;
  }

  private mapFitMode(
    fit: "cover" | "contain" | "fill" | "inside" | "outside",
  ): CloudinaryTransformOptions["crop"] {
    switch (fit) {
      case "cover":
        return "fill";
      case "contain":
        return "fit";
      case "fill":
        return "pad";
      case "inside":
        return "limit";
      case "outside":
        return "crop";
      default:
        return undefined;
    }
  }

  private validateSupportedContentType(key: string, contentType?: string): void {
    if (contentType === undefined) {
      return;
    }
    const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    const contentResourceType = mimeType?.startsWith("image/")
      ? "image"
      : mimeType?.startsWith("video/") || mimeType?.startsWith("audio/")
        ? "video"
        : "raw";
    if (
      !/[\r\n]/.test(contentType) &&
      (mimeType === "application/octet-stream" || contentResourceType === resolveResourceType(key))
    ) {
      return;
    }

    throw new CloudinaryValidationProblem(
      {
        provider: "cloudinary",
        operation: "put",
        key,
        upstreamCode: "unsupported-resource-type",
      },
      `Content type '${contentType}' must match the resource type selected by the key extension and contain no line breaks`,
    );
  }

  private formatContext(metadata: Record<string, string>): string {
    return Object.entries(metadata)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("|");
  }

  private parseContext(context: unknown): Record<string, string> {
    if (typeof context === "string") {
      return context.split("|").reduce<Record<string, string>>((acc, pair) => {
        const separatorIndex = pair.indexOf("=");

        if (separatorIndex === -1) {
          return acc;
        }

        const rawKey = pair.slice(0, separatorIndex);
        const rawValue = pair.slice(separatorIndex + 1);

        acc[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
        return acc;
      }, {});
    }

    if (context && typeof context === "object" && "custom" in context) {
      const custom = Reflect.get(context, "custom");
      if (custom && typeof custom === "object") {
        return Object.entries(custom).reduce<Record<string, string>>((acc, [key, value]) => {
          if (typeof value === "string") {
            acc[decodeURIComponent(key)] = decodeURIComponent(value);
          }

          return acc;
        }, {});
      }
    }

    if (context && typeof context === "object") {
      return Object.entries(context).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === "string") {
          acc[decodeURIComponent(key)] = decodeURIComponent(value);
        }

        return acc;
      }, {});
    }

    return {};
  }

  private isNotFoundError(error: unknown): boolean {
    if (typeof error === "object" && error !== null && Reflect.get(error, "http_code") === 404) {
      return true;
    }

    if (typeof error === "object" && error !== null && Reflect.get(error, "status") === 404) {
      return true;
    }

    if (typeof error === "object" && error !== null && Reflect.get(error, "statusCode") === 404) {
      return true;
    }

    const message = getCloudinaryErrorMessage(error, "").toLowerCase();
    return message.includes("not found");
  }
}
