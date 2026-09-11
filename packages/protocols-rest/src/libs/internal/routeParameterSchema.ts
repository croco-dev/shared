import { ProblemFactory } from "@croco/problems-core";
import { getZodInputObjectSchema } from "@croco/protocols-core";
import { z } from "zod";

type ParameterObject = Record<string, unknown>;

export type RouteParameterSchema =
  | z.AnyZodObject
  | z.ZodEffects<RouteParameterSchema, ParameterObject, ParameterObject>
  | z.ZodPipeline<RouteParameterSchema, z.ZodType<ParameterObject>>;

export type RouteParameterObject<Schema> = RouteParameterSchema extends Schema
  ? z.AnyZodObject
  : Schema extends { readonly shape: z.ZodRawShape }
    ? Schema
    : Schema extends { readonly _def: { readonly schema: infer Inner } }
      ? RouteParameterObject<Inner>
      : Schema extends { readonly _def: { readonly in: infer Input } }
        ? RouteParameterObject<Input>
        : never;

export function getRouteParameterObject(schema: RouteParameterSchema): z.AnyZodObject {
  const object = getZodInputObjectSchema(schema);
  if (!object) {
    throw ProblemFactory.internalServerError(
      "protocols-rest/invalid-route-parameter-schema",
      "Route parameter schemas must have an object input.",
    );
  }
  return object;
}

export function isRouteParameterSchema(value: unknown): value is RouteParameterSchema {
  return value instanceof z.ZodType && getZodInputObjectSchema(value) !== undefined;
}
