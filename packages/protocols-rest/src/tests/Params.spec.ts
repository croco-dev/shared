import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpMethod, ParamType } from "../libs/constants";
import { Controller } from "../libs/decorators/Controller";
import { Get, Post } from "../libs/decorators/HttpMethod";
import { Body, Param, Query } from "../libs/decorators/Params";
import { getParamsMeta } from "../libs/metadata/MetadataReader";
import { defineRouteContract } from "../libs/types/RouteContract";

describe("Param decorators", () => {
  it("should register param metadata", () => {
    @Controller("/users")
    class UserController {
      @Get("/:id")
      getUser(@Param("id") id: string, @Query("include") include: string) {
        return { id, include };
      }
    }

    const params = getParamsMeta(UserController, "getUser");
    expect(params).toHaveLength(2);

    const idParam = params.find((p) => p.name === "id");
    expect(idParam?.type).toBe(ParamType.PARAM);
    expect(idParam?.index).toBe(0);

    const includeParam = params.find((p) => p.name === "include");
    expect(includeParam?.type).toBe(ParamType.QUERY);
    expect(includeParam?.index).toBe(1);
  });

  it("should register body without name", () => {
    @Controller("/users")
    class UserController {
      @Get()
      create(@Body() body: unknown) {
        return body;
      }
    }

    const params = getParamsMeta(UserController, "create");
    expect(params).toHaveLength(1);
    expect(params[0].type).toBe(ParamType.BODY);
    expect(params[0].name).toBeUndefined();
  });

  it("should preserve metadata and indexes for contract-bound parameters", () => {
    const updateUser = defineRouteContract({
      method: HttpMethod.POST,
      path: "/users/:id",
      params: z.object({ id: z.string() }),
      query: z.object({ notify: z.coerce.boolean().optional() }),
      body: z.object({ name: z.string() }),
    });

    @Controller("/users")
    class UserController {
      @Post(updateUser)
      update(
        @Param(updateUser, "id") id: string,
        @Query(updateUser, "notify") notify: boolean | undefined,
        @Body(updateUser) body: { name: string },
      ) {
        return { body, id, notify };
      }
    }

    const params = getParamsMeta(UserController, "update");
    expect(params).toHaveLength(3);
    expect(params).toEqual([
      expect.objectContaining({ index: 2, type: ParamType.BODY }),
      expect.objectContaining({ index: 1, name: "notify", type: ParamType.QUERY }),
      expect.objectContaining({ index: 0, name: "id", type: ParamType.PARAM }),
    ]);
    expect(params.every((param) => param.pipes?.length === 1)).toBe(true);
  });

  it.each([
    ["refine", z.object({ id: z.string() }).refine(({ id }) => id.length > 0)],
    ["superRefine", z.object({ id: z.string() }).superRefine(() => undefined)],
    ["transform", z.object({ id: z.string() }).transform(({ id }) => ({ id: id.length }))],
    ["pipe", z.object({ id: z.string() }).pipe(z.object({ id: z.coerce.number() }))],
    [
      "nested effects",
      z
        .object({ id: z.string() })
        .refine(() => true)
        .transform(({ id }) => ({ id })),
    ],
  ])("preserves the complete %s schema for contract-bound parameters", (_name, schema) => {
    const contract = defineRouteContract({
      method: HttpMethod.GET,
      path: "/users/:id",
      params: schema,
      query: schema,
    });

    class UserController {
      getUser(@Param(contract, "id") id: unknown, @Query(contract, "id") queryId: unknown) {
        return { id, queryId };
      }
    }

    const params = getParamsMeta(UserController, "getUser");
    expect(params).toHaveLength(2);
    expect(params).toEqual([
      expect.objectContaining({
        index: 1,
        name: "id",
        type: ParamType.QUERY,
        contractSchema: schema,
      }),
      expect.objectContaining({
        index: 0,
        name: "id",
        type: ParamType.PARAM,
        contractSchema: schema,
      }),
    ]);
    expect(params.every((param) => param.pipes === undefined)).toBe(true);
  });

  it("should isolate inherited metadata between controller constructors", () => {
    class BaseController {
      handle(@Param("id") id: string, _filter?: string) {
        return id;
      }
    }

    const baseParamsBefore = [...getParamsMeta(BaseController, "handle")];

    class FirstController extends BaseController {
      override handle(id: string, @Query("search") search?: string) {
        return `${id}:${search ?? ""}`;
      }
    }

    const firstParamsBeforeSibling = [...getParamsMeta(FirstController, "handle")];

    class SecondController extends BaseController {
      override handle(id: string, @Query("page") page?: string) {
        return `${id}:${page ?? ""}`;
      }
    }

    expect(getParamsMeta(BaseController, "handle")).toEqual(baseParamsBefore);
    expect(getParamsMeta(FirstController, "handle")).toEqual(firstParamsBeforeSibling);
    expect(
      getParamsMeta(FirstController, "handle").map(({ index, name }) => ({ index, name })),
    ).toEqual([
      { index: 0, name: "id" },
      { index: 1, name: "search" },
    ]);
    expect(
      getParamsMeta(SecondController, "handle").map(({ index, name }) => ({ index, name })),
    ).toEqual([
      { index: 0, name: "id" },
      { index: 1, name: "page" },
    ]);
  });

  it("should inherit parameter metadata once while preserving decorator order and pipes", () => {
    const idSchema = z.string().uuid();
    const searchSchema = z.string().min(1);
    const bodySchema = z.object({ name: z.string() });

    class BaseController {
      update(@Param("id", idSchema) id: string, _search?: string, _body?: { name: string }) {
        return id;
      }
    }

    class DerivedController extends BaseController {
      override update(
        id: string,
        @Query("search", searchSchema) search?: string,
        @Body(bodySchema) body?: { name: string },
      ) {
        return `${id}:${search ?? ""}:${body?.name ?? ""}`;
      }
    }

    const params = getParamsMeta(DerivedController, "update");

    expect(params.map(({ index, name, type }) => ({ index, name, type }))).toEqual([
      { index: 0, name: "id", type: ParamType.PARAM },
      { index: 2, name: undefined, type: ParamType.BODY },
      { index: 1, name: "search", type: ParamType.QUERY },
    ]);
    expect(params.filter(({ index }) => index === 0)).toHaveLength(1);
    expect(params.every((param) => param.pipes?.length === 1)).toBe(true);
  });
});
