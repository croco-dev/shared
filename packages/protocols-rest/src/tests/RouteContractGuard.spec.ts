import { Problem, ProblemCategory } from "@croco/problems-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpMethod, isRouteContractSpec } from "../index";

class UserNotFoundProblem extends Problem {
  constructor() {
    super("users/not-found", ProblemCategory.NotFound);
  }
}

const validDeclaration = {
  problem: UserNotFoundProblem,
  code: "users/not-found",
  category: ProblemCategory.NotFound,
  status: 404,
  description: "The requested user does not exist.",
  type: "https://croco.dev/problems/users/not-found",
};

function routeContract(problems: unknown): unknown {
  return {
    method: HttpMethod.GET,
    path: "/users/:id",
    problems,
  };
}

describe("isRouteContractSpec", () => {
  it("preserves narrowing for valid Problem constructors and declarations", () => {
    const candidate: unknown = routeContract([UserNotFoundProblem, validDeclaration]);

    expect(isRouteContractSpec(candidate)).toBe(true);
    if (isRouteContractSpec(candidate)) {
      expect(candidate.problems).toHaveLength(2);
    }
  });

  it("accepts a valid anonymous Problem constructor", () => {
    const anonymousProblem = [
      class extends Problem {
        constructor() {
          super("users/anonymous", ProblemCategory.NotFound);
        }
      },
    ][0];

    expect(anonymousProblem?.name).toBe("");
    expect(isRouteContractSpec(routeContract([anonymousProblem]))).toBe(true);
  });

  it("accepts an omitted or empty Problem contract list", () => {
    expect(isRouteContractSpec({ method: HttpMethod.GET, path: "/users" })).toBe(true);
    expect(isRouteContractSpec(routeContract([]))).toBe(true);
  });

  it.each([
    [
      "missing problem",
      { code: "users/not-found", category: ProblemCategory.NotFound, status: 404 },
    ],
    [
      "missing code",
      { problem: UserNotFoundProblem, category: ProblemCategory.NotFound, status: 404 },
    ],
    ["missing category", { problem: UserNotFoundProblem, code: "users/not-found", status: 404 }],
    [
      "missing status",
      { problem: UserNotFoundProblem, code: "users/not-found", category: ProblemCategory.NotFound },
    ],
  ])("rejects declarations with %s", (_name, declaration) => {
    expect(isRouteContractSpec(routeContract([declaration]))).toBe(false);
  });

  it.each([
    ["a non-string code", { ...validDeclaration, code: 404 }],
    ["a blank code", { ...validDeclaration, code: "   " }],
    ["an unknown category", { ...validDeclaration, category: "Missing" }],
    ["a non-number status", { ...validDeclaration, status: "404" }],
    ["a non-finite status", { ...validDeclaration, status: Number.NaN }],
    ["an infinite status", { ...validDeclaration, status: Number.POSITIVE_INFINITY }],
    ["a fractional status", { ...validDeclaration, status: 404.5 }],
    ["a mismatched status", { ...validDeclaration, status: 500 }],
    ["a non-string description", { ...validDeclaration, description: 404 }],
    ["a non-string type", { ...validDeclaration, type: 404 }],
  ])("rejects declarations with %s", (_name, declaration) => {
    expect(isRouteContractSpec(routeContract([declaration]))).toBe(false);
  });

  it("rejects arrays containing both valid and invalid entries", () => {
    expect(isRouteContractSpec(routeContract([UserNotFoundProblem, validDeclaration, null]))).toBe(
      false,
    );
  });

  it("rejects sparse Problem contract arrays", () => {
    const sparseProblems: unknown[] = [];
    sparseProblems.length = 1;

    expect(isRouteContractSpec(routeContract(sparseProblems))).toBe(false);
  });

  it("validates indexed entries instead of trusting a replaced array iterator", () => {
    const problems: unknown[] = [null];
    problems[Symbol.iterator] = function* () {
      yield UserNotFoundProblem;
      return undefined;
    };

    expect(isRouteContractSpec(routeContract(problems))).toBe(false);
  });

  it("rejects Problem declarations whose fields cannot be inspected", () => {
    const declaration = {
      get problem(): unknown {
        throw new UserNotFoundProblem();
      },
    };

    expect(isRouteContractSpec(routeContract([declaration]))).toBe(false);
  });

  it.each([null, "users/not-found", class NotAProblem {}])(
    "rejects malformed Problem constructor entries",
    (problem) => {
      expect(isRouteContractSpec(routeContract([problem]))).toBe(false);
    },
  );
});

describe("wrapped route parameter schemas", () => {
  const object = z.object({ id: z.string() });

  it.each([
    object.refine(({ id }) => id.length > 0),
    object.transform(({ id }) => ({ id: id.length })),
    object.refine(() => true).pipe(object.transform(({ id }) => ({ id: id.length }))),
  ])("recognizes object wrappers without executing them", (schema) => {
    expect(
      isRouteContractSpec({
        method: HttpMethod.GET,
        path: "/users/:id",
        params: schema,
        query: schema,
      }),
    ).toBe(true);
  });

  it.each([z.string(), z.string().transform((id) => ({ id })), z.array(object), object.optional()])(
    "rejects unsupported input schemas",
    (schema) => {
      expect(
        isRouteContractSpec({ method: HttpMethod.GET, path: "/users/:id", params: schema }),
      ).toBe(false);
    },
  );
});
