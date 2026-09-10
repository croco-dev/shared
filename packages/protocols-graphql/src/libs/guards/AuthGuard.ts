import { Inject, Token } from "@croco/framework-context";
import type { Guard } from "@croco/framework-context";
import { Problem, ProblemFactory } from "@croco/problems-core";
import type { GraphQLGuardContext } from "../types/GuardTypes";

export type TokenVerifier = (token: string) => Promise<unknown> | unknown;

export type AuthGuardOptions = {
  verifier: TokenVerifier;
  headerName?: string;
  scheme?: string;
};

export const GRAPHQL_AUTH_GUARD_OPTIONS = new Token<AuthGuardOptions>("GRAPHQL_AUTH_GUARD_OPTIONS");

function invalidTokenProblem(): Problem {
  return ProblemFactory.unauthorized(
    "protocols-graphql/auth-invalid-token",
    "Invalid or expired token",
  );
}

function isTokenVerificationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const name = error.name.toUpperCase();
  const message = error.message.toLowerCase();

  return (
    name.startsWith("ERR_JWT_") ||
    name.startsWith("ERR_JWS_") ||
    name.startsWith("ERR_JWE_") ||
    message.includes("token expired") ||
    message.includes("invalid token") ||
    message.includes("jwt expired") ||
    message.includes("token invalid")
  );
}

export class GraphQLAuthGuard implements Guard<GraphQLGuardContext> {
  private readonly verifier: TokenVerifier;
  private readonly headerName: string;
  private readonly scheme: string;

  constructor(@Inject(GRAPHQL_AUTH_GUARD_OPTIONS) options: AuthGuardOptions) {
    this.verifier = options.verifier;
    this.headerName = options.headerName ?? "authorization";
    this.scheme = options.scheme ?? "Bearer";
  }

  async canActivate(context: GraphQLGuardContext): Promise<boolean> {
    const headers = (context.context as { headers?: Record<string, string> }).headers;

    if (!headers) {
      throw ProblemFactory.badRequest(
        "protocols-graphql/auth-invalid-request",
        "Invalid request context",
      );
    }

    const authHeader = this.getHeaderValue(headers, this.headerName);

    if (!authHeader) {
      throw ProblemFactory.unauthorized(
        "protocols-graphql/auth-missing-header",
        "Missing authorization header",
      );
    }

    const token = this.extractToken(authHeader);
    if (!token) {
      throw ProblemFactory.badRequest(
        "protocols-graphql/auth-invalid-header-format",
        "Invalid authorization header format",
      );
    }

    try {
      const user = await this.verifier(token);

      if (!user) {
        throw invalidTokenProblem();
      }

      const ctx = context.context as { user?: unknown };
      ctx.user = user;

      return true;
    } catch (error) {
      if (error instanceof Problem) {
        throw error;
      }

      if (isTokenVerificationError(error)) {
        throw invalidTokenProblem();
      }

      throw ProblemFactory.internalServerError(
        "protocols-graphql/auth-verifier-unavailable",
        "Authentication verifier is unavailable",
      );
    }
  }

  private extractToken(header: string): string | null {
    const parts = header.split(" ");
    if (parts.length !== 2) {
      return null;
    }

    const [scheme, token] = parts;
    if (scheme.toLowerCase() !== this.scheme.toLowerCase()) {
      return null;
    }

    if (!token) {
      return null;
    }

    return token;
  }

  private getHeaderValue(headers: Record<string, string>, headerName: string): string | undefined {
    const direct = headers[headerName];

    if (typeof direct === "string") {
      return direct;
    }

    const normalizedHeaderName = headerName.toLowerCase();

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === normalizedHeaderName) {
        return value;
      }
    }

    return undefined;
  }
}
