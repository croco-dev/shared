import { describe, expect, it } from "vitest";
import { RlsConfigurationProblem } from "../libs/problems/TxDrizzleProblems";
import { createRlsPolicy } from "../libs/createRlsPolicy";

describe("createRlsPolicy", () => {
  it("should generate default PostgreSQL RLS policy SQL", () => {
    const sql = createRlsPolicy({ tableName: "users" });

    expect(sql).toContain('ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;');
    expect(sql).toContain('CREATE POLICY "users_tenant_isolation" ON "users"');
    expect(sql).toContain("\"tenant_id\" = current_setting('app.current_tenant', true)::uuid");
    expect(sql).toContain("OR pg_has_role(current_user, 'app_admin', 'member')");
  });

  it.each(["uuid", "text"] as const)(
    "should honor explicit %s tenant columns",
    (tenantColumnType) => {
      const policySql = createRlsPolicy({
        tableName: "orders",
        tenantColumnType,
        adminRoles: [],
      });

      expect(policySql).toContain(
        "\"tenant_id\" = current_setting('app.current_tenant', true)" +
          (tenantColumnType === "uuid" ? "::uuid" : "") +
          "\n  );",
      );
      if (tenantColumnType === "text") {
        expect(policySql).not.toContain("::uuid");
      }
    },
  );

  it.each(["varchar", "text); DROP TABLE orders; --", "", null])(
    "should reject unsupported tenant column type %s",
    (tenantColumnType) => {
      expect.assertions(2);
      try {
        createRlsPolicy({
          tableName: "orders",
          // @ts-expect-error Exercise callers without TypeScript validation.
          tenantColumnType,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(RlsConfigurationProblem);
        expect(error).toMatchObject({
          detail: "Invalid RLS configuration field: tenantColumnType",
          extensions: { field: "tenantColumnType", retryable: false },
        });
      }
    },
  );

  it("should honor custom tenant column, config key, and admin roles", () => {
    const sql = createRlsPolicy({
      tableName: "orders",
      tenantColumn: "workspace_id",
      configKey: "app.current_workspace",
      adminRoles: ["ops_admin", "support_admin"],
    });

    expect(sql).toContain(
      "\"workspace_id\" = current_setting('app.current_workspace', true)::uuid",
    );
    expect(sql).toContain("OR pg_has_role(current_user, 'ops_admin', 'member')");
    expect(sql).toContain("OR pg_has_role(current_user, 'support_admin', 'member')");
  });

  it("should omit admin bypass when no admin roles are provided", () => {
    const sql = createRlsPolicy({
      tableName: "projects",
      adminRoles: [],
    });

    expect(sql).not.toContain("pg_has_role");
  });

  it("should quote qualified, mixed-case, and reserved identifiers by component", () => {
    const policySql = createRlsPolicy({
      tableName: "Tenant.Order",
      tenantColumn: "select",
      configKey: "app.CurrentTenant",
      adminRoles: ["SupportAdmin"],
    });

    expect(policySql).toContain('ALTER TABLE "Tenant"."Order" ENABLE ROW LEVEL SECURITY;');
    expect(policySql).toContain('CREATE POLICY "Order_tenant_isolation" ON "Tenant"."Order"');
    expect(policySql).toContain("\"select\" = current_setting('app.CurrentTenant', true)::uuid");
    expect(policySql).toContain("pg_has_role(current_user, 'SupportAdmin', 'member')");
  });

  it("should accept identifiers at the documented byte boundaries", () => {
    const schema = "s".repeat(63);
    const table = "t".repeat(46);
    const policySql = createRlsPolicy({
      tableName: `${schema}.${table}`,
      tenantColumn: "c".repeat(63),
      configKey: `${"n".repeat(63)}.${"k".repeat(63)}`,
      adminRoles: ["r".repeat(63)],
    });

    expect(policySql).toContain(`ALTER TABLE "${schema}"."${table}"`);
    expect(policySql).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
  });

  it.each([
    ["tableName", { tableName: "" }, ""],
    ["tableName", { tableName: " public.users" }, " public.users"],
    ["tableName", { tableName: "public..users" }, "public..users"],
    ["tableName", { tableName: "catalog.public.users" }, "catalog.public.users"],
    ["tableName", { tableName: '"users"' }, '"users"'],
    ["tableName", { tableName: "a".repeat(47) }, "a".repeat(47)],
    ["tableName", { tableName: "a".repeat(64) }, "a".repeat(64)],
    ["tenantColumn", { tableName: "users", tenantColumn: "tenant-id" }, "tenant-id"],
    ["tenantColumn", { tableName: "users", tenantColumn: "a".repeat(64) }, "a".repeat(64)],
    ["configKey", { tableName: "users", configKey: "app" }, "app"],
    ["configKey", { tableName: "users", configKey: "app.current.tenant" }, "app.current.tenant"],
    ["configKey", { tableName: "users", configKey: `app.${"a".repeat(64)}` }, "a".repeat(64)],
    ["adminRoles", { tableName: "users", adminRoles: [""] }, ""],
    ["adminRoles", { tableName: "users", adminRoles: ["support admin"] }, "support admin"],
    ["adminRoles", { tableName: "users", adminRoles: ["a".repeat(64)] }, "a".repeat(64)],
  ])("should reject invalid %s without exposing its value", (field, options, rejectedValue) => {
    try {
      createRlsPolicy(options);
      throw new Error("Expected createRlsPolicy to reject invalid RLS configuration");
    } catch (error) {
      expect(error).toBeInstanceOf(RlsConfigurationProblem);
      expect(error).toMatchObject({
        code: "tx-drizzle/rls-configuration-invalid",
        detail: `Invalid RLS configuration field: ${field}`,
        extensions: { field, retryable: false },
      });
      if (rejectedValue.length > 0) {
        expect((error as RlsConfigurationProblem).detail).not.toContain(rejectedValue);
      }
    }
  });
});
