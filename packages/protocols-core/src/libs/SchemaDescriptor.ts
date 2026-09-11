import type { z } from "zod";

export const CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE = "contract-schema-json-unsafe";
export const CONTRACT_SCHEMA_ZOD_EFFECTS_UNWRAPPED_DIAGNOSTIC_CODE =
  "contract-schema-zod-effects-unwrapped";

export type ContractSchemaPrimitiveValue = string | number | boolean | null;
export type ContractSchemaJsonSafeStatus = "supported" | "unsupported";
export type ContractSchemaDiagnosticSeverity = "error" | "warning";

export type ContractSchemaDiagnostic = {
  readonly code: string;
  readonly severity: ContractSchemaDiagnosticSeverity;
  readonly typeName: string;
  readonly message: string;
  readonly schemaPath: readonly string[];
};

export type ContractSchemaSupportMatrixEntry = {
  readonly typeName: string;
  readonly kind: string;
  readonly jsonSafe: ContractSchemaJsonSafeStatus;
  readonly note: string;
};

export type ContractSchemaDescriptor = {
  readonly kind: string;
  readonly typeName: string;
  readonly jsonSafe: boolean;
  readonly unsupportedReason?: string;
  readonly effectType?: string;
  readonly fields?: readonly ContractSchemaFieldDescriptor[];
  readonly element?: ContractSchemaDescriptor | null;
  readonly inner?: ContractSchemaDescriptor | null;
  readonly options?: readonly ContractSchemaDescriptor[];
  readonly values?: readonly (string | number)[];
  readonly value?: ContractSchemaPrimitiveValue;
};

export type ContractSchemaFieldDescriptor = {
  readonly name: string;
  readonly required: boolean;
  readonly schema: ContractSchemaDescriptor;
};

