import { v2 as cloudinary } from "cloudinary";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CloudinaryDiagnosticsProvider,
  getCloudinaryErrorMessage,
  normalizeCloudinaryStorageError,
} from "../libs/CloudinaryDiagnosticsProvider";

const validConfig = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  cloudName: "test-cloud",
  secure: true,
};

describe("CloudinaryDiagnosticsProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports unhealthy readiness when required configuration is missing", async () => {
    const provider = new CloudinaryDiagnosticsProvider({
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
    });

    const health = await provider.getHealth();

    expect(health).toMatchObject({
      status: "unhealthy",
      component: "storage-cloudinary",
      details: {
        liveCheck: "not_started",
        problemCode: "storage-cloudinary/missing-config",
        problemStatus: 500,
        hasCloudName: false,
        hasApiKey: true,
        hasApiSecret: true,
      },
    });
  });

  it("reports unhealthy readiness when upload intent TTL exceeds signature validity", async () => {
    const provider = new CloudinaryDiagnosticsProvider({ ...validConfig, ttl: 3601 });

    const health = await provider.getHealth();

    expect(health).toMatchObject({
      status: "unhealthy",
      component: "storage-cloudinary",
      details: {
        liveCheck: "not_started",
        problemCode: "storage-cloudinary/validation-failed",
        problemStatus: 422,
      },
    });
  });

  it("reports healthy readiness without mutating global Cloudinary config when live check is not configured", async () => {
    const configSpy = vi.spyOn(cloudinary, "config");
    const provider = new CloudinaryDiagnosticsProvider(validConfig);

    const health = await provider.getHealth();

    expect(configSpy).not.toHaveBeenCalled();
    expect(health).toMatchObject({
      status: "healthy",
      component: "storage-cloudinary",
      details: {
        acceptedResourceTypes: ["image", "video", "raw"],
        liveCheck: "not_configured",
        hasCloudName: true,
        hasApiKey: true,
        hasApiSecret: true,
        metadataSupport: {
          contentType: "format-only",
          customMetadata: "required",
        },
      },
    });
  });

  it("sanitizes readiness details returned by a live check", async () => {
    const provider = new CloudinaryDiagnosticsProvider(validConfig, {
      readinessCheck: async () => ({
        details: {
          cloudName: "test-cloud",
          apiKey: "must-not-leak",
          nested: {
            apiSecret: "must-not-leak",
          },
        },
      }),
    });

    const health = await provider.getHealth();

    expect(health).toMatchObject({
      status: "healthy",
      details: {
        liveCheck: "passed",
        readiness: {
          cloudName: "test-cloud",
          apiKey: "[redacted]",
          nested: {
            apiSecret: "[redacted]",
          },
        },
      },
    });
  });

  it("normalizes failed live checks to deterministic provider Problem codes", async () => {
    const provider = new CloudinaryDiagnosticsProvider(validConfig, {
      readinessCheck: async () => {
        throw { http_code: 403, message: "Forbidden" };
      },
    });

    const health = await provider.getHealth();

    expect(health).toMatchObject({
      status: "degraded",
      component: "storage-cloudinary",
      details: {
        liveCheck: "failed",
        problemCode: "storage-cloudinary/validation-failed",
        problemStatus: 422,
      },
    });
  });

  it("normalizes nested Cloudinary error payloads", () => {
    const problem = normalizeCloudinaryStorageError(
      {
        error: {
          code: "RATE_LIMITED",
          http_code: 429,
          message: "Too many requests",
        },
      },
      { operation: "readiness" },
    );

    expect(getCloudinaryErrorMessage({ error: { message: "Too many requests" } }, "fallback")).toBe(
      "Too many requests",
    );
    expect(problem).toMatchObject({
      code: "storage-cloudinary/retryable-upstream",
      extensions: {
        provider: "cloudinary",
        operation: "readiness",
        upstreamStatus: 429,
        upstreamCode: "RATE_LIMITED",
        retryable: true,
      },
    });
  });
});
