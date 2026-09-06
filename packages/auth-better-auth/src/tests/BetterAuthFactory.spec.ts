import "reflect-metadata";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetterAuthFactory, DRIZZLE_TOKEN } from "../libs/BetterAuthFactory";
import * as schema from "../libs/schema";

vi.mock("better-auth", () => ({
  betterAuth: vi.fn(),
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: vi.fn(),
}));

describe("BetterAuthFactory", () => {
  let mockDb!: any;
  let config!: { baseURL: string; secret: string };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    config = {
      baseURL: "http://localhost:3000",
      secret: "test-secret-key",
    };
  });

  describe("constructor", () => {
    it("should defer betterAuth creation until getAuth is called", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory = new BetterAuthFactory(mockDb, config);

      expect(betterAuth).not.toHaveBeenCalled();
      expect(drizzleAdapter).not.toHaveBeenCalled();

      factory.getAuth();

      expect(betterAuth).toHaveBeenCalledWith({
        database: expect.any(Object),
        baseURL: "http://localhost:3000",
        secret: "test-secret-key",
        plugins: [
          expect.objectContaining({ id: "bearer" }),
          expect.objectContaining({
            id: "admin",
            schema: expect.objectContaining({
              user: expect.objectContaining({
                fields: expect.objectContaining({
                  role: expect.objectContaining({ input: false }),
                }),
              }),
            }),
          }),
        ],
      });

      expect(drizzleAdapter).toHaveBeenCalledWith(mockDb, {
        provider: "pg",
        schema: schema,
      });
    });

    it("should accept custom baseURL and secret", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const customConfig = {
        baseURL: "https://api.example.com",
        secret: "production-secret",
      };

      const factory = new BetterAuthFactory(mockDb, customConfig);

      factory.getAuth();

      expect(betterAuth).toHaveBeenCalledWith({
        database: expect.any(Object),
        baseURL: "https://api.example.com",
        secret: "production-secret",
        plugins: [
          expect.objectContaining({ id: "bearer" }),
          expect.objectContaining({ id: "admin" }),
        ],
      });
    });

    it("should store auth instance", () => {
      const mockAuthInstance = { api: { getSession: vi.fn() } };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory = new BetterAuthFactory(mockDb, config);

      expect(factory.getAuth()).toBe(mockAuthInstance);
    });
  });

  describe("getAuth", () => {
    it("should return the auth instance", () => {
      const mockAuthInstance = {
        api: {
          getSession: vi.fn(),
          signIn: vi.fn(),
          signOut: vi.fn(),
        },
      };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory = new BetterAuthFactory(mockDb, config);

      const auth = factory.getAuth();

      expect(auth).not.toBeUndefined();
      expect(auth).toBe(mockAuthInstance);
      expect(auth.api).not.toBeUndefined();
    });

    it("should return same auth instance on multiple calls", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory = new BetterAuthFactory(mockDb, config);

      const auth1 = factory.getAuth();
      const auth2 = factory.getAuth();

      expect(auth1).toBe(auth2);
    });
  });

  describe("DRIZZLE_TOKEN", () => {
    it("should export DRIZZLE_TOKEN constant", () => {
      expect(DRIZZLE_TOKEN).toBe("DRIZZLE_TOKEN");
    });

    it("should be usable for DI injection", () => {
      expect(typeof DRIZZLE_TOKEN).toBe("string");
    });
  });

  describe("schema integration", () => {
    it("should pass schema to drizzle adapter", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory = new BetterAuthFactory(mockDb, config);

      factory.getAuth();

      expect(drizzleAdapter).toHaveBeenCalledWith(mockDb, {
        provider: "pg",
        schema: schema,
      });
    });

    it("should export required schema tables", () => {
      expect(schema.user).not.toBeUndefined();
      expect(schema.session).not.toBeUndefined();
      expect(schema.account).not.toBeUndefined();
      expect(schema.verification).not.toBeUndefined();
    });

    it("should expose the fields required by the admin plugin", () => {
      expect(schema.user.role).not.toBeUndefined();
      expect(schema.user.banned).not.toBeUndefined();
      expect(schema.user.banReason).not.toBeUndefined();
      expect(schema.user.banExpires).not.toBeUndefined();
      expect(schema.session.impersonatedBy).not.toBeUndefined();
    });
  });

  describe("configuration validation", () => {
    it("should handle empty baseURL", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const emptyConfig = {
        baseURL: "",
        secret: "test-secret",
      };

      const factory = new BetterAuthFactory(mockDb, emptyConfig);

      expect(() => factory.getAuth()).not.toThrow();
    });

    it("should handle empty secret", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const emptySecretConfig = {
        baseURL: "http://localhost:3000",
        secret: "",
      };

      const factory = new BetterAuthFactory(mockDb, emptySecretConfig);

      expect(() => factory.getAuth()).not.toThrow();
    });

    it("should handle special characters in secret", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const specialCharConfig = {
        baseURL: "http://localhost:3000",
        secret: "secret-with-!@#$%^&*()_+-=[]{}|;:,.<>?/",
      };

      const factory = new BetterAuthFactory(mockDb, specialCharConfig);

      expect(() => factory.getAuth()).not.toThrow();
    });
  });

  describe("factory pattern", () => {
    it("should create independent auth instances", () => {
      const mockAuthInstance1 = { api: {}, id: 1 };
      const mockAuthInstance2 = { api: {}, id: 2 };

      vi.mocked(betterAuth)
        .mockReturnValueOnce(mockAuthInstance1 as unknown as ReturnType<typeof betterAuth>)
        .mockReturnValueOnce(mockAuthInstance2 as unknown as ReturnType<typeof betterAuth>);
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory1 = new BetterAuthFactory(mockDb, config);
      const factory2 = new BetterAuthFactory(mockDb, config);

      expect(factory1.getAuth()).not.toBe(factory2.getAuth());
    });

    it("should handle factory reuse pattern", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const factory = new BetterAuthFactory(mockDb, config);

      const auth1 = factory.getAuth();
      const auth2 = factory.getAuth();

      expect(betterAuth).toHaveBeenCalledTimes(1);
      expect(auth1).toBe(auth2);
    });
  });

  describe("integration scenarios", () => {
    it("should support multiple database instances", () => {
      const mockAuthInstance = { api: {} };
      vi.mocked(betterAuth).mockReturnValue(
        mockAuthInstance as unknown as ReturnType<typeof betterAuth>,
      );
      vi.mocked(drizzleAdapter).mockReturnValue({} as unknown as ReturnType<typeof drizzleAdapter>);

      const db1 = { ...mockDb, name: "db1" };
      const db2 = { ...mockDb, name: "db2" };

      const factory1 = new BetterAuthFactory(db1, config);
      const factory2 = new BetterAuthFactory(db2, config);

      factory1.getAuth();
      factory2.getAuth();

      expect(drizzleAdapter).toHaveBeenCalledTimes(2);
      expect(drizzleAdapter).toHaveBeenNthCalledWith(1, db1, expect.any(Object));
      expect(drizzleAdapter).toHaveBeenNthCalledWith(2, db2, expect.any(Object));
    });
  });

  describe("error handling", () => {
    it("should propagate errors from betterAuth", () => {
      vi.mocked(betterAuth).mockImplementation(() => {
        throw new Error("Invalid configuration");
      });

      const factory = new BetterAuthFactory(mockDb, config);

      expect(() => factory.getAuth()).toThrow("Invalid configuration");
    });

    it("should propagate errors from drizzleAdapter", () => {
      vi.mocked(betterAuth).mockReturnValue({ api: {} } as unknown as ReturnType<
        typeof betterAuth
      >);
      vi.mocked(drizzleAdapter).mockImplementation(() => {
        throw new Error("Invalid database schema");
      });

      const factory = new BetterAuthFactory(mockDb, config);

      expect(() => factory.getAuth()).toThrow("Invalid database schema");
    });
  });
});
