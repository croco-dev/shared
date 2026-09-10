import { ProblemFactory } from "@croco/problems-core";
import {
  getHttpParamFallbackSchema,
  getZodArrayInputSchema,
  getZodInputObjectSchema,
  getZodQueryInputSchema,
  isZodArraySchema,
  isZodType,
} from "@croco/protocols-core";
import {
  type ArgumentMetadata,
  type Constructor,
  getParamsMeta,
  type ParamMetadata,
  ParamType,
  type PipeTransform,
  type PipeTransformConstructor,
  RequestValidationProblem,
  ValidationPipe,
} from "@croco/protocols-rest";
import type { z } from "zod";
import type { CrocoHttpContext } from "./types";

const PARAM_TYPE_MAP: Record<ParamType, ArgumentMetadata["type"]> = {
  [ParamType.PARAM]: "param",
  [ParamType.QUERY]: "query",
  [ParamType.BODY]: "body",
  [ParamType.HEADER]: "header",
  [ParamType.CTX]: "custom",
  [ParamType.RAW]: "custom",
};

const BODY_PARSE_FAILURE_MESSAGE = "Request body must contain valid JSON";

const SCHEMALESS_NAMED_PARAM_PIPES: Partial<Record<ParamType, PipeTransform>> = {
  [ParamType.QUERY]: new ValidationPipe(getHttpParamFallbackSchema("query")),
  [ParamType.HEADER]: new ValidationPipe(getHttpParamFallbackSchema("header")),
};

type PipeInstanceFactory = (pipe: PipeTransformConstructor) => PipeTransform | null | undefined;

/**
 * 컨트롤러 파라미터 메타데이터를 읽어 실제 메서드 인자 배열로 변환합니다.
 */
export class ParamResolver {
  private readonly engine: ParamResolverEngine;

  constructor(createPipeInstance: PipeInstanceFactory = () => undefined) {
    this.engine = new ParamResolverEngine(createPipeInstance);
  }

  resolveParams(
    ctx: CrocoHttpContext,
    controller: Constructor,
    methodName: string | symbol,
  ): Promise<unknown[]> {
    return this.engine.resolveParams(ctx, controller, methodName, []);
  }
}

class ParamResolverEngine {
  private static readonly PARSED_BODY_PROMISE_KEY = "@croco/transports-http:parsed-body-promise";

  constructor(private readonly createPipeInstance: PipeInstanceFactory) {}

  async resolveParams(
    ctx: CrocoHttpContext,
    controller: Constructor,
    methodName: string | symbol,
    routePipes: readonly PipeTransform[],
  ): Promise<unknown[]> {
    const paramsMeta = getParamsMeta(controller, methodName);

    if (paramsMeta.length === 0) {
      return [];
    }

    const sortedParams = [...paramsMeta].sort((a, b) => a.index - b.index);
    const maxIndex = Math.max(...sortedParams.map((p) => p.index));
    const args: unknown[] = Array.from({ length: maxIndex + 1 }).fill(undefined) as unknown[];
    const cachedBody = await this.resolveBody(ctx, sortedParams);

    const parsedContracts = new Map<z.ZodType, Map<ParamType, unknown>>();
    for (const param of sortedParams) {
      let rawValue: unknown;
      if (param.contractSchema) {
        let parsedSources = parsedContracts.get(param.contractSchema);
        if (!parsedSources) {
          parsedSources = new Map();
          parsedContracts.set(param.contractSchema, parsedSources);
        }
        if (!parsedSources.has(param.type)) {
          parsedSources.set(param.type, await this.parseContract(ctx, param));
        }
        const parsed = parsedSources.get(param.type);
        rawValue = this.isRecord(parsed) && param.name ? parsed[param.name] : undefined;
      } else {
        rawValue = await this.resolveParam(ctx, param, cachedBody);
      }
      args[param.index] = await this.runPipes(rawValue, param, routePipes);
    }

    return args;
  }

