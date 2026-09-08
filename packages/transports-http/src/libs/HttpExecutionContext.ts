import type { Constructor, ExecutionContext } from "@croco/protocols-rest";
import type { CrocoHttpContext } from "./types";

type ContextRequest = Request & {
  params?: Record<string, string>;
  tenantId?: string;
};

/**
 * Guard, Interceptor, Filter가 사용할 REST 실행 컨텍스트 구현체입니다.
 */
export class HttpExecutionContext implements ExecutionContext {
  constructor(
    private readonly ctx: CrocoHttpContext,
    private readonly controllerClass: Constructor,
    private readonly handlerName: string | symbol,
  ) {}

  getRequest(): Request {
    const request = this.ctx.raw.req.raw as ContextRequest;
    request.params = this.ctx.req.params;

    const contextTenantId = this.ctx.get<string>("tenantId");
    if (
      !(typeof request.tenantId === "string" && request.tenantId.length > 0) &&
      typeof contextTenantId === "string" &&
      contextTenantId.length > 0
    ) {
      request.tenantId = contextTenantId;
    }

    return request;
  }

  getClass(): Constructor {
    return this.controllerClass;
  }

  getHandler(): string | symbol {
    return this.handlerName;
  }

  getPath(): string {
    return this.ctx.req.path;
  }

  getMethod(): string {
    return this.ctx.req.method;
  }

  get<T>(key: string): T | undefined {
    return this.ctx.get<T>(key);
  }

  set<T>(key: string, value: T): void {
    this.ctx.set(key, value);
  }

  getHttpContext(): CrocoHttpContext {
    return this.ctx;
  }
}
