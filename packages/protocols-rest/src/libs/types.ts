import type { z } from "zod";
import type { Guard } from "@croco/framework-context";
import type { ProblemCategory } from "@croco/problems-core";
import type { HttpMethod, ParamType } from "./constants";
import type { ExceptionFilter } from "./interfaces/ExceptionFilter";
import type { Interceptor } from "./interfaces/Interceptor";
import type { PipeTransform } from "./interfaces/PipeTransform";
import type { RouteContractSourceLocation, RouteContractSpec } from "./types/RouteContract";

export interface ControllerMetadata {
  path: string;
  target: Function;
  sourceLocation?: RouteContractSourceLocation;
}

export interface RouteMetadata {
  method: HttpMethod;
  path: string;
  methodName: string | symbol;
  statusCode?: number;
  contract?: RouteContractSpec;
  sourceLocation?: RouteContractSourceLocation;
}

export type ProblemResponseMetadata<
  Code extends string = string,
  Category extends ProblemCategory = ProblemCategory,
  Status extends number = number,
> = {
  readonly code: Code;
  readonly category: Category;
  readonly status: Status;
  readonly description?: string;
  readonly type?: string;
};

export type ProblemResponseOptions<
  Code extends string = string,
  Category extends ProblemCategory = ProblemCategory,
  Status extends number = number,
> = {
  readonly code: Code;
  readonly category: Category;
  readonly status?: Status;
  readonly description?: string;
  readonly type?: string;
};

export interface ParamMetadata {
  type: ParamType;
  index: number;
  name?: string;
  pipes?: (PipeTransformConstructor | PipeTransform)[];
  contractSchema?: z.ZodType;
  sourceLocation?: RouteContractSourceLocation;
}

export interface HttpContext {
  readonly request: HttpRequestLike;
  readonly response: HttpResponseLike;
  param(name: string): string | undefined;
  query(name: string): string | string[] | undefined;
  header(name: string): string | undefined;
  json<T = unknown>(): Promise<T>;
  set(key: string, value: unknown): void;
  get<T = unknown>(key: string): T | undefined;
}

export interface HttpRequestLike {
  method: string;
  url: string;
  headers: Headers | Record<string, string>;
  params?: Record<string, string>;
  query?: Record<string, string | string[]>;
}

export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
}

export type Constructor<T = unknown> = new (...args: unknown[]) => T;
export type PipeTransformConstructor = Constructor<PipeTransform>;
export type GuardConstructor = Constructor<Guard>;
export type InterceptorConstructor = Constructor<Interceptor>;
export type ExceptionFilterConstructor = Constructor<ExceptionFilter>;