export const JSON_SAFE_ZOD_SCHEMA_SUPPORT_MATRIX = [
  {
    typeName: "ZodString",
    kind: "string",
    jsonSafe: "supported",
    note: "Emitted as a JSON string contract.",
  },
  {
    typeName: "ZodNumber",
    kind: "number",
    jsonSafe: "supported",
    note: "Emitted as a JSON number contract.",
  },
  {
    typeName: "ZodBoolean",
    kind: "boolean",
    jsonSafe: "supported",
    note: "Emitted as a JSON boolean contract.",
  },
  {
    typeName: "ZodNull",
    kind: "null",
    jsonSafe: "supported",
    note: "Emitted as a JSON null contract.",
  },
  {
    typeName: "ZodLiteral",
    kind: "literal",
    jsonSafe: "supported",
    note: "Supported for string, number, boolean, and null literal values.",
  },
  {
    typeName: "ZodEnum",
    kind: "enum",
    jsonSafe: "supported",
    note: "Supported for string enum values.",
  },
  {
    typeName: "ZodNativeEnum",
    kind: "enum",
    jsonSafe: "supported",
    note: "Supported for string and number enum values.",
  },
  {
    typeName: "ZodObject",
    kind: "object",
    jsonSafe: "supported",
    note: "Supported when every field schema is JSON-safe.",
  },
  {
    typeName: "ZodArray",
    kind: "array",
    jsonSafe: "supported",
    note: "Supported when the element schema is JSON-safe.",
  },
  {
    typeName: "ZodRecord",
    kind: "record",
    jsonSafe: "supported",
    note: "Supported for z.string()-keyed records when the value schema is JSON-safe.",
  },
  {
    typeName: "ZodUnion",
    kind: "union",
    jsonSafe: "supported",
    note: "Supported when every option schema is JSON-safe.",
  },
  {
    typeName: "ZodDiscriminatedUnion",
    kind: "union",
    jsonSafe: "supported",
    note: "Supported when every option schema is JSON-safe.",
  },
  {
    typeName: "ZodOptional",
    kind: "optional",
    jsonSafe: "supported",
    note: "Unwraps to the inner schema and marks object fields as optional.",
  },
  {
    typeName: "ZodNullable",
    kind: "nullable",
    jsonSafe: "supported",
    note: "Unwraps to the inner schema plus null.",
  },
  {
    typeName: "ZodDefault",
    kind: "default",
    jsonSafe: "supported",
    note: "Unwraps to the inner schema and marks object fields as optional.",
  },
  {
    typeName: "ZodCatch",
    kind: "catch",
    jsonSafe: "supported",
    note: "Unwraps to the inner schema while retaining the runtime fallback.",
  },
  {
    typeName: "ZodEffects",
    kind: "effects",
    jsonSafe: "supported",
    note: "Refinements unwrap to the inner schema with a diagnostic warning; transforms and preprocessors are rejected.",
  },
  {
    typeName: "ZodBranded",
    kind: "branded",
    jsonSafe: "supported",
    note: "Unwraps to the inner schema.",
  },
  {
    typeName: "ZodReadonly",
    kind: "readonly",
    jsonSafe: "supported",
    note: "Unwraps to the inner schema.",
  },
  {
    typeName: "ZodAny",
    kind: "any",
    jsonSafe: "supported",
    note: "Emitted as an explicit unknown JSON value contract.",
  },
  {
    typeName: "ZodUnknown",
    kind: "unknown",
    jsonSafe: "supported",
    note: "Emitted as an explicit unknown JSON value contract.",
  },
  {
    typeName: "ZodNever",
    kind: "never",
    jsonSafe: "supported",
    note: "Emitted as an impossible contract branch.",
  },
  {
    typeName: "ZodDate",
    kind: "date",
    jsonSafe: "unsupported",
    note: "Date instances are not JSON values; use an ISO string contract.",
  },
  {
    typeName: "ZodBigInt",
    kind: "bigint",
    jsonSafe: "unsupported",
    note: "BigInt values are not JSON values; use a string or number boundary contract.",
  },
  {
    typeName: "ZodFunction",
    kind: "function",
    jsonSafe: "unsupported",
    note: "Functions are not serializable JSON contract values.",
  },
  {
    typeName: "ZodMap",
    kind: "map",
    jsonSafe: "unsupported",
    note: "Maps are not JSON objects with stable string keys; use an object or array contract.",
  },
  {
    typeName: "ZodSet",
    kind: "set",
    jsonSafe: "unsupported",
    note: "Sets are not JSON arrays with stable element semantics; use an array contract.",
  },
  {
    typeName: "ZodPromise",
    kind: "promise",
    jsonSafe: "unsupported",
    note: "Promises are runtime behavior, not JSON contract values.",
  },
  {
    typeName: "ZodSymbol",
    kind: "symbol",
    jsonSafe: "unsupported",
    note: "Symbols are not JSON values.",
  },
  {
    typeName: "ZodNaN",
    kind: "nan",
    jsonSafe: "unsupported",
    note: "NaN is not a JSON number.",
  },
  {
    typeName: "ZodVoid",
    kind: "void",
    jsonSafe: "unsupported",
    note: "Void is not a JSON value; omit the response schema for empty responses.",
  },
  {
    typeName: "ZodUndefined",
    kind: "undefined",
    jsonSafe: "unsupported",
    note: "Undefined is not a JSON value; use optional object fields or omit the schema.",
  },
] as const satisfies readonly ContractSchemaSupportMatrixEntry[];

type ZodDefinition = {
  readonly shape?: unknown;
  readonly in?: unknown;
  readonly innerType?: unknown;
  readonly schema?: unknown;
  readonly type?: unknown;
  readonly element?: unknown;
  readonly keyType?: unknown;
  readonly valueType?: unknown;
  readonly options?: unknown;
  readonly values?: unknown;
  readonly entries?: unknown;
  readonly value?: unknown;
  readonly defaultValue?: unknown | (() => unknown);
  readonly catchall?: unknown;
  readonly unknownKeys?: unknown;
  readonly effect?: {
    readonly type?: unknown;
  };
};

type TransparentZodWrapperChildKey = "innerType" | "type";

const TRANSPARENT_ZOD_WRAPPER_CHILD_KEYS: Readonly<Record<string, TransparentZodWrapperChildKey>> =
  {
    ZodOptional: "innerType",
    ZodNullable: "innerType",
    ZodDefault: "innerType",
    ZodCatch: "innerType",
    ZodBranded: "type",
    ZodReadonly: "innerType",
  };

const PARAMETER_SCHEMA_CACHE = new WeakMap<z.ZodType, z.ZodType>();
const ARRAY_INPUT_SCHEMA_CACHE = new WeakMap<object, z.ZodType | null>();

export function describeZodSchema(
  schema: z.ZodType | null | undefined,
): ContractSchemaDescriptor | null {
  if (!schema) {
    return null;
  }

  return describeUnknownSchema(schema, new Set());
}

