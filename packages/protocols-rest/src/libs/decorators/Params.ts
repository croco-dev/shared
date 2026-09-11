import "reflect-metadata";
import type { z } from "zod";
import { ParamType, REST_PARAMS_KEY } from "../constants";
import { captureRestDecoratorSourceLocation } from "../sourceLocation";
import type { ParamMetadata } from "../types";
import { getRouteParameterObject } from "../internal/routeParameterSchema";
import type { RouteParameterSchema } from "../internal/routeParameterSchema";
import {
  hasRouteBodyContract,
  hasRouteParamsContract,
  hasRouteQueryContract,
  type RouteContractWithBody,
  type RouteContractWithParams,
  type RouteContractWithQuery,
  type RouteHandlerBody,
  type RouteHandlerPathParams,
  type RouteHandlerQuery,
} from "../types/RouteContract";
import { ValidationPipe } from "../validators/ValidationPipe";
import type { ContractParameterDecorator } from "./contractDecoratorSignature";

function createParamDecorator(type: ParamType) {
  return (name?: string, schema?: z.ZodType, contractSchema?: z.ZodType): ParameterDecorator => {
    const sourceLocation = captureRestDecoratorSourceLocation();

    return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
      if (!propertyKey) return;

      const ownParams = Reflect.getOwnMetadata(REST_PARAMS_KEY, target.constructor) as
        | Map<string | symbol, ParamMetadata[]>
        | undefined;
      const inheritedParams = ownParams
        ? undefined
        : (Reflect.getMetadata(REST_PARAMS_KEY, target.constructor) as
            | Map<string | symbol, ParamMetadata[]>
            | undefined);
      const existingParams =
        ownParams ??
        new Map(
          [...(inheritedParams ?? [])].map(([methodName, params]) => [methodName, [...params]]),
        );

      const methodParams = existingParams.get(propertyKey) || [];

      const param: ParamMetadata = {
        type,
        index: parameterIndex,
        ...(name === undefined ? {} : { name }),
        ...(contractSchema ? { contractSchema } : {}),
        ...(sourceLocation ? { sourceLocation } : {}),
      };

      if (schema) {
        param.pipes = [new ValidationPipe(schema)];
      }

      existingParams.set(propertyKey, [...methodParams, param]);
      Reflect.defineMetadata(REST_PARAMS_KEY, existingParams, target.constructor);
    };
  };
}

/**
 * 경로 파라미터를 메서드 인자에 바인딩합니다.
 */
export function Param<
  TContract extends RouteContractWithParams,
  Name extends keyof RouteHandlerPathParams<TContract> & string,
>(
  contract: TContract,
  name: Name,
): ContractParameterDecorator<RouteHandlerPathParams<TContract>[Name]>;
export function Param(name: string, schema?: z.ZodType): ParameterDecorator;
export function Param(
  nameOrContract: string | RouteContractWithParams,
  schemaOrName?: z.ZodType | string,
): unknown {
  if (hasRouteParamsContract(nameOrContract)) {
    const name = schemaOrName as keyof RouteHandlerPathParams<typeof nameOrContract> & string;

    return createContractParamDecorator(ParamType.PARAM, nameOrContract.params, name);
  }

  return createParamDecorator(ParamType.PARAM)(nameOrContract, schemaOrName as z.ZodType);
}

/**
 * 쿼리스트링 값을 메서드 인자에 바인딩합니다.
 */
export function Query<
  TContract extends RouteContractWithQuery,
  Name extends keyof RouteHandlerQuery<TContract> & string,
>(contract: TContract, name: Name): ContractParameterDecorator<RouteHandlerQuery<TContract>[Name]>;
export function Query(name: string, schema?: z.ZodType): ParameterDecorator;
export function Query(
  nameOrContract: string | RouteContractWithQuery,
  schemaOrName?: z.ZodType | string,
): unknown {
  if (hasRouteQueryContract(nameOrContract)) {
    const name = schemaOrName as keyof RouteHandlerQuery<typeof nameOrContract> & string;

    return createContractParamDecorator(ParamType.QUERY, nameOrContract.query, name);
  }

  return createParamDecorator(ParamType.QUERY)(nameOrContract, schemaOrName as z.ZodType);
}

/**
 * 요청 헤더 값을 메서드 인자에 바인딩합니다.
 */
export const Header = (name: string, schema?: z.ZodType) =>
  createParamDecorator(ParamType.HEADER)(name, schema);

/**
 * 요청 본문 전체를 메서드 인자에 바인딩합니다.
 */
export function Body<TContract extends RouteContractWithBody>(
  contract: TContract,
): ContractParameterDecorator<RouteHandlerBody<TContract>>;
export function Body(schema?: z.ZodType): ParameterDecorator;
export function Body(schemaOrContract?: z.ZodType | RouteContractWithBody): unknown {
  const schema = hasRouteBodyContract(schemaOrContract) ? schemaOrContract.body : schemaOrContract;

  return createParamDecorator(ParamType.BODY)(undefined, schema);
}

/**
 * 추상화된 HTTP 컨텍스트를 메서드 인자에 바인딩합니다.
 */
export const Ctx = (): ParameterDecorator => createParamDecorator(ParamType.CTX)();

/**
 * 전송 계층의 원본 요청 객체를 메서드 인자에 바인딩합니다.
 */
export const Raw = (): ParameterDecorator => createParamDecorator(ParamType.RAW)();

function createContractParamDecorator(
  type: ParamType,
  schema: RouteParameterSchema,
  name: string,
): ParameterDecorator {
  const inputObject = getRouteParameterObject(schema);
  return schema === inputObject
    ? createParamDecorator(type)(name, inputObject.shape[name])
    : createParamDecorator(type)(name, undefined, schema);
}
