import "reflect-metadata";
import { Problem, ProblemCategory } from "@croco/problems-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpExceptionFilter } from "../libs/filters/HttpExceptionFilter";
import {
  createHttpProblemDetails,
  redactHttpProblemDetailsBody,
} from "../libs/problemResponseSerializer";
import type { ExecutionContext } from "../libs/interfaces/ExecutionContext";

const REQUEST_PATH = "/api/resource";
const SECRET_QUERY = "token=secret-reset-token";
const PUBLIC_INSTANCE = `https://example.test${REQUEST_PATH}`;

class ResourceNotFoundProblem extends Problem {
  constructor() {
    super("RESOURCE_NOT_FOUND", ProblemCategory.NotFound, "Resource not found", {
      type: "not-found",
      instance: "/api/resource",
      extensions: {
        issues: [{ resourceId: "resource-1" }],
        resourceId: "resource-1",
        token: "secret-token",
      },
    });
  }
}

describe("HttpExceptionFilter", () => {
  let filter!: HttpExceptionFilter;
  let mockContext!: ExecutionContext;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    mockContext = {
      getRequest: vi.fn(() => new Request(`https://example.test${REQUEST_PATH}?${SECRET_QUERY}`)),
      getClass: vi.fn(),
      getHandler: vi.fn(),
      getPath: vi.fn(() => REQUEST_PATH),
      getMethod: vi.fn(),
    } as unknown as ExecutionContext;
  });

  it("should convert Problem instances to RFC 7807 response", () => {
    const problem = new ResourceNotFoundProblem();

    const result = filter.catch(problem, mockContext);

    expect(result).toEqual({
      status: 404,
      headers: { "Content-Type": "application/problem+json" },
      body: {
        type: "not-found",
        title: "Not Found",
        status: 404,
        code: "RESOURCE_NOT_FOUND",
        detail: "Resource not found",
        instance: PUBLIC_INSTANCE,
        issues: [{ resourceId: "resource-1" }],
      },
    });
    expect(JSON.stringify(result.body)).not.toContain("secret-token");
    expect(JSON.stringify(result.body)).not.toContain(SECRET_QUERY);
    expect(result.body).not.toHaveProperty("resourceId");
  });

  it.each([
    ["Problem", new ResourceNotFoundProblem(), 404, "RESOURCE_NOT_FOUND"],
    [
      "serialized Problem",
      {
        type: "forbidden",
        title: "Forbidden",
        status: 403,
        code: "FORBIDDEN",
        detail: "Access denied",
      },
      403,
      "FORBIDDEN",
    ],
    ["unknown error", new Error("private failure"), 500, "INTERNAL_SERVER_ERROR"],
  ])(
    "should preserve %s responses when the request is unavailable",
    (_name, exception, status, code) => {
      const expected = filter.catch(exception, mockContext);
      vi.mocked(mockContext.getRequest).mockImplementation(() => {
        throw new Error("HTTP request unavailable");
      });
      vi.mocked(mockContext.getPath).mockReturnValue(
        `${REQUEST_PATH}?${SECRET_QUERY}#private-fragment`,
      );

      const result = filter.catch(exception, mockContext);

      expect(result).toEqual({
        ...expected,
        body: expected.body.instance ? { ...expected.body, instance: REQUEST_PATH } : expected.body,
      });
      expect(result.status).toBe(status);
      expect(result.body.code).toBe(code);
      expect(mockContext.getPath).toHaveBeenCalledOnce();
    },
  );

  it("should retain the HTTP URL without reading the fallback path", () => {
    vi.mocked(mockContext.getPath).mockImplementation(() => {
      throw new Error("Path unavailable");
    });

    expect(filter.catch(new ResourceNotFoundProblem(), mockContext).body.instance).toBe(
      PUBLIC_INSTANCE,
    );
    expect(mockContext.getPath).not.toHaveBeenCalled();
  });

  it("should remove query and fragment secrets from source-provided instances", () => {
    const sourceProblem = new ResourceNotFoundProblem();
    const problemBody = createHttpProblemDetails(
      sourceProblem,
      "/api/resource?token=source-secret#fragment",
    );
    const serializedBody = redactHttpProblemDetailsBody({
      type: "forbidden",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
      detail: "Access denied",
      instance: "/serialized?token=serialized-secret#fragment",
    });

    expect(problemBody.instance).toBe("/api/resource");
    expect(serializedBody?.instance).toBe("/serialized");
    expect(JSON.stringify({ problemBody, serializedBody })).not.toContain("secret");
    expect(JSON.stringify({ problemBody, serializedBody })).not.toContain("fragment");
  });

  it("should handle non-Problem errors with 500 status", () => {
    const error = new Error("Something went wrong");

    const result = filter.catch(error, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe("INTERNAL_SERVER_ERROR");
    // plain Error: detail should be generic, not the error message
    expect(result.body.detail).toBe("An internal error occurred");
  });

  it("should set correct Content-Type header", () => {
    const problem = {
      type: "bad-request",
      title: "Bad Request",
      status: 400,
      code: "BAD_REQUEST",
    };

    const result = filter.catch(problem, mockContext);

    expect(result.headers).toEqual({ "Content-Type": "application/problem+json" });
  });

  it("should accept validated serialized Problem details", () => {
    const problem = {
      type: "validation-error",
      title: "Validation Error",
      status: 422,
      code: "VALIDATION_ERROR",
      detail: "Invalid input",
    };

    const result = filter.catch(problem, mockContext);

    expect(result.status).toBe(422);
    expect(result.body.status).toBe(422);
  });

  it("should preserve only public extension fields from validated serialized Problem details", () => {
    const problem = {
      type: "forbidden",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
      detail: "Access denied",
      instance: "/source-instance",
      issues: [{ field: "role", message: "Access denied" }],
      additionalField: "extra data",
      token: "secret-token",
    };

    const result = filter.catch(problem, mockContext);

    expect(result.body).toEqual({
      type: "forbidden",
      title: "Forbidden",
      status: 403,
      code: "FORBIDDEN",
      detail: "Access denied",
      instance: PUBLIC_INSTANCE,
      issues: [{ field: "role", message: "Access denied" }],
    });
    expect(JSON.stringify(result.body)).not.toContain("secret-token");
    expect(JSON.stringify(result.body)).not.toContain(SECRET_QUERY);
    expect(result.body).not.toHaveProperty("additionalField");
  });

  it("should redact operator-only detail and extensions", () => {
    const problem = new (class extends Problem {
      constructor() {
        super(
          "transports-http/di-bootstrap-validation",
          ProblemCategory.InternalServerError,
          "DI bootstrap failed for tenant secret-tenant",
          {
            extensions: {
              issues: [{ message: "container token missing" }],
              reason: "di_failure",
              rawProviderResponse: { token: "secret-provider-token" },
            },
          },
        );
      }
    })();

    const result = filter.catch(problem, mockContext);

    expect(result.body).toEqual({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      code: "transports-http/di-bootstrap-validation",
      detail: "An internal error occurred",
      instance: PUBLIC_INSTANCE,
    });
    expect(JSON.stringify(result.body)).not.toContain("secret-tenant");
    expect(JSON.stringify(result.body)).not.toContain("secret-provider-token");
    expect(JSON.stringify(result.body)).not.toContain(SECRET_QUERY);
  });

  it("should handle Error with message", () => {
    const error = new Error("Database connection failed");

    const result = filter.catch(error, mockContext);

    expect(result.body.detail).toBe("An internal error occurred");
    expect(result.body.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should handle non-Error non-Problem exceptions", () => {
    const exception = "string error";

    const result = filter.catch(exception, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.detail).toBe("An internal error occurred");
  });

  it("should handle null exception", () => {
    const result = filter.catch(null, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.detail).toBe("An internal error occurred");
  });

  it("should handle undefined exception", () => {
    const result = filter.catch(undefined, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.detail).toBe("An internal error occurred");
  });

  it("should handle object without status property (non-Problem)", () => {
    const error = { message: "Custom error object" };

    const result = filter.catch(error, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should handle object with status but without toJSON (non-Problem)", () => {
    const error = { status: 400 };

    const result = filter.catch(error, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should reject objects that only mimic the old status and toJSON shape", () => {
    const problem = {
      status: 403,
      toJSON: () => ({
        type: "forbidden",
        title: "Forbidden",
        status: 403,
        code: "FORBIDDEN",
        detail: "Access denied",
        instance: "/api/resource",
        additionalField: "extra data",
      }),
    };

    const result = filter.catch(problem, mockContext);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should use default message for Error without message", () => {
    const error = new Error();

    const result = filter.catch(error, mockContext);

    expect(result.body.detail).toBe("An internal error occurred");
  });

  it("should handle empty string error", () => {
    const result = filter.catch("", mockContext);

    expect(result.body.detail).toBe("An internal error occurred");
  });

  it("should return consistent response structure", () => {
    const problem = {
      type: "unauthorized",
      title: "Unauthorized",
      status: 401,
      code: "UNAUTHORIZED",
      detail: "Authentication required",
    };

    const result = filter.catch(problem, mockContext);

    expect(Object.keys(result)).toEqual(["status", "headers", "body"]);
    expect(Object.keys(result.headers)).toEqual(["Content-Type"]);
  });
});