export function getSchemaDescriptorDiagnostics(
  descriptor: ContractSchemaDescriptor | null,
): readonly ContractSchemaDiagnostic[] {
  if (!descriptor) {
    return [];
  }

  return collectSchemaDescriptorDiagnostics(descriptor, []);
}

export function formatSchemaDiagnostic(diagnostic: ContractSchemaDiagnostic): string {
  const location = diagnostic.schemaPath.length > 0 ? ` at ${diagnostic.schemaPath.join(".")}` : "";

  return `${diagnostic.code}${location}: ${diagnostic.message}`;
}

export function unwrapZodEffectsSchema<TSchema extends z.ZodType | null | undefined>(
  schema: TSchema,
): TSchema {
  const unwrapped = unwrapUnknownZodEffectsSchema(schema);

  return unwrapped as TSchema;
}

export function getZodSchemaTypeName(schema: unknown): string {
  return getSchemaTypeName(schema);
}

export function getZodInnerSchema(schema: unknown): unknown {
  const definition = getZodDefinition(schema);

  return definition?.innerType ?? definition?.schema ?? definition?.type;
}

/**
 * Returns whether a schema accepts an array without changing its input shape.
 *
 * Optional, nullable, default, catch, branded, readonly, and refinement wrappers
 * preserve array input. Transform and preprocess effects remain opaque because
 * they may change the runtime value shape.
 */
export function isZodArraySchema(schema: unknown): boolean {
  return getTransparentZodArraySchema(schema) !== undefined;
}

/**
 * Returns whether a parameter schema explicitly accepts array input.
 *
 * Arrays, any, unknown, transparent wrappers and refinements around them, and
 * ordinary unions containing an array-capable option accept repeated values.
 * Value-changing effects remain opaque so coercion and preprocessing cannot
 * silently reinterpret repeated scalar parameters.
 */
export function acceptsZodArrayInput(schema: unknown): boolean {
  return getZodArrayInputSchema(schema) !== undefined;
}

/**
 * Projects a parameter schema to the branches that preserve array input.
 *
 * Scalar and value-changing union branches are removed so their coercion,
 * preprocessing, or catch behavior cannot consume repeated parameter values.
 * The projection is cached by source schema for request-path reuse.
 */
export function getZodArrayInputSchema(schema: unknown): z.ZodType | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }

  const cachedSchema = ARRAY_INPUT_SCHEMA_CACHE.get(schema);
  if (cachedSchema !== undefined) {
    return cachedSchema ?? undefined;
  }

  const projectedSchema = projectZodArrayInputSchema(schema, new Map());
  const result = isZodType(projectedSchema) ? projectedSchema : undefined;
  ARRAY_INPUT_SCHEMA_CACHE.set(schema, result ?? null);
  return result;
}

function projectZodArrayInputSchema(
  schema: unknown,
  projectedSchemas: Map<object, unknown | undefined>,
): unknown | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }

  if (projectedSchemas.has(schema)) {
    return projectedSchemas.get(schema);
  }

  projectedSchemas.set(schema, undefined);

  const typeName = getSchemaTypeName(schema);
  if (typeName === "ZodArray" || typeName === "ZodAny" || typeName === "ZodUnknown") {
    projectedSchemas.set(schema, schema);
    return schema;
  }

  const definition = getZodDefinition(schema);
  if (!definition) {
    return undefined;
  }

  const childKey = getCatchRewriteChildKey(typeName, schema);
  if (childKey) {
    const child = definition[childKey];
    const projectedChild = projectZodArrayInputSchema(child, projectedSchemas);
    if (projectedChild === undefined) {
      return undefined;
    }

    const projected =
      typeName === "ZodCatch"
        ? projectedChild
        : projectedChild === child
          ? schema
          : reconstructZodSchema(schema, {
              ...definition,
              [childKey]: projectedChild,
            });
    projectedSchemas.set(schema, projected);
    return projected;
  }

  if (typeName === "ZodUnion" && Array.isArray(definition?.options)) {
    const projectedOptions: unknown[] = [];
    for (const option of definition.options) {
      const projectedOption = projectZodArrayInputSchema(option, projectedSchemas);
      if (projectedOption !== undefined) {
        projectedOptions.push(projectedOption);
      }
    }

    if (projectedOptions.length === 0) {
      return undefined;
    }

    const projected =
      projectedOptions.length === 1
        ? projectedOptions[0]
        : definition.options.length === projectedOptions.length &&
            definition.options.every((option, index) => option === projectedOptions[index])
          ? schema
          : reconstructZodSchema(schema, {
              ...definition,
              options: projectedOptions,
            });
    projectedSchemas.set(schema, projected);
    return projected;
  }

  return undefined;
}

