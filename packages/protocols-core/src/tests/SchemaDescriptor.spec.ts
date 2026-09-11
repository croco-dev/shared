import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  acceptsZodArrayInput,
  CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
  CONTRACT_SCHEMA_ZOD_EFFECTS_UNWRAPPED_DIAGNOSTIC_CODE,
  describeZodSchema,
  getSchemaDescriptorDiagnostics,
  getZodArrayInputSchema,
  getZodInputObjectSchema,
  getZodQueryInputSchema,
  getZodArrayElementSchema,
  isZodArraySchema,
  isZodType,
  JSON_SAFE_ZOD_SCHEMA_SUPPORT_MATRIX,
  unwrapZodParameterSchema,
} from "../libs/SchemaDescriptor";

const NUMERIC_NATIVE_ENUM = {
  0: "Draft",
  1: "Published",
  Draft: 0,
  Published: 1,
} as const;
const MIXED_NATIVE_ENUM = {
  0: "Draft",
  Draft: 0,
  Published: "published",
} as const;

describe("SchemaDescriptor", () => {
  it("should describe optional, nullable, default, and refined schemas with one shared tree", () => {
    const descriptor = describeZodSchema(
      z.object({
        displayName: z.string().nullable().default(null),
        email: z.string().email().optional(),
        tags: z.array(z.string().refine((value) => value.length > 0)),
      }),
    );

    expect(descriptor).toMatchObject({
      kind: "object",
      typeName: "ZodObject",
      jsonSafe: true,
      fields: [
        {
          name: "displayName",
          required: false,
          schema: {
            kind: "default",
            inner: {
              kind: "nullable",
              inner: { kind: "string", jsonSafe: true },
            },
          },
        },
        {
          name: "email",
          required: false,
          schema: {
            kind: "optional",
            inner: { kind: "string", jsonSafe: true },
          },
        },
        {
          name: "tags",
          required: true,
          schema: {
            kind: "array",
            element: {
              kind: "effects",
              effectType: "refinement",
              inner: { kind: "string", jsonSafe: true },
            },
          },
        },
      ],
    });
    expect(getSchemaDescriptorDiagnostics(descriptor)).toEqual([
      expect.objectContaining({
        code: CONTRACT_SCHEMA_ZOD_EFFECTS_UNWRAPPED_DIAGNOSTIC_CODE,
        severity: "warning",
        schemaPath: ["tags", "[]"],
      }),
    ]);
  });

  it("should report JSON-unsafe schemas with one diagnostic code and precise paths", () => {
    const descriptor = describeZodSchema(
      z.object({
        amount: z.bigint(),
        checkedAt: z.date(),
        trimmed: z.string().transform((value) => value.trim()),
      }),
    );

    const diagnostics = getSchemaDescriptorDiagnostics(descriptor).filter(
      (diagnostic) => diagnostic.severity === "error",
    );

    expect(descriptor).toMatchObject({ kind: "object", jsonSafe: false });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        schemaPath: ["amount"],
        typeName: "ZodBigInt",
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        schemaPath: ["checkedAt"],
        typeName: "ZodDate",
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        schemaPath: ["trimmed"],
        typeName: "ZodEffects",
      }),
    ]);
  });

  it("should ignore TypeScript native enum reverse mappings", () => {
    expect(describeZodSchema(z.nativeEnum(NUMERIC_NATIVE_ENUM))).toMatchObject({
      kind: "enum",
      values: [0, 1],
      jsonSafe: true,
    });
    expect(describeZodSchema(z.nativeEnum(MIXED_NATIVE_ENUM))).toMatchObject({
      kind: "enum",
      values: [0, "published"],
      jsonSafe: true,
    });

    const reorderedMixedValues = describeZodSchema(
      z.nativeEnum({ StringValue: "1", NumericValue: 1 } as const),
    );
    expect(reorderedMixedValues).toEqual(
      describeZodSchema(z.nativeEnum({ NumericValue: 1, StringValue: "1" } as const)),
    );
    expect(reorderedMixedValues).toMatchObject({ values: [1, "1"] });
  });

  it("should reject non-finite literal and enum number values", () => {
    const descriptor = describeZodSchema(
      z.object({
        enumValue: z.nativeEnum({
          Finite: 1,
          Infinite: Number.POSITIVE_INFINITY,
        }),
        infinite: z.literal(Number.POSITIVE_INFINITY),
        nan: z.literal(Number.NaN),
      }),
    );

    expect(getSchemaDescriptorDiagnostics(descriptor)).toEqual([
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        schemaPath: ["enumValue"],
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        schemaPath: ["infinite"],
        typeName: "ZodLiteral",
      }),
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        schemaPath: ["nan"],
        typeName: "ZodLiteral",
      }),
    ]);
  });

  it("should preserve null literal values", () => {
    expect(describeZodSchema(z.literal(null))).toMatchObject({
      kind: "literal",
      value: null,
      jsonSafe: true,
    });
  });

  it("should accept only direct string schemas as JSON-safe record keys", () => {
    expect(describeZodSchema(z.record(z.string(), z.boolean()))).toMatchObject({
      kind: "record",
      typeName: "ZodRecord",
      jsonSafe: true,
      element: { kind: "boolean", jsonSafe: true },
    });

    const unsupportedKeySchemas = [
      [z.number(), "ZodNumber"],
      [z.enum(["first", "second"]), "ZodEnum"],
      [z.union([z.literal("first"), z.literal("second")]), "ZodUnion"],
      [z.string().brand<"RecordKey">(), "ZodBranded"],
    ] as const;

    for (const [keySchema, keyTypeName] of unsupportedKeySchemas) {
      const descriptor = describeZodSchema(z.record(keySchema, z.boolean()));

      expect(descriptor).toMatchObject({
        kind: "record",
        typeName: "ZodRecord",
        jsonSafe: false,
        unsupportedReason: `ZodRecord key schema ${keyTypeName} is unsupported; use z.string() for JSON object keys.`,
        element: { kind: "boolean", jsonSafe: true },
      });
      expect(getSchemaDescriptorDiagnostics(descriptor)).toEqual([
        {
          code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
          severity: "error",
          typeName: "ZodRecord",
          schemaPath: [],
          message: `ZodRecord key schema ${keyTypeName} is unsupported; use z.string() for JSON object keys.`,
        },
      ]);
    }

    const unsafeValueDescriptor = describeZodSchema(z.record(z.string(), z.date()));
    expect(unsafeValueDescriptor).toMatchObject({ kind: "record", jsonSafe: false });
    expect(getSchemaDescriptorDiagnostics(unsafeValueDescriptor)).toEqual([
      expect.objectContaining({
        code: CONTRACT_SCHEMA_JSON_UNSAFE_DIAGNOSTIC_CODE,
        typeName: "ZodDate",
        schemaPath: ["[]"],
      }),
    ]);
    expect(describeZodSchema(z.map(z.string(), z.boolean()))).toMatchObject({
      kind: "map",
      typeName: "ZodMap",
      jsonSafe: false,
    });
  });

  it("should expose the JSON-safe Zod support matrix", () => {
    expect(JSON_SAFE_ZOD_SCHEMA_SUPPORT_MATRIX).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          typeName: "ZodString",
          jsonSafe: "supported",
        }),
        expect.objectContaining({
          typeName: "ZodDate",
          jsonSafe: "unsupported",
        }),
        expect.objectContaining({
          typeName: "ZodEffects",
          jsonSafe: "supported",
        }),
      ]),
    );
  });

  it("should recognize Zod schemas structurally without accepting parse-like objects", () => {
    const schema = z.string();
    const foreignSchema = Object.assign(
      Object.create({ constructor: schema.constructor }),
      schema,
      {
        safeParse: schema.safeParse.bind(schema),
      },
    );

    expect(foreignSchema).not.toBeInstanceOf(z.ZodType);
    expect(isZodType(schema)).toBe(true);
    expect(isZodType(foreignSchema)).toBe(true);
    expect(isZodType({ safeParse: () => ({ success: true }) })).toBe(false);
    expect(isZodType({ _def: {}, transform: (value: unknown) => value })).toBe(false);
  });

  it("should detect arrays through transparent wrappers but not value-changing effects", () => {
    const tags = z.array(z.string());

    expect(isZodArraySchema(tags)).toBe(true);
    expect(isZodArraySchema(tags.optional())).toBe(true);
    expect(isZodArraySchema(tags.nullable())).toBe(true);
    expect(isZodArraySchema(tags.default([]))).toBe(true);
    expect(isZodArraySchema(tags.catch([]))).toBe(true);
    expect(isZodArraySchema(tags.brand<"Tags">())).toBe(true);
    expect(isZodArraySchema(tags.readonly())).toBe(true);
    expect(isZodArraySchema(tags.refine((value) => value.length > 0))).toBe(true);
    expect(isZodArraySchema(tags.transform((value) => value.join(",")))).toBe(false);
    expect(isZodArraySchema(z.preprocess((value) => value, tags))).toBe(false);
    expect(isZodArraySchema(z.string().optional())).toBe(false);
    expect(getZodArrayElementSchema(tags.refine((value) => value.length > 0))).toBe(tags.element);
    expect(getZodArrayElementSchema(tags.catch([]))).toBe(tags.element);
  });

  it("should classify schemas that explicitly accept repeated parameter values", () => {
    const tags = z.array(z.string());

    expect(acceptsZodArrayInput(tags)).toBe(true);
    expect(acceptsZodArrayInput(tags.optional())).toBe(true);
    expect(acceptsZodArrayInput(tags.catch([]))).toBe(true);
    expect(acceptsZodArrayInput(tags.refine((value) => value.length > 0))).toBe(true);
    expect(acceptsZodArrayInput(z.union([z.string(), tags]))).toBe(true);
    expect(acceptsZodArrayInput(z.any())).toBe(true);
    expect(acceptsZodArrayInput(z.unknown())).toBe(true);

    expect(acceptsZodArrayInput(z.string())).toBe(false);
    expect(acceptsZodArrayInput(z.coerce.string())).toBe(false);
    expect(acceptsZodArrayInput(z.coerce.boolean())).toBe(false);
    expect(acceptsZodArrayInput(z.preprocess((value) => value, z.string()))).toBe(false);
    expect(acceptsZodArrayInput(z.preprocess((value) => value, tags))).toBe(false);
  });

  it("should project unions to array-preserving parameter branches", () => {
    const tags = z.array(z.string());
    const coercingUnion = z.union([z.coerce.string(), tags]);
    const preprocessingUnion = z.union([
      z.preprocess((value) => (Array.isArray(value) ? value.join(",") : value), z.string()),
      tags,
    ]);

    const coercingProjection = getZodArrayInputSchema(coercingUnion);
    const preprocessingProjection = getZodArrayInputSchema(preprocessingUnion);

    expect(coercingProjection).toBe(getZodArrayInputSchema(coercingUnion));
    expect(coercingProjection?.safeParse(["first", "second"])).toMatchObject({
      success: true,
      data: ["first", "second"],
    });
    expect(preprocessingProjection?.safeParse(["first", "second"])).toMatchObject({
      success: true,
      data: ["first", "second"],
    });
  });

  it("should remove catch wrappers while preserving transparent parameter wrappers", () => {
    const tags = z.array(z.string());
    const optionalTags = tags.optional();
    const catchInsideOptional = tags.catch([]).optional();
    const catchInsideNullable = tags.catch([]).nullable();
    const catchOutsideOptional = optionalTags.catch([]);
    const brandedReadonly = tags.catch([]).brand<"Tags">().readonly();

    expect(unwrapZodParameterSchema(tags.catch([]))).toBe(tags);
    expect(unwrapZodParameterSchema(catchOutsideOptional)).toBe(optionalTags);
    expect(unwrapZodParameterSchema(optionalTags)).toBe(optionalTags);

    const optionalWithoutCatch = unwrapZodParameterSchema(catchInsideOptional);
    const nullableWithoutCatch = unwrapZodParameterSchema(catchInsideNullable);
    const brandedReadonlyWithoutCatch = unwrapZodParameterSchema(brandedReadonly);

    expect(optionalWithoutCatch).not.toBe(catchInsideOptional);
    expect(optionalWithoutCatch.safeParse(undefined).success).toBe(true);
    expect(optionalWithoutCatch.safeParse(["first"]).success).toBe(true);
    expect(nullableWithoutCatch.safeParse(null).success).toBe(true);
    expect(nullableWithoutCatch.safeParse(["first"]).success).toBe(true);
    expect(brandedReadonlyWithoutCatch.safeParse(["first"]).success).toBe(true);
  });

  it("should cache reconstructed parameter schemas by source reference", () => {
    const schema = z.array(z.string()).catch([]).optional();

    expect(unwrapZodParameterSchema(schema)).toBe(unwrapZodParameterSchema(schema));
  });

  it("should preserve defaults and refinements without evaluating them during catch removal", () => {
    let defaultCalls = 0;
    const withDefault = z
      .string()
      .catch("fallback")
      .default(() => {
        defaultCalls += 1;
        return "default";
      });
    const refined = z
      .string()
      .catch("fallback")
      .refine((value) => value.length >= 2, "Expected at least two characters");

    const defaultWithoutCatch = unwrapZodParameterSchema(withDefault);
    const refinementWithoutCatch = unwrapZodParameterSchema(refined);

    expect(defaultCalls).toBe(0);
    expect(defaultWithoutCatch.safeParse(undefined)).toMatchObject({
      success: true,
      data: "default",
    });
    expect(defaultCalls).toBe(1);
    expect(defaultWithoutCatch.safeParse(42).success).toBe(false);
    expect(refinementWithoutCatch.safeParse("a")).toMatchObject({
      success: false,
      error: {
        issues: [
          expect.objectContaining({
            message: "Expected at least two characters",
          }),
        ],
      },
    });
    expect(refinementWithoutCatch.safeParse(42).success).toBe(false);
  });

  it("should remove catches from ordinary unions in option order", () => {
    const schemas = [
      z.union([z.string().catch("fallback"), z.array(z.string())]),
      z.union([z.array(z.string()), z.string().catch("fallback")]),
    ];

    for (const schema of schemas) {
      const schemaWithoutCatch = unwrapZodParameterSchema(schema);

      expect(schemaWithoutCatch).not.toBe(schema);
      expect(schemaWithoutCatch.safeParse(["first", "second"])).toMatchObject({
        success: true,
        data: ["first", "second"],
      });
      expect(schemaWithoutCatch.safeParse(42).success).toBe(false);
    }
  });

  it("should not cross value-changing or discriminated-union boundaries", () => {
    const transformed = z
      .string()
      .catch("fallback")
      .transform((value) => value.length);
    const preprocessed = z.preprocess((value) => value, z.string().catch("fallback"));
    const pipeline = z.string().catch("fallback").pipe(z.string());
    const discriminated = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("first"),
        value: z.string().catch("fallback"),
      }),
      z.object({ kind: z.literal("second"), value: z.array(z.string()) }),
    ]);

    expect(unwrapZodParameterSchema(transformed)).toBe(transformed);
    expect(unwrapZodParameterSchema(preprocessed)).toBe(preprocessed);
    expect(unwrapZodParameterSchema(pipeline)).toBe(pipeline);
    expect(unwrapZodParameterSchema(discriminated)).toBe(discriminated);
  });

  it("should keep Zod internals isolated to the shared schema descriptor", () => {
    const repoRoot = join(__dirname, "../../../..");
    const sourceRoots = [
      join(repoRoot, "packages/protocols-core/src/libs"),
      join(repoRoot, "packages/rpc-codegen/src/libs"),
      join(repoRoot, "packages/openapi-spec/src/libs"),
      join(repoRoot, "packages/protocols-rest/src/libs"),
      join(repoRoot, "packages/transports-http/src/libs"),
    ];
    const allowedFile = join(repoRoot, "packages/protocols-core/src/libs/SchemaDescriptor.ts");
    const forbiddenPatterns = ["constructor.name", "._def", '"_def"', "instanceof z.ZodEffects"];
    const offenders = sourceRoots.flatMap((sourceRoot) =>
      collectTypeScriptFiles(sourceRoot)
        .filter((filePath) => filePath !== allowedFile)
        .flatMap((filePath) => {
          const content = readFileSync(filePath, "utf8");

          return forbiddenPatterns
            .filter((pattern) => content.includes(pattern))
            .map((pattern) => `${filePath.replace(`${repoRoot}/`, "")}: ${pattern}`);
        }),
    );

    expect(offenders).toEqual([]);
  });
});

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = join(directory, entry);
    const stats = statSync(filePath);

    if (stats.isDirectory()) {
      return collectTypeScriptFiles(filePath);
    }

    return filePath.endsWith(".ts") ? [filePath] : [];
  });
}