  private async parseContract(ctx: CrocoHttpContext, param: ParamMetadata): Promise<unknown> {
    const schema = param.contractSchema;
    const inputObject = schema ? getZodInputObjectSchema(schema) : undefined;
    if (
      !schema ||
      !inputObject ||
      (param.type !== ParamType.PARAM && param.type !== ParamType.QUERY)
    ) {
      throw ProblemFactory.internalServerError(
        "transports-http/invalid-contract-binding",
        "Contract parameter bindings require a path or query object schema",
      );
    }
    const source = param.type === ParamType.PARAM ? "params" : "query";
    const input: Record<string, unknown> = { ...ctx.req[source] };
    if (param.type === ParamType.QUERY) {
      for (const [name, field] of Object.entries(inputObject.shape)) {
        const value = input[name];
        if (Array.isArray(value) && !getZodArrayInputSchema(field)) {
          throw new RequestValidationProblem("query", [
            { path: name, message: "Expected a single query value" },
          ]);
        }
        if (typeof value === "string" && isZodArraySchema(field)) {
          input[name] = [value];
        }
      }
    }
    const parseSchema =
      param.type === ParamType.QUERY ? getZodQueryInputSchema(schema, ctx.req.query) : schema;
    const result = await parseSchema.safeParseAsync(input);
    if (!result.success) {
      throw new RequestValidationProblem(
        source,
        result.error.issues.map((issue) => ({
          path: issue.path.join(".") || "value",
          message: issue.message,
        })),
      );
    }
    if (!this.isRecord(result.data) || Array.isArray(result.data)) {
      throw ProblemFactory.internalServerError(
        "transports-http/invalid-contract-output",
        "Contract parameter schemas must produce an object",
      );
    }
    return result.data;
  }

  private async resolveBody(ctx: CrocoHttpContext, params: ParamMetadata[]): Promise<unknown> {
    const hasBodyParam = params.some((param) => param.type === ParamType.BODY);
    if (!hasBodyParam) {
      return undefined;
    }

    const cachedBodyPromise = ctx.get<Promise<unknown>>(
      ParamResolverEngine.PARSED_BODY_PROMISE_KEY,
    );
    if (cachedBodyPromise) {
      return cachedBodyPromise;
    }

    const bodyPromise = this.parseBody(ctx);
    ctx.set(ParamResolverEngine.PARSED_BODY_PROMISE_KEY, bodyPromise);

    return bodyPromise;
  }

  private async parseBody(ctx: CrocoHttpContext): Promise<unknown> {
    if (ctx.raw.req.raw.body === null) {
      return undefined;
    }

    try {
      const body = await ctx.raw.req.text();
      return body.length === 0 ? undefined : JSON.parse(body);
    } catch {
      throw new RequestValidationProblem("body", [
        {
          path: "value",
          message: BODY_PARSE_FAILURE_MESSAGE,
        },
      ]);
    }
  }

  private async resolveParam(
    ctx: CrocoHttpContext,
    param: ParamMetadata,
    cachedBody: unknown,
  ): Promise<unknown> {
    switch (param.type as string) {
      case ParamType.PARAM:
        return param.name ? ctx.param(param.name) : undefined;

      case ParamType.QUERY:
        return param.name ? ctx.query(param.name) : undefined;

      case ParamType.HEADER:
        return param.name ? ctx.header(param.name) : undefined;

      case ParamType.BODY:
        return cachedBody;

      case ParamType.CTX:
        return ctx;

      case ParamType.RAW:
        return ctx.raw;

      case "user":
        return this.resolveAuthProperty(ctx, "user");

      case "principal":
        return this.resolveAuthProperty(ctx, "principal");

      case "apikey":
      case "apiKey":
        return this.resolveAuthProperty(ctx, "apiKey");

      default:
        return undefined;
    }
  }