/**
 * Removes catch wrappers that parameter-schema consumers cannot interpret.
 *
 * Transparent wrappers and ordinary union options are reconstructed only when
 * they contain a catch. Value-changing effects and discriminated unions remain opaque.
 */
export function unwrapZodParameterSchema<TSchema extends z.ZodType | null | undefined>(
  schema: TSchema,
): TSchema {
  if (!schema) {
    return schema;
  }

  const cachedSchema = PARAMETER_SCHEMA_CACHE.get(schema);
  if (cachedSchema) {
    return cachedSchema as TSchema;
  }

  const rewrittenSchema = rewriteZodCatchSchemas(schema, new Map()) as z.ZodType;
  PARAMETER_SCHEMA_CACHE.set(schema, rewrittenSchema);
  return rewrittenSchema as TSchema;
}

export function getZodArrayElementSchema(schema: unknown): unknown {
  const arraySchema = getTransparentZodArraySchema(schema);
  const definition = getZodDefinition(arraySchema);

  return definition?.element ?? definition?.type;
}

function getTransparentZodArraySchema(schema: unknown): unknown | undefined {
  const unwrapped = getTransparentZodSchema(schema);

  return getSchemaTypeName(unwrapped) === "ZodArray" ? unwrapped : undefined;
}

function getTransparentZodSchema(schema: unknown): unknown {
  const seen = new Set<object>();
  let current = schema;

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);

    const typeName = getSchemaTypeName(current);
    if (
      isTransparentArrayWrapper(typeName) ||
      (typeName === "ZodEffects" && isZodRefinementEffect(current))
    ) {
      current = getZodInnerSchema(current);
      continue;
    }

    break;
  }

  return current;
}

function rewriteZodCatchSchemas(schema: unknown, rewrittenSchemas: Map<object, unknown>): unknown {
  if (!isRecord(schema)) {
    return schema;
  }

  if (rewrittenSchemas.has(schema)) {
    return rewrittenSchemas.get(schema);
  }

  rewrittenSchemas.set(schema, schema);

  const typeName = getSchemaTypeName(schema);
  const definition = getZodDefinition(schema);
  if (!definition) {
    return schema;
  }

  const childKey = getCatchRewriteChildKey(typeName, schema);
  if (childKey) {
    const child = definition[childKey];
    const rewrittenChild = rewriteZodCatchSchemas(child, rewrittenSchemas);

    if (typeName === "ZodCatch") {
      rewrittenSchemas.set(schema, rewrittenChild);
      return rewrittenChild;
    }

    const rewritten =
      rewrittenChild === child
        ? schema
        : reconstructZodSchema(schema, {
            ...definition,
            [childKey]: rewrittenChild,
          });
    rewrittenSchemas.set(schema, rewritten);
    return rewritten;
  }

  if (typeName === "ZodUnion" && Array.isArray(definition.options)) {
    const rewrittenOptions = definition.options.map((option) =>
      rewriteZodCatchSchemas(option, rewrittenSchemas),
    );
    const rewritten = definition.options.every(
      (option, index) => option === rewrittenOptions[index],
    )
      ? schema
      : reconstructZodSchema(schema, {
          ...definition,
          options: rewrittenOptions,
        });
    rewrittenSchemas.set(schema, rewritten);
    return rewritten;
  }

  return schema;
}

function getCatchRewriteChildKey(
  typeName: string,
  schema: unknown,
): "innerType" | "schema" | "type" | undefined {
  const wrapperChildKey = TRANSPARENT_ZOD_WRAPPER_CHILD_KEYS[typeName];
  if (wrapperChildKey) {
    return wrapperChildKey;
  }

  if (typeName === "ZodEffects" && isZodRefinementEffect(schema)) {
    return "schema";
  }

  return undefined;
}

function reconstructZodSchema(schema: object, definition: ZodDefinition): unknown {
  return Reflect.construct(schema.constructor, [definition]);
}

export function getZodDefaultValue(schema: unknown): unknown {
  const defaultValue = getZodDefinition(schema)?.defaultValue;

  return typeof defaultValue === "function" ? defaultValue() : defaultValue;
}

