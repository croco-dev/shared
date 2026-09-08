import type { AuthProvider, AuthUser } from "@croco/auth-core";
import type { ILogger } from "@croco/framework-context";
import { Component } from "@croco/framework-context";
// Runtime value required for constructor metadata.
// oxlint-disable-next-line typescript/consistent-type-imports
import { BetterAuthFactory } from "./BetterAuthFactory";
import { BetterAuthAuthenticationProblem } from "./problems/BetterAuthAuthenticationProblem";
import { BetterAuthInvalidSessionProblem } from "./problems/BetterAuthInvalidSessionProblem";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function mergeStringArrays(...values: unknown[]): string[] {
  const merged = new Set<string>();

  for (const value of values) {
    for (const item of toStringArray(value)) {
      merged.add(item);
    }
  }

  return [...merged];
}

const AUTHORIZATION_CLAIMS = [
  "roles",
  "role",
  "permissions",
  "permission",
  "tenantId",
  "tenant_id",
  "orgId",
  "org_id",
  "organizationId",
  "organization_id",
] as const;

/** User fields that can supply authorization or tenant claims. */
export type BetterAuthClaimField = (typeof AUTHORIZATION_CLAIMS)[number];

/** Trust only fields whose writes are restricted to the server. */
export type BetterAuthProviderOptions = {
  /** Additional server-managed top-level claims. The admin plugin's `role` is always trusted. */
  readonly trustedUserFields?: readonly BetterAuthClaimField[];
  /** Server-managed nested objects, in precedence order. Defaults to none, including privateMetadata. */
  readonly trustedMetadataKeys?: readonly string[];
  /** Warning sink. Defaults to console.warn; claim values and user details are never logged. */
  readonly logger?: Pick<ILogger, "warn">;
};

function getOwnValue(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function getNestedValue(sources: readonly Record<string, unknown>[], key: string): unknown {
  for (const source of sources) {
    const value = getOwnValue(source, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function extractRoles(user: readonly Record<string, unknown>[]): string[] {
  return mergeStringArrays(getNestedValue(user, "roles"), getNestedValue(user, "role"));
}

function extractPermissions(user: readonly Record<string, unknown>[]): string[] {
  return mergeStringArrays(getNestedValue(user, "permissions"), getNestedValue(user, "permission"));
}

function extractString(
  user: readonly Record<string, unknown>[],
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = getNestedValue(user, key);
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

/**
 * Better Auth 세션을 읽어 Croco의 {@link AuthUser}로 변환하는 인증 제공자입니다.
 */
@Component()
export class BetterAuthProvider implements AuthProvider<Request> {
  private readonly trustedUserFields: ReadonlySet<string>;
  private readonly trustedMetadataKeys: readonly string[];
  private readonly logger: Pick<ILogger, "warn">;

  constructor(
    private readonly factory: BetterAuthFactory,
    options: BetterAuthProviderOptions = {},
  ) {
    this.trustedUserFields = new Set(["role", ...(options.trustedUserFields ?? [])]);
    this.trustedMetadataKeys = [...(options.trustedMetadataKeys ?? [])];
    this.logger = options.logger ?? console;
  }

  private authorizationSources(user: Record<string, unknown>): Record<string, unknown>[] {
    const directClaims = Object.fromEntries(
      AUTHORIZATION_CLAIMS.filter((claim) => this.trustedUserFields.has(claim)).map((claim) => [
        claim,
        getOwnValue(user, claim),
      ]),
    );
    const sources = [directClaims];
    for (const key of this.trustedMetadataKeys) {
      const source = getOwnValue(user, key);
      if (isRecord(source) && !Array.isArray(source)) {
        sources.push(source);
      }
    }

    const ignoredClaims = new Set<string>();
    for (const claim of AUTHORIZATION_CLAIMS) {
      if (Object.prototype.hasOwnProperty.call(user, claim) && !this.trustedUserFields.has(claim)) {
        ignoredClaims.add(claim);
      }
    }
    for (const [key, source] of Object.entries(user)) {
      if (this.trustedMetadataKeys.includes(key) || !isRecord(source) || Array.isArray(source)) {
        continue;
      }
      for (const claim of AUTHORIZATION_CLAIMS) {
        if (Object.prototype.hasOwnProperty.call(source, claim)) {
          ignoredClaims.add(claim);
        }
      }
    }
    if (ignoredClaims.size > 0) {
      this.logger.warn("Ignoring untrusted Better Auth authorization claims", {
        code: "auth-better-auth/untrusted-claims",
        claims: [...ignoredClaims],
      });
    }
    return sources;
  }

  async authenticate(request: Request): Promise<AuthUser | null> {
    const auth = this.factory.getAuth();

    let session: unknown;

    try {
      // better-auth's api.getSession expects headers.
      session = await auth.api.getSession({
        headers: request.headers,
      });
    } catch (error) {
      if (isInvalidAuthenticationError(error)) {
        return null;
      }

      throw new BetterAuthAuthenticationProblem("authenticate", error);
    }

    if (!session) {
      return null;
    }

    if (!isRecord(session)) {
      throw new BetterAuthInvalidSessionProblem();
    }

    const { user } = session;
    const userRecord = isRecord(user) ? user : null;

    if (!userRecord || typeof userRecord.id !== "string") {
      throw new BetterAuthInvalidSessionProblem();
    }

    const sources = this.authorizationSources(userRecord);
    const orgId = extractString(sources, "orgId", "org_id", "organizationId", "organization_id");
    const tenantId = extractString(sources, "tenantId", "tenant_id");

    return {
      id: userRecord.id,
      email: typeof userRecord.email === "string" ? userRecord.email : undefined,
      roles: extractRoles(sources),
      permissions: extractPermissions(sources),
      ...(tenantId !== undefined ? { tenantId } : orgId !== undefined ? { tenantId: orgId } : {}),
      metadata: {
        image: userRecord.image,
        emailVerified: userRecord.emailVerified,
        ...(orgId !== undefined ? { orgId } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
    };
  }
}

function isInvalidAuthenticationError(error: unknown): boolean {
  const statusCode = getNumericProperty(error, "statusCode") ?? getNumericProperty(error, "status");

  if (statusCode !== undefined) {
    return statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404;
  }

  const status = getStringProperty(error, "status");
  return (
    status === "UNAUTHORIZED" ||
    status === "FORBIDDEN" ||
    status === "NOT_FOUND" ||
    status === "BAD_REQUEST"
  );
}

function getNumericProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];
  return typeof property === "number" ? property : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];
  return typeof property === "string" ? property : undefined;
}