  private resolveAuthProperty(
    ctx: CrocoHttpContext,
    property: "user" | "principal" | "apiKey",
  ): unknown {
    const rawReqRaw = (ctx.raw as { req?: { raw?: unknown } } | undefined)?.req?.raw;
    if (this.isRecord(rawReqRaw)) {
      const value = this.readAuthPropertyFromRecord(rawReqRaw, property);
      if (value !== undefined) {
        return value;
      }
    }

    const rawReq = (ctx.raw as { req?: unknown } | undefined)?.req;
    if (this.isRecord(rawReq)) {
      const value = this.readAuthPropertyFromRecord(rawReq, property);
      if (value !== undefined) {
        return value;
      }
    }

    const crocoReq = (ctx as { req?: unknown } | undefined)?.req;
    if (this.isRecord(crocoReq)) {
      const value = this.readAuthPropertyFromRecord(crocoReq, property);
      if (value !== undefined) {
        return value;
      }
    }

    if (this.isRecord(ctx.raw)) {
      const value = this.readAuthPropertyFromRecord(ctx.raw, property);
      if (value !== undefined) {
        return value;
      }
    }

    if (typeof ctx.get === "function") {
      const contextValue = ctx.get(property);
      if (contextValue !== undefined) {
        return contextValue;
      }
      if (property === "apiKey") {
        const lowerCaseApiKey = ctx.get("apikey");
        if (lowerCaseApiKey !== undefined) {
          return lowerCaseApiKey;
        }
      }
    }

    if (this.isRecord(ctx)) {
      const value = this.readAuthPropertyFromRecord(ctx, property);
      if (value !== undefined) {
        return value;
      }
    }

    return undefined;
  }

  private readAuthPropertyFromRecord(
    record: Record<string, unknown>,
    property: "user" | "principal" | "apiKey",
  ): unknown {
    if (Object.prototype.hasOwnProperty.call(record, property)) {
      return record[property];
    }
    if (property === "apiKey" && Object.prototype.hasOwnProperty.call(record, "apikey")) {
      return record["apikey"];
    }
    return undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private async runPipes(
    value: unknown,
    param: ParamMetadata,
    routePipes: readonly PipeTransform[],
  ): Promise<unknown> {
    const metadata: ArgumentMetadata = {
      type: PARAM_TYPE_MAP[param.type] ?? "custom",
      ...(param.name ? { name: param.name } : {}),
    };

    let result = value;
    for (const pipe of routePipes) {
      result = await pipe.transform(result, metadata);
    }

    if (!param.pipes || param.pipes.length === 0) {
      const fallbackPipe =
        !param.contractSchema && param.name ? SCHEMALESS_NAMED_PARAM_PIPES[param.type] : undefined;
      return fallbackPipe ? fallbackPipe.transform(result, metadata) : result;
    }

    for (const pipe of param.pipes) {
      const pipeInstance: PipeTransform = this.resolvePipe(pipe);
      result = await pipeInstance.transform(result, metadata);
    }

    return result;
  }

  private resolvePipe(pipe: PipeTransformConstructor | PipeTransform | z.ZodType): PipeTransform {
    if (isZodType(pipe)) {
      return new ValidationPipe(pipe);
    }

    if (typeof pipe === "object" && pipe !== null) {
      return pipe as PipeTransform;
    }

    const pipeInstance = this.createPipeInstance(pipe as PipeTransformConstructor);
    if (pipeInstance == null) {
      throw ProblemFactory.internalServerError(
        "transports-http/pipe-resolution-failed",
        `Container did not return an instance for pipe ${pipe.name}`,
      );
    }

    return pipeInstance;
  }
}

/** @internal RouteCompiler bridge that keeps route-level pipe wiring out of the public ParamResolver API. */
export function resolveParamsWithRoutePipes(
  ctx: CrocoHttpContext,
  controller: Constructor,
  methodName: string | symbol,
  routePipes: readonly PipeTransform[],
  createPipeInstance: PipeInstanceFactory,
): Promise<unknown[]> {
  return new ParamResolverEngine(createPipeInstance).resolveParams(
    ctx,
    controller,
    methodName,
    routePipes,
  );
}