export function getZodInputObjectSchema(schema: z.ZodType): z.AnyZodObject | undefined {
  const visited = new Set<z.ZodType>();
  let current: z.ZodType = schema;

  while (!visited.has(current)) {
    visited.add(current);
    const definition = getZodDefinition(current);
    const typeName = getSchemaTypeName(current);
    if (typeName === "ZodObject") {
      return current as z.AnyZodObject;
    }
    const inner =
      typeName === "ZodEffects"
        ? definition?.schema
        : typeName === "ZodPipeline"
          ? definition?.in
          : undefined;
    if (!isZodType(inner)) {
      return undefined;
    }
    current = inner;
  }
  return undefined;
}

export function getZodQueryInputSchema(
  schema: z.ZodType,
  input: Readonly<Record<string, unknown>>,
): z.ZodType {
  const definition = getZodDefinition(schema);
  const typeName = getSchemaTypeName(schema);
  if (!definition) {
    return schema;
  }

  const childKey =
    typeName === "ZodEffects" ? "schema" : typeName === "ZodPipeline" ? "in" : undefined;
  if (childKey) {
    const child = definition[childKey];
    if (!isZodType(child)) {
      return schema;
    }
    const projected = getZodQueryInputSchema(child, input);
    return projected === child
      ? schema
      : (reconstructZodSchema(schema, { ...definition, [childKey]: projected }) as z.ZodType);
  }

  if (typeName !== "ZodObject") {
    return schema;
  }
  const shape = getObjectShape(schema);
  const projectedFields: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(shape)) {
    if (!Array.isArray(input[name])) {
      continue;
    }
    const projected = getZodArrayInputSchema(field);
    if (projected && projected !== field) {
      projectedFields[name] = projected;
    }
  }
  return Object.keys(projectedFields).length === 0
    ? schema
    : (reconstructZodSchema(schema, {
        ...definition,
        shape: () => ({ ...shape, ...projectedFields }),
      }) as z.ZodType);
}

export function getZodObjectShape(schema: unknown): Record<string, unknown> {
  return getObjectShape(schema);
}

export function getZodObjectUnsupportedDynamicKeyMode(
  schema: unknown,
): "catchall" | "passthrough" | undefined {
  const definition = getZodDefinition(schema);

  if (definition?.unknownKeys === "passthrough") {
    return "passthrough";
  }

  if (definition?.catchall === undefined) {
    return undefined;
  }

  const catchallSchemaName = getSchemaTypeName(definition.catchall);

  if (catchallSchemaName === "ZodNever") {
    return undefined;
  }

  return catchallSchemaName === "ZodUnknown" ? "passthrough" : "catchall";
}

