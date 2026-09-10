import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Container, MetadataStorage } from "@croco/framework-context";
import { Problem, ProblemFactory } from "@croco/problems-core";
import {
  authGuardConformance,
  createConformanceProtocolUser,
} from "../../../../test-support/authGuardConformance";
import { GRAPHQL_GUARDS_KEY, GRAPHQL_ROLES_KEY, RESOLVERS_KEY } from "../libs/constants";
import { GraphQLResolver } from "../libs/decorators";
import { GRAPHQL_AUTH_GUARD_OPTIONS, GraphQLAuthGuard } from "../libs/guards/AuthGuard";
import { GuardChain } from "../libs/guards/GuardChain";
import { GuardInterceptor } from "../libs/interceptors/GuardInterceptor";
import { GuardDeniedProblem } from "../libs/problems/GuardProblems";
import { GraphQLRolesGuard, type UserWithRoles } from "../libs/guards/RolesGuard";
import type { GraphQLGuardContext } from "../libs/types/GuardTypes";

const createMockContext = (overrides: Partial<GraphQLGuardContext> = {}): GraphQLGuardContext => ({
  root: {},
  args: {},
  context: {},
  info: {
    fieldName: "test",
    fieldNodes: [],
    returnType: {} as any,
    parentType: {} as any,
    path: { key: "test", typename: "Test" } as any,
    schema: {} as any,
    fragments: {},
    rootValue: {},
    operation: { kind: "OperationDefinition", operation: "query" } as any,
    variableValues: {},
  },
  ...overrides,
});

