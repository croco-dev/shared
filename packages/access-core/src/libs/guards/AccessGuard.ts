import "reflect-metadata";
import { Context } from "@croco/framework-context";
import { Problem, ProblemCategory } from "@croco/problems-core";
import type { AccessEngine } from "../AccessEngine";
import { ACCESS_METADATA_KEY } from "../constants";
import type { AccessExecutionContext, Guard } from "../interfaces/Guard";
import type { AccessRuleMetadata, ResourceObject } from "../types";

export class BadRequestProblem extends Problem {
  constructor(detail = "Bad request") {
    super("BAD_REQUEST", ProblemCategory.BadRequest, detail);
  }
}

class UnauthorizedProblem extends Problem {
  constructor(detail: string) {
    super("access-core/unauthorized", ProblemCategory.Unauthorized, detail);
  }
}

export class ForbiddenProblem extends Problem {
  constructor(detail = "Forbidden", decisionId?: string) {
    super(
      "access-core/forbidden",
      ProblemCategory.Forbidden,
      detail,
      decisionId ? { extensions: { decisionId } } : undefined,
    );
  }
}

interface RequestWithUser {
  user?: { id: string };
}

interface RequestWithTenantId {
  tenantId?: string;
}

interface RequestWithParams {
  params?: Record<string, string>;
}

type RequestWithAccessData = RequestWithUser & RequestWithTenantId & RequestWithParams;

interface CrocoHttpContextLike {
  req: {
    params: Record<string, string>;
  };
  param(name: string): string | undefined;
  get<T>(key: string): T | undefined;
}

export class AccessGuard implements Guard<AccessExecutionContext> {
  constructor(private accessEngine: AccessEngine) {}

  async canActivate(context: AccessExecutionContext): Promise<boolean> {
    const target = context.getClass();
    const handler = context.getHandler();

    const metadata = Reflect.getMetadata(ACCESS_METADATA_KEY, target, handler) as
      | AccessRuleMetadata
      | undefined;

    if (!metadata) {
      return true;
    }

    const request = context.getRequest() as Request;
    const user = this.resolveUser(request);
    if (!user) {
      throw new UnauthorizedProblem("Authenticated user missing");
    }

    const tenantId = this.resolveTenantId(context, request);
    if (!tenantId) {
      throw new BadRequestProblem("Tenant ID missing");
    }

    const objectId = this.resolveObjectId(context, request, metadata.objectType);

    if (!objectId) {
      throw new BadRequestProblem("Object ID missing");
    }

    const result = await this.accessEngine.check({
      tenantId,
      subject: `user:${user.id}`,
      relation: metadata.relation,
      object: objectId,
      ruleId: metadata.ruleId,
      sourceLocation: metadata.sourceLocation,
    });

    if (result.decision !== "allow") {
      throw new ForbiddenProblem(`Access denied to ${objectId}`, result.trace?.decisionId);
    }

    return true;
  }

  private resolveUser(request: Request): { id: string } | null {
    const accessRequest = request as unknown as RequestWithAccessData;
    const user = accessRequest.user ?? Context.getCurrentUser();

    if (!user || typeof user.id !== "string") {
      return null;
    }

    return { id: user.id };
  }

  private resolveTenantId(context: AccessExecutionContext, request: Request): string | null {
    const accessRequest = request as unknown as RequestWithAccessData;

    if (typeof accessRequest.tenantId === "string" && accessRequest.tenantId.length > 0) {
      return accessRequest.tenantId;
    }

    const httpContext = this.getHttpContext(context);
    if (httpContext) {
      const contextTenantId = httpContext.get<string>("tenantId");
      if (typeof contextTenantId === "string" && contextTenantId.length > 0) {
        return contextTenantId;
      }
    }

    const currentTenantId = Context.getTenantId();
    if (typeof currentTenantId === "string" && currentTenantId.length > 0) {
      return currentTenantId;
    }

    return null;
  }

  private resolveObjectId(
    context: AccessExecutionContext,
    request: Request,
    objectType: string,
  ): ResourceObject | undefined {
    const accessRequest = request as unknown as RequestWithAccessData;
    const params = accessRequest.params ?? this.getHttpContext(context)?.req.params;

    const objectTypeIdKey = `${objectType}Id`;
    const byParams = params?.id ?? params?.[objectTypeIdKey];
    if (typeof byParams === "string" && byParams.length > 0) {
      return `${objectType}:${byParams}`;
    }

    const httpContext = this.getHttpContext(context);
    if (!httpContext) {
      return undefined;
    }

    const paramValue = httpContext.param("id") ?? httpContext.param(objectTypeIdKey);
    if (typeof paramValue === "string" && paramValue.length > 0) {
      return `${objectType}:${paramValue}`;
    }

    return undefined;
  }

  private getHttpContext(context: AccessExecutionContext): CrocoHttpContextLike | null {
    if (typeof context.getHttpContext !== "function") {
      return null;
    }

    return context.getHttpContext();
  }
}