function describeUnknownSchema(schema: unknown, seen: Set<unknown>): ContractSchemaDescriptor {
  if (!isZodType(schema)) {
    return unsupportedDescriptor("unknown", typeof schema, "Schema value is not a Zod schema.");
  }

  if (seen.has(schema)) {
    return unsupportedDescriptor(
      "recursive",
      getSchemaTypeName(schema),
      "Recursive schemas are not supported by generated JSON contracts.",
    );
  }

  seen.add(schema);

  const typeName = getSchemaTypeName(schema);
  const definition = getZodDefinition(schema);

  if (typeName === "ZodString") {
    return supportedDescriptor("string", typeName);
  }

  if (typeName === "ZodNumber") {
    return supportedDescriptor("number", typeName);
  }

  if (typeName === "ZodBoolean") {
    return supportedDescriptor("boolean", typeName);
  }

  if (typeName === "ZodNull") {
    return supportedDescriptor("null", typeName);
  }

  if (typeName === "ZodAny" || typeName === "ZodUnknown" || typeName === "ZodNever") {
    return supportedDescriptor(typeName.replace(/^Zod/, "").toLowerCase(), typeName);
  }

  if (typeName === "ZodUndefined") {
    return unsupportedDescriptor(
      "undefined",
      typeName,
      "Undefined is not a JSON value; use an optional object field or omit the schema.",
    );
  }

  if (typeName === "ZodVoid") {
    return unsupportedDescriptor(
      "void",
      typeName,
      "Void is not a JSON value; omit the response schema for empty responses.",
    );
  }

  if (typeName === "ZodBigInt") {
    return unsupportedDescriptor(
      "bigint",
      typeName,
      "BigInt values are not JSON-safe; use a string or number boundary schema.",
    );
  }

  if (typeName === "ZodDate") {
    return unsupportedDescriptor(
      "date",
      typeName,
      "Date instances are not JSON-safe; use an ISO string schema at the contract boundary.",
    );
  }

  if (typeName === "ZodFunction") {
    return unsupportedDescriptor("function", typeName, "Functions are not JSON contract values.");
  }

  if (typeName === "ZodMap") {
    return unsupportedDescriptor(
      "map",
      typeName,
      "Maps are not stable JSON object contracts; use an object or array schema.",
    );
  }

  if (typeName === "ZodSet") {
    return unsupportedDescriptor(
      "set",
      typeName,
      "Sets are not stable JSON array contracts; use an array schema.",
    );
  }

  if (typeName === "ZodPromise") {
    return unsupportedDescriptor(
      "promise",
      typeName,
      "Promises are runtime behavior, not JSON values.",
    );
  }

  if (typeName === "ZodSymbol") {
    return unsupportedDescriptor("symbol", typeName, "Symbols are not JSON values.");
  }

  if (typeName === "ZodNaN") {
    return unsupportedDescriptor("nan", typeName, "NaN is not a JSON number.");
  }

  if (typeName === "ZodLiteral") {
    const value = normalizeLiteralValue(getLiteralValue(definition));

    return value.supported
      ? { ...supportedDescriptor("literal", typeName), value: value.value }
      : unsupportedDescriptor("literal", typeName, value.reason);
  }

  if (typeName === "ZodEnum") {
    const enumValues = getEnumValues(definition?.values ?? definition?.entries);

    if (enumValues.unsupportedReason) {
      return {
        ...unsupportedDescriptor("enum", typeName, enumValues.unsupportedReason),
        values: enumValues.values,
      };
    }

    return {
      ...supportedDescriptor("enum", typeName),
      values: enumValues.values.sort(comparePrimitiveValues),
    };
  }

  if (typeName === "ZodNativeEnum") {
    const enumValues = getNativeEnumValues(definition?.values);

    if (enumValues.unsupportedReason) {
      return {
        ...unsupportedDescriptor("enum", typeName, enumValues.unsupportedReason),
        values: enumValues.values,
      };
    }

    return {
      ...supportedDescriptor("enum", typeName),
      values: enumValues.values.sort(comparePrimitiveValues),
    };
  }

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    const inner = describeMaybeSchema(definition?.innerType, seen);
    const kind = typeName === "ZodOptional" ? "optional" : "default";

    return {
      ...descriptorFromChildren(kind, typeName, [inner]),
      inner,
    };
  }

  if (typeName === "ZodCatch") {
    const inner = describeMaybeSchema(definition?.innerType, seen);

    return {
      ...descriptorFromChildren("catch", typeName, [inner]),
      inner,
    };
  }

  if (typeName === "ZodNullable") {
    const inner = describeMaybeSchema(definition?.innerType, seen);

    return {
      ...descriptorFromChildren("nullable", typeName, [inner]),
      inner,
    };
  }

  if (typeName === "ZodEffects") {
    const effectType =
      typeof definition?.effect?.type === "string" ? definition.effect.type : "unknown";
    const inner = describeMaybeSchema(definition?.schema ?? definition?.innerType, seen);

    if (effectType === "transform" || effectType === "preprocess" || effectType === "unknown") {
      return {
        ...unsupportedDescriptor(
          "effects",
          typeName,
          `Zod ${effectType} effects can change runtime values and are not JSON-safe contract schemas.`,
        ),
        effectType,
        inner,
      };
    }

    return {
      ...descriptorFromChildren("effects", typeName, [inner]),
      effectType,
      inner,
    };
  }

  if (typeName === "ZodBranded" || typeName === "ZodReadonly") {
    const inner = describeMaybeSchema(definition?.type ?? definition?.innerType, seen);
    const kind = typeName === "ZodBranded" ? "branded" : "readonly";

    return {
      ...descriptorFromChildren(kind, typeName, [inner]),
      inner,
    };
  }

  if (typeName === "ZodArray") {
    const element = describeMaybeSchema(definition?.element ?? definition?.type, seen);

    return {
      ...descriptorFromChildren("array", typeName, [element]),
      element,
    };
  }

  if (typeName === "ZodRecord") {
    const key = describeMaybeSchema(definition?.keyType, seen);
    const element = describeMaybeSchema(definition?.valueType, seen);

    if (key?.typeName !== "ZodString") {
      return {
        ...unsupportedDescriptor(
          "record",
          typeName,
          `ZodRecord key schema ${key?.typeName ?? "unknown"} is unsupported; use z.string() for JSON object keys.`,
        ),
        element,
      };
    }

    return {
      ...descriptorFromChildren("record", typeName, [element]),
      element,
    };
  }

  if (typeName === "ZodObject") {
    const fields = Object.entries(getObjectShape(schema))
      .map(([name, fieldSchema]) => ({
        name,
        required: !isOptionalInputSchema(fieldSchema),
        schema: describeUnknownSchema(fieldSchema, new Set(seen)),
      }))
      .sort(compareSchemaFields);

    return {
      ...descriptorFromChildren(
        "object",
        typeName,
        fields.map((field) => field.schema),
      ),
      fields,
    };
  }

  if (typeName === "ZodUnion" || typeName === "ZodDiscriminatedUnion") {
    const options = getSchemaOptions(definition)
      .map((option) => describeUnknownSchema(option, new Set(seen)))
      .sort(compareSchemaDescriptors);

    return {
      ...descriptorFromChildren("union", typeName, options),
      options,
    };
  }

  return unsupportedDescriptor(
    "other",
    typeName,
    `Unsupported Zod schema ${typeName}; use a schema listed in JSON_SAFE_ZOD_SCHEMA_SUPPORT_MATRIX.`,
  );
}