describe("GraphQLAuthGuard", () => {
  beforeEach(() => {
    MetadataStorage.clear();
  });

  it("should resolve configured auth options through the DI token", async () => {
    Container.reset();
    Container.register(GraphQLAuthGuard, "singleton");
    const user = { id: "configured-user" };
    const verifier = vi.fn().mockResolvedValue(user);
    Container.set(GRAPHQL_AUTH_GUARD_OPTIONS, {
      verifier,
      headerName: "x-auth",
      scheme: "Token",
    });

    try {
      const guard = Container.get(GraphQLAuthGuard);
      const context = createMockContext({ context: { headers: { "x-auth": "Token configured" } } });
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(verifier).toHaveBeenCalledWith("configured");
      expect(context.context.user).toBe(user);
    } finally {
      Container.reset();
    }
  });

  it("should fail DI resolution explicitly when auth options are not registered", () => {
    Container.reset();
    Container.register(GraphQLAuthGuard, "singleton");
    expect(() => Container.get(GraphQLAuthGuard)).toThrow(/GRAPHQL_AUTH_GUARD_OPTIONS/);
  });

  it("should throw error when authorization header is missing", async () => {
    const guard = new GraphQLAuthGuard({
      verifier: (token) => ({ id: "1", token }),
    });

    const context = createMockContext({
      context: { headers: {} },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(Problem);
    await expect(guard.canActivate(context)).rejects.toThrow("Missing authorization header");
    await expect(guard.canActivate(context)).rejects.toMatchObject(
      authGuardConformance.graphql.missingCredentials,
    );
  });

  it("should throw error when request context headers are unavailable", async () => {
    const guard = new GraphQLAuthGuard({
      verifier: (token) => ({ id: "1", token }),
    });

    await expect(guard.canActivate(createMockContext())).rejects.toMatchObject({
      status: 400,
      code: "protocols-graphql/auth-invalid-request",
    });
  });

  it("should throw error when token format is invalid", async () => {
    const guard = new GraphQLAuthGuard({
      verifier: (token) => ({ id: "1", token }),
    });

    const context = createMockContext({
      context: { headers: { authorization: authGuardConformance.headers.malformedAuthorization } },
    });

    await expect(guard.canActivate(context)).rejects.toThrow("Invalid authorization header format");
    await expect(guard.canActivate(context)).rejects.toMatchObject(
      authGuardConformance.graphql.malformedCredentials,
    );
  });

  it("should throw error when token verification fails", async () => {
    const tokenError = Object.assign(new Error("Token expired"), { name: "ERR_JWT_EXPIRED" });
    const guard = new GraphQLAuthGuard({
      verifier: vi.fn().mockRejectedValue(tokenError),
    });

    const context = createMockContext({
      context: { headers: { authorization: authGuardConformance.headers.invalidAuthorization } },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject(
      authGuardConformance.graphql.invalidCredentials,
    );
  });

  it("should surface verifier outages separately from invalid tokens", async () => {
    const guard = new GraphQLAuthGuard({
      verifier: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    });

    const context = createMockContext({
      context: {
        headers: { authorization: authGuardConformance.headers.verifierUnavailableAuthorization },
      },
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject(
      authGuardConformance.graphql.verifierUnavailable,
    );
  });

  it("should preserve verifier-thrown Problems", async () => {
    const policyProblem = ProblemFactory.forbidden(
      authGuardConformance.preservedProblem.policyDenied.code,
      "Access denied",
    );
    const verifier = vi.fn().mockRejectedValue(policyProblem);
    const guard = new GraphQLAuthGuard({ verifier });

    const context = createMockContext({
      context: { headers: { authorization: authGuardConformance.headers.validAuthorization } },
    });

    await expect(guard.canActivate(context)).rejects.toBe(policyProblem);
    expect(policyProblem).toMatchObject(authGuardConformance.preservedProblem.policyDenied);
    expect(verifier).toHaveBeenCalledWith(authGuardConformance.tokens.valid);
  });

  it("should set conformance user metadata on context when token is valid", async () => {
    const mockUser = createConformanceProtocolUser();
    const guard = new GraphQLAuthGuard({
      verifier: () => mockUser,
    });

    const ctx: { headers: Record<string, string>; user?: unknown } = {
      headers: { authorization: authGuardConformance.headers.validAuthorization },
    };

    const context = createMockContext({
      context: ctx,
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(ctx.user).toBe(mockUser);
    expect(ctx.user).toMatchObject({
      id: authGuardConformance.subject.id,
      roles: [...authGuardConformance.subject.roles],
      scopes: [...authGuardConformance.subject.scopes],
      tenantId: authGuardConformance.subject.tenantId,
    });
  });
});

describe("GraphQLRolesGuard", () => {
  beforeEach(() => {
    MetadataStorage.clear();
  });

  it.each([undefined, null, "root", 0, false, BigInt(1), Symbol("root")])(
    "should deny access without throwing when root is %s",
    (root) => {
      const guard = new GraphQLRolesGuard();

      expect(guard.canActivate(createMockContext({ root }))).toBe(false);
    },
  );

  it("should reject a missing target through the guard interceptor before invoking the resolver", async () => {
    const interceptor = new GuardInterceptor([new GraphQLRolesGuard()]);
    const next = { handle: vi.fn().mockResolvedValue("protected") };

    await expect(
      interceptor.intercept(createMockContext({ root: undefined }), next),
    ).rejects.toBeInstanceOf(GuardDeniedProblem);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it.each([
    { roles: ["admin"], allowed: true },
    { roles: ["user"], allowed: false },
    { roles: [], allowed: false },
  ])("should enforce explicit resolver roles for $roles", ({ roles, allowed }) => {
    class TestResolver {
      testMethod() {}
    }
    Reflect.defineMetadata(GRAPHQL_ROLES_KEY, ["admin"], TestResolver.prototype, "testMethod");
    const guard = new GraphQLRolesGuard(new TestResolver(), "testMethod");

    for (const root of [undefined, null, "root", {}]) {
      expect(guard.canActivate(createMockContext({ root, context: { user: { roles } } }))).toBe(
        allowed,
      );
    }
  });

  it("should enforce metadata on function roots", () => {
    const resolver = () => {};
    Reflect.defineMetadata(GRAPHQL_ROLES_KEY, ["admin"], resolver, "test");
    const guard = new GraphQLRolesGuard();

    expect(guard.canActivate(createMockContext({ root: resolver }))).toBe(false);
    expect(
      guard.canActivate(
        createMockContext({ root: resolver, context: { user: { roles: ["admin"] } } }),
      ),
    ).toBe(true);
  });

  it("should allow access when no roles are required", () => {
    const guard = new GraphQLRolesGuard();

    const resolver = {};
    const context = createMockContext({
      root: resolver,
      context: { user: { roles: ["admin"] } },
    });

    const result = guard.canActivate(context);
    expect(result).toBe(true);
  });

  it("should allow access when user has required role", () => {
    const guard = new GraphQLRolesGuard();

    class TestResolver {
      testMethod() {}
    }
    const resolver = new TestResolver();

    Reflect.defineMetadata(GRAPHQL_ROLES_KEY, ["admin"], TestResolver.prototype, "testMethod");

    const context = createMockContext({
      root: resolver,
      context: { user: { roles: ["admin", "user"] } as UserWithRoles },
      info: {
        fieldName: "testMethod",
        fieldNodes: [],
        returnType: {} as any,
        parentType: {} as any,
        path: { key: "testMethod", typename: "Test" } as any,
        schema: {} as any,
        fragments: {},
        rootValue: {},
        operation: { kind: "OperationDefinition", operation: "query" } as any,
        variableValues: {},
      },
    });

    const result = guard.canActivate(context);
    expect(result).toBe(true);
  });

  it("should deny access when user lacks required role", () => {
    const guard = new GraphQLRolesGuard();

    class TestResolver {
      testMethod() {}
    }
    const resolver = new TestResolver();

    Reflect.defineMetadata(GRAPHQL_ROLES_KEY, ["admin"], TestResolver.prototype, "testMethod");

    const context = createMockContext({
      root: resolver,
      context: { user: { roles: ["user"] } as UserWithRoles },
      info: {
        fieldName: "testMethod",
        fieldNodes: [],
        returnType: {} as any,
        parentType: {} as any,
        path: { key: "testMethod", typename: "Test" } as any,
        schema: {} as any,
        fragments: {},
        rootValue: {},
        operation: { kind: "OperationDefinition", operation: "query" } as any,
        variableValues: {},
      },
    });

    const result = guard.canActivate(context);
    expect(result).toBe(false);
  });
});

describe("GuardChain", () => {
  it("should return true when all guards pass", async () => {
    const guard1 = { canActivate: vi.fn().mockResolvedValue(true) };
    const guard2 = { canActivate: vi.fn().mockResolvedValue(true) };

    const chain = new GuardChain([guard1, guard2]);
    const context = createMockContext();

    const result = await chain.canActivate(context);

    expect(result).toBe(true);
    expect(guard1.canActivate).toHaveBeenCalledWith(context);
    expect(guard2.canActivate).toHaveBeenCalledWith(context);
  });

  it("should return false when any guard fails", async () => {
    const guard1 = { canActivate: vi.fn().mockResolvedValue(true) };
    const guard2 = { canActivate: vi.fn().mockResolvedValue(false) };
    const guard3 = { canActivate: vi.fn() };

    const chain = new GuardChain([guard1, guard2, guard3]);
    const context = createMockContext();

    const result = await chain.canActivate(context);

    expect(result).toBe(false);
    expect(guard1.canActivate).toHaveBeenCalledWith(context);
    expect(guard2.canActivate).toHaveBeenCalledWith(context);
    expect(guard3.canActivate).not.toHaveBeenCalled();
  });

  it("should execute static method", async () => {
    const guard = { canActivate: vi.fn().mockResolvedValue(true) };
    const context = createMockContext();

    const result = await GuardChain.execute([guard], context);

    expect(result).toBe(true);
  });
});
