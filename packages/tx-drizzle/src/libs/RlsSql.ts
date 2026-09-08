import { sql, type SQL } from "drizzle-orm";
import { RlsConfigurationProblem, type RlsConfigurationField } from "./problems/TxDrizzleProblems";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENTIFIER_BYTES = 63;
const POLICY_SUFFIX = "_tenant_isolation";

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateIdentifier(value: string, field: RlsConfigurationField): string {
  if (!IDENTIFIER_PATTERN.test(value) || utf8ByteLength(value) > MAX_IDENTIFIER_BYTES) {
    throw new RlsConfigurationProblem(field);
  }

  return value;
}

function validateQualifiedIdentifier(
  value: string,
  field: RlsConfigurationField,
  componentCount: readonly number[],
): string[] {
  const components = value.split(".");
  if (!componentCount.includes(components.length)) {
    throw new RlsConfigurationProblem(field);
  }

  return components.map((component) => validateIdentifier(component, field));
}

export type ValidatedRlsPolicyOptions = {
  readonly adminRoles: readonly string[];
  readonly configKey: string;
  readonly policyName: string;
  readonly tableName: readonly string[];
  readonly tenantColumn: string;
};

export function validateRlsConfigKey(configKey: string): string {
  validateQualifiedIdentifier(configKey, "configKey", [2]);
  return configKey;
}

export function validateRlsPolicyOptions(options: {
  readonly adminRoles: readonly string[];
  readonly configKey: string;
  readonly tableName: string;
  readonly tenantColumn: string;
  readonly tenantColumnType: "uuid" | "text";
}): ValidatedRlsPolicyOptions {
  if (options.tenantColumnType !== "uuid" && options.tenantColumnType !== "text") {
    throw new RlsConfigurationProblem("tenantColumnType");
  }

  const tableName = validateQualifiedIdentifier(options.tableName, "tableName", [1, 2]);
  const finalTableName = tableName.at(-1);
  if (!finalTableName) {
    throw new RlsConfigurationProblem("tableName");
  }

  const policyName = validateIdentifier(`${finalTableName}${POLICY_SUFFIX}`, "tableName");
  const tenantColumn = validateIdentifier(options.tenantColumn, "tenantColumn");
  const configKey = validateRlsConfigKey(options.configKey);
  const adminRoles = options.adminRoles.map((role) => validateIdentifier(role, "adminRoles"));

  return { adminRoles, configKey, policyName, tableName, tenantColumn };
}

export function qualifiedIdentifier(components: readonly string[]): SQL {
  return sql.join(
    components.map((component) => sql.identifier(component)),
    sql.raw("."),
  );
}