function getLiteralValue(definition: ZodDefinition | undefined): unknown {
  if (definition && Object.prototype.hasOwnProperty.call(definition, "value")) {
    return definition.value;
  }

  return getFirstArrayValue(definition?.values);
}

function describeMaybeSchema(value: unknown, seen: Set<unknown>): ContractSchemaDescriptor | null {
  return isZodType(value) ? describeUnknownSchema(value, new Set(seen)) : null;
}

function collectSchemaDescriptorDiagnostics(
  descriptor: ContractSchemaDescriptor,
  path: readonly string[],
): ContractSchemaDiagnostic[] {
  const diagnostics: ContractSchemaDiagnostic[] = [];

  if (!descriptor.jsonSafe && descriptor.unsupportedReason) {
    diagnostics.push({
      code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
      severity: "error",
      typeName: descriptor.typeName,
      schemaPath: path,
      message:
        descriptor.unsupportedReason ??
        `Unsupported Zod schema ${descriptor.typeName}; use a JSON-safe contract schema.`,
    });
  } else if (descriptor.kind === "effects") {
    diagnostics.push({
      code: CONTRACT_SCHEMA_ZOD_EFFECTS_UNWRAPPED_DIAGNOSTIC_CODE,
      severity: "warning",
      typeName: descriptor.typeName,
      schemaPath: path,
      message:
        "Zod refinements are represented from their inner schema in generated contracts; runtime refinements still run on the server.",
    });
  }

  if (descriptor.inner) {
    diagnostics.push(...collectSchemaDescriptorDiagnostics(descriptor.inner, path));
  }

  if (descriptor.element) {
    diagnostics.push(...collectSchemaDescriptorDiagnostics(descriptor.element, [...path, "[]"]));
  }

  for (const [index, option] of (descriptor.options ?? []).entries()) {
    diagnostics.push(...collectSchemaDescriptorDiagnostics(option, [...path, `option${index}`]));
  }

  for (const field of descriptor.fields ?? []) {
    diagnostics.push(...collectSchemaDescriptorDiagnostics(field.schema, [...path, field.name]));
  }

  return diagnostics;
}

function supportedDescriptor(kind: string, typeName: string): ContractSchemaDescriptor {
  return { kind, typeName, jsonSafe: true };
}

function unsupportedDescriptor(
  kind: string,
  typeName: string,
  unsupportedReason: string,
): ContractSchemaDescriptor {
  return { kind, typeName, jsonSafe: false, unsupportedReason };
}

function descriptorFromChildren(
  kind: string,
  typeName: string,
  children: readonly (ContractSchemaDescriptor | null)[],
): ContractSchemaDescriptor {
  const unsupportedChild = children.find((child) => child && !child.jsonSafe);

  if (unsupportedChild) {
    return { kind, typeName, jsonSafe: false };
  }

  return supportedDescriptor(kind, typeName);
}