describe("wrapped object input schemas", () => {
  const input = z.object({ id: z.string(), filter: z.string().optional() });
  it("unwraps nested effects and pipeline inputs without choosing the output schema", () => {
    const output = z.object({ renamed: z.string() });
    const schema = input.transform((value) => ({ renamed: value.id })).pipe(output);
    expect(getZodInputObjectSchema(schema)).toBe(input);
    expect(getZodInputObjectSchema(z.string())).toBeUndefined();
    expect(getZodInputObjectSchema(z.object({}))).toBeDefined();
  });
  it("preserves query schema identity when input fields need no projection", () => {
    const schema = z
      .object({ tags: z.array(z.string()), count: z.number().catch(0) })
      .refine(() => true)
      .pipe(z.object({ tags: z.array(z.string()), count: z.number() }));
    expect(getZodQueryInputSchema(schema, { tags: ["one"], count: "invalid" })).toBe(schema);
  });

  it("removes array catches through pipeline input while retaining one outer transform execution", () => {
    let executions = 0;
    const schema = z
      .object({ tags: z.array(z.number()).catch([]) })
      .transform((value) => {
        executions++;
        return { renamed: value.tags };
      })
      .pipe(z.object({ renamed: z.array(z.number()) }));
    const projected = getZodQueryInputSchema(schema, { tags: ["invalid"] });
    expect(projected.safeParse({ tags: ["invalid"] }).success).toBe(false);
    expect(executions).toBe(0);
    expect(projected.parse({ tags: [1, 2] })).toEqual({ renamed: [1, 2] });
    expect(executions).toBe(1);
    expect(schema.parse({ tags: ["invalid"] })).toEqual({ renamed: [] });
  });
});
