import { Problem, ProblemCategory } from "@croco/problems-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessEngine } from "../libs/AccessEngine";
import type { AccessProvider } from "../libs/interfaces/AccessProvider";
import type {
  CheckRequest,
  CheckResult,
  GrantRequest,
  ListRequest,
  RelationTuple,
  RevokeRequest,
} from "../libs/types";

class TestBusinessProblem extends Problem {
  constructor(detail = "Business problem") {
    super("TEST_BUSINESS_PROBLEM", ProblemCategory.BusinessRuleViolation, detail);
  }
}

class TestSystemProblem extends Problem {
  constructor(detail = "System problem") {
    super("TEST_SYSTEM_PROBLEM", ProblemCategory.InternalServerError, detail);
  }
}

describe("AccessEngine", () => {
  let accessEngine!: AccessEngine;
  let mockProvider!: AccessProvider;

  beforeEach(() => {
    mockProvider = {
      check: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(),
      list: vi.fn(),
    };
    accessEngine = new AccessEngine(mockProvider);
  });

  describe("check", () => {
    it("should deny when provider returns false", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockResolvedValue({ decision: "deny", allowed: false });

      const result = await accessEngine.check(request);

      expect(result.allowed).toBe(false);
      expect(result.trace).toMatchObject({
        policyKind: "access",
        result: "deny",
        ruleId: "access:document:viewer",
        subjectRef: "user:user-1",
        resourceRef: "document:document-1",
        tenantId: "tenant-1",
      });
      expect(mockProvider.check).toHaveBeenCalledWith(request);
    });

    it("should allow when provider returns true", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "editor",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockResolvedValue({ decision: "allow", allowed: true });

      const result = await accessEngine.check(request);

      expect(result.allowed).toBe(true);
      expect(result.trace).toMatchObject({
        policyKind: "access",
        result: "allow",
      });
      expect(mockProvider.check).toHaveBeenCalledWith(request);
    });

    it("should enforce tenantId hard filter", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockResolvedValue({ decision: "allow", allowed: true });

      const result = await accessEngine.check(request);

      expect(result.allowed).toBe(true);
      expect(mockProvider.check).toHaveBeenCalledWith(request);
    });

    it("should deny on provider business problem (fail-closed)", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockRejectedValue(
        new TestBusinessProblem("Provider business error"),
      );

      const result = await accessEngine.check(request);

      expect(result.allowed).toBe(false);
      expect(result.decision).toBe("abstain");
      expect(result.trace).toMatchObject({
        policyKind: "access",
        result: "abstain",
        reason: "Provider business error",
      });
    });

    it("should normalize the compatibility boolean from the provider decision", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      const contradictoryRuntimeResult = {
        decision: "deny",
        allowed: true,
      } as unknown as CheckResult;
      vi.mocked(mockProvider.check).mockResolvedValue(contradictoryRuntimeResult);

      const result = await accessEngine.check(request);

      expect(result).toMatchObject({
        decision: "deny",
        allowed: false,
        trace: { result: "deny" },
      });
    });

    it("should reject provider results without an authoritative decision", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockResolvedValue({ allowed: true } as unknown as CheckResult);

      await expect(accessEngine.check(request)).rejects.toMatchObject({
        code: "access-core/invalid-provider-result",
      });
    });

    it("should reject provider results with an unsupported decision", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockResolvedValue({
        decision: "unsupported",
        allowed: false,
      } as unknown as CheckResult);

      await expect(accessEngine.check(request)).rejects.toMatchObject({
        code: "access-core/invalid-provider-result",
      });
    });

    it.each([null, undefined])("should reject a %s provider result", async (providerResult) => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockResolvedValue(providerResult as unknown as CheckResult);

      await expect(accessEngine.check(request)).rejects.toMatchObject({
        code: "access-core/invalid-provider-result",
      });
    });

    it("should record a trace through the configured audit sink", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
        ruleId: "access:document:viewer",
        sourceLocation: {
          file: "routes/documents.ts",
          line: 10,
        },
        inputs: {
          authorization: "Bearer secret-token",
        },
      };
      const traceSink = {
        recordPolicyDecisionTrace: vi.fn(async () => undefined),
      };
      accessEngine = new AccessEngine(mockProvider, { traceSink });
      vi.mocked(mockProvider.check).mockResolvedValue({ decision: "deny", allowed: false });

      const result = await accessEngine.check(request);

      expect(result.trace).toMatchObject({
        result: "deny",
        ruleId: "access:document:viewer",
        sourceLocation: {
          file: "routes/documents.ts",
          line: 10,
        },
      });
      expect(result.trace?.inputs.authorization).toBe("[Redacted]");
      expect(traceSink.recordPolicyDecisionTrace).toHaveBeenCalledWith(result.trace);
    });

    it("should re-throw on provider system problem", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockRejectedValue(
        new TestSystemProblem("DB connection failed"),
      );

      await expect(accessEngine.check(request)).rejects.toThrow(TestSystemProblem);
    });

    it("should re-throw on provider system exception", async () => {
      const request: CheckRequest = {
        tenantId: "tenant-1",
        subject: "user:user-1",
        relation: "viewer",
        object: "document:document-1",
      };
      vi.mocked(mockProvider.check).mockRejectedValue(
        new TypeError("Cannot read properties of undefined"),
      );

      await expect(accessEngine.check(request)).rejects.toThrow(TypeError);
    });
  });

  describe("grant", () => {
    it("should delegate to provider", async () => {
      const request: GrantRequest = {
        tenantId: "tenant-1",
        tuple: {
          object: "document:document-1",
          relation: "editor",
          subject: "user:user-1",
        },
      };
      vi.mocked(mockProvider.grant).mockResolvedValue(undefined);

      await accessEngine.grant(request);

      expect(mockProvider.grant).toHaveBeenCalledWith(request);
    });

    it.each([
      {
        field: "tuple.object",
        tuple: { object: "documents", relation: "viewer", subject: "user:user-1" },
      },
      {
        field: "tuple.relation",
        tuple: { object: "document:document-1", relation: "", subject: "user:user-1" },
      },
      {
        field: "tuple.subject",
        tuple: { object: "document:document-1", relation: "viewer", subject: "account:user-1" },
      },
      {
        field: "tuple",
        tuple: null,
      },
    ])("should reject an invalid $field before calling the provider", async ({ field, tuple }) => {
      const request = {
        tenantId: "tenant-1",
        tuple,
      } as unknown as GrantRequest;

      await expect(accessEngine.grant(request)).rejects.toMatchObject({
        category: ProblemCategory.BadRequest,
        code: "access-core/invalid-relation-tuple",
        extensions: { field },
      });
      expect(mockProvider.grant).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it.each(["user:user-1", "role:editor", "group:team-1"] as const)(
      "should forward a valid %s tuple unchanged to the provider",
      async (subject) => {
        const request: RevokeRequest = {
          tenantId: "tenant-1",
          tuple: {
            object: "document:document-1",
            relation: "editor",
            subject,
          },
        };
        vi.mocked(mockProvider.revoke).mockResolvedValue(undefined);

        await accessEngine.revoke(request);

        expect(mockProvider.revoke).toHaveBeenCalledExactlyOnceWith(request);
        expect(vi.mocked(mockProvider.revoke).mock.calls[0]?.[0]).toBe(request);
      },
    );

    it.each([
      {
        field: "tuple.object",
        tuple: { object: "documents", relation: "viewer", subject: "user:user-1" },
      },
      {
        field: "tuple.object",
        tuple: { object: "document:", relation: "viewer", subject: "user:user-1" },
      },
      {
        field: "tuple.object",
        tuple: { relation: "viewer", subject: "user:user-1" },
      },
      {
        field: "tuple.relation",
        tuple: { object: "document:document-1", relation: "", subject: "user:user-1" },
      },
      {
        field: "tuple.relation",
        tuple: { object: "document:document-1", relation: "  ", subject: "user:user-1" },
      },
      {
        field: "tuple.relation",
        tuple: { object: "document:document-1", subject: "user:user-1" },
      },
      {
        field: "tuple.subject",
        tuple: { object: "document:document-1", relation: "viewer", subject: "account:user-1" },
      },
      {
        field: "tuple.subject",
        tuple: { object: "document:document-1", relation: "viewer", subject: "user:" },
      },
      {
        field: "tuple.subject",
        tuple: { object: "document:document-1", relation: "viewer" },
      },
      { field: "tuple", tuple: null },
      { field: "tuple", tuple: undefined },
      { field: "tuple", tuple: "document:document-1" },
    ])("should reject an invalid $field before calling the provider", async ({ field, tuple }) => {
      const request = { tenantId: "tenant-1", tuple } as unknown as RevokeRequest;

      await expect(accessEngine.revoke(request)).rejects.toMatchObject({
        category: ProblemCategory.BadRequest,
        code: "access-core/invalid-relation-tuple",
        extensions: { field },
      });
      expect(mockProvider.revoke).not.toHaveBeenCalled();
    });

    it("should propagate a provider failure for a valid tuple", async () => {
      const request: RevokeRequest = {
        tenantId: "tenant-1",
        tuple: { object: "document:document-1", relation: "editor", subject: "user:user-1" },
      };
      const problem = new TestSystemProblem("Revoke failed");
      vi.mocked(mockProvider.revoke).mockRejectedValue(problem);

      await expect(accessEngine.revoke(request)).rejects.toBe(problem);
      expect(mockProvider.revoke).toHaveBeenCalledExactlyOnceWith(request);
    });
  });

  describe("list", () => {
    it("should delegate to provider", async () => {
      const request: ListRequest = {
        tenantId: "tenant-1",
        object: "document:document-1",
      };
      const mockTuples: RelationTuple[] = [
        { object: "document:document-1", relation: "editor", subject: "user:user-1" },
      ];
      vi.mocked(mockProvider.list).mockResolvedValue(mockTuples);

      const result = await accessEngine.list(request);

      expect(result).toEqual(mockTuples);
      expect(mockProvider.list).toHaveBeenCalledWith(request);
    });
  });
});