function isOptionalInputSchema(schema: unknown): boolean {
  const typeName = getSchemaTypeName(schema);

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return true;
  }

  if (typeName === "ZodEffects") {
    const definition = getZodDefinition(schema);

    return isOptionalInputSchema(definition?.schema ?? definition?.innerType);
  }

  return false;
}

function isTransparentArrayWrapper(typeName: string): boolean {
  return TRANSPARENT_ZOD_WRAPPER_CHILD_KEYS[typeName] !== undefined;
}

function isZodRefinementEffect(schema: unknown): boolean {
  return getZodDefinition(schema)?.effect?.type === "refinement";
}

function unwrapUnknownZodEffectsSchema(schema: unknown): unknown {
  if (!isZodType(schema) || getSchemaTypeName(schema) !== "ZodEffects") {
    return schema;
  }

  const definition = getZodDefinition(schema);

  return unwrapUnknownZodEffectsSchema(definition?.schema ?? definition?.innerType);
}

function getSchemaTypeName(schema: unknown): string {
  if (!schema || typeof schema !== "object") {
    return typeof schema;
  }

  return schema.constructor.name;
}

function getZodDefinition(schema: unknown): ZodDefinition | undefined {
  if (!schema || typeof schema !== "object" || !("_def" in schema)) {
    return undefined;
  }

  return schema._def as ZodDefinition;
}

function getObjectShape(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {};
  }

  if ("shape" in schema) {
    const shape = schema.shape;

    if (shape && typeof shape === "object") {
      return shape as Record<string, unknown>;
    }
  }

  const definition = getZodDefinition(schema);
  const shape = typeof definition?.shape === "function" ? definition.shape() : definition?.shape;

  return shape && typeof shape === "object" ? (shape as Record<string, unknown>) : {};
}

function getSchemaOptions(definition: ZodDefinition | undefined): unknown[] {
  if (!definition) {
    return [];
  }

  if (Array.isArray(definition.options)) {
    return definition.options;
  }

  if (definition.options instanceof Map) {
    return [...definition.options.values()];
  }

  return [];
}

export function isZodType(value: unknown): value is z.ZodType {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { readonly safeParse?: unknown };

  return "_def" in value && typeof candidate.safeParse === "function";
}

function normalizeLiteralValue(value: unknown):
  | { readonly supported: true; readonly value: ContractSchemaPrimitiveValue }
  | {
      readonly supported: false;
      readonly reason: string;
    } {
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return { supported: true, value };
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return { supported: true, value };
  }

  return {
    supported: false,
    reason: `Literal value ${String(value)} is not JSON-safe; use a string, number, boolean, or null literal.`,
  };
}

type EnumValuesResult = {
  readonly values: (string | number)[];
  readonly unsupportedReason?: string;
};

function getEnumValues(value: unknown): EnumValuesResult {
  if (!Array.isArray(value)) {
    return getNativeEnumValues(value);
  }

  return toEnumValuesResult(value);
}

function getFirstArrayValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function getNativeEnumValues(value: unknown): EnumValuesResult {
  if (!isRecord(value)) {
    return { values: [] };
  }

  return toEnumValuesResult(
    Object.entries(value)
      .filter(([key]) => !isNumericEnumReverseMappingKey(key))
      .map(([, enumValue]) => enumValue),
  );
}

function toEnumValuesResult(values: readonly unknown[]): EnumValuesResult {
  const unsupportedValues = values.filter((value) => !isJsonEnumValue(value));
  const jsonValues = [...new Set(values.filter(isJsonEnumValue))];

  if (unsupportedValues.length > 0) {
    return {
      values: jsonValues,
      unsupportedReason: `Enum values ${unsupportedValues.map(String).join(", ")} are not JSON-safe; use string or finite number enum values.`,
    };
  }

  return { values: jsonValues };
}

function isJsonEnumValue(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isNumericEnumReverseMappingKey(key: string): boolean {
  return key.length > 0 && Number.isFinite(Number(key)) && String(Number(key)) === key;
}

function compareSchemaFields(
  left: ContractSchemaFieldDescriptor,
  right: ContractSchemaFieldDescriptor,
): number {
  return left.name.localeCompare(right.name);
}

function compareSchemaDescriptors(
  left: ContractSchemaDescriptor,
  right: ContractSchemaDescriptor,
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function comparePrimitiveValues(left: string | number, right: string | number): number {
  const typeComparison = compareCodeUnits(typeof left, typeof right);
  return typeComparison || compareCodeUnits(String(left), String(right));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
