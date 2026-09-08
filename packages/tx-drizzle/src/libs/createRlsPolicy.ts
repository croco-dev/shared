import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { qualifiedIdentifier, validateRlsPolicyOptions } from "./RlsSql";

export interface RlsPolicyOptions {
  tableName: string;
  tenantColumn?: string;
  tenantColumnType?: "uuid" | "text";
  configKey?: string;
  adminRoles?: string[];
}
export function createRlsPolicy(options: RlsPolicyOptions): string {
  const {
    tableName,
    tenantColumn = "tenant_id",
    tenantColumnType = "uuid",
    configKey = "app.current_tenant",
    adminRoles = ["app_admin"],
  } = options;

  const validated = validateRlsPolicyOptions({
    adminRoles,
    configKey,
    tableName,
    tenantColumn,
    tenantColumnType,
  });
  const tableIdentifier = qualifiedIdentifier(validated.tableName);
  const adminPredicates = validated.adminRoles.map(
    (role) => sql`pg_has_role(current_user, ${role}, 'member')`,
  );
  const adminCheck =
    adminPredicates.length > 0
      ? sql`${sql.raw("\n        OR ")}${sql.join(adminPredicates, sql.raw("\n        OR "))}`
      : sql.empty();
  const tenantCast = tenantColumnType === "uuid" ? sql`::uuid` : sql.empty();
  const policy = sql`ALTER TABLE ${tableIdentifier} ENABLE ROW LEVEL SECURITY;

CREATE POLICY ${sql.identifier(validated.policyName)} ON ${tableIdentifier}
  AS RESTRICTIVE
  FOR ALL
  USING (
    ${sql.identifier(validated.tenantColumn)} = current_setting(${validated.configKey}, true)${tenantCast}${adminCheck}
  );`;

  return new PgDialect().sqlToQuery(policy.inlineParams()).sql;
}
