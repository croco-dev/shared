import { describe, expect, it } from "vitest";
import { TrpcExecutionContext } from "../libs/TrpcExecutionContext";

class TestController {}

function normalizeRequest(headers: Record<string, unknown>, encrypted = false): Request {
  return new TrpcExecutionContext(
    { req: { url: "/trpc/users?batch=1", method: "GET", headers, socket: { encrypted } } },
    TestController,
    "users",
    "/users",
    "GET",
  ).getRequest();
}

describe("TrpcExecutionContext Node request normalization", () => {
  it("normalizes HTTP/2 pseudo-headers while preserving ordinary headers", () => {
    const request = normalizeRequest({
      ":method": "GET",
      ":path": "/trpc/users?batch=1",
      ":authority": "api.example.test:8080",
      ":scheme": "http",
      ":protocol": ["websocket"],
      authorization: "Bearer test-token",
      "x-tag": ["first", "second"],
    });

    expect(request.url).toBe("http://api.example.test:8080/trpc/users?batch=1");
    expect(request.method).toBe("GET");
    expect([...request.headers]).toEqual([
      ["authorization", "Bearer test-token"],
      ["host", "api.example.test:8080"],
      ["x-tag", "first, second"],
    ]);
  });

  it.each(["api.example.test:8443", "[::1]:8443"])(
    "preserves encrypted sockets and authority ports for %s",
    (authority) => {
      const request = normalizeRequest({ ":authority": authority, ":scheme": "http" }, true);

      expect(request.url).toBe(`https://${authority}/trpc/users?batch=1`);
      expect(request.headers.get("host")).toBe(authority);
    },
  );

  it("prefers the existing Host header over HTTP/2 authority", () => {
    const request = normalizeRequest({
      Host: "host.example.test",
      ":authority": "authority.example.test",
    });

    expect(request.url).toBe("http://host.example.test/trpc/users?batch=1");
    expect(request.headers.get("host")).toBe("host.example.test");
  });

  it.each([undefined, null, 42, ["api.example.test"]].map((authority) => ({ authority })))(
    "does not coerce a non-string authority (%j) into the URL",
    ({ authority }) => {
      const request = normalizeRequest({ ":authority": authority });
      expect(request.url).toBe("http://localhost/trpc/users?batch=1");
      expect(request.headers.has("host")).toBe(false);
    },
  );

  it("preserves HTTP/1.1 headers and URL normalization", () => {
    const request = normalizeRequest({ host: "http1.example.test", "x-tag": ["first", "second"] });

    expect(request.url).toBe("http://http1.example.test/trpc/users?batch=1");
    expect(request.headers.get("x-tag")).toBe("first, second");
  });

  it("preserves localhost when neither Host nor authority is present", () => {
    expect(normalizeRequest({}).url).toBe("http://localhost/trpc/users?batch=1");
  });

  it.each([
    { ":authority": "[invalid" },
    { ":authority": "api.example.test", "invalid header": "value" },
    { ":authority": "api.example.test", "x-tag": ["valid", "invalid\nvalue"] },
  ])("keeps invalid URLs and ordinary headers as normalization failures (%j)", (headers) => {
    expect(() => normalizeRequest(headers)).toThrow(
      expect.objectContaining({ code: "protocols-trpc/request-normalization-failed" }),
    );
  });
});
