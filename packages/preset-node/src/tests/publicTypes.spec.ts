import type { Hono } from "hono";
import { describe, expectTypeOf, it } from "vitest";

import type {
  NodeEntry,
  NodeEntryCloseTimeoutProblem,
  NodeEntryLifecycleIoProblem,
  NodeEntryLifecycleProblem,
  NodeEntryOptions,
  NodeHost,
  NodeHostOptions,
  createNodeBuildTarget,
  createNodeEntry,
  createNodeHost,
  createNodeServerPreset,
} from "../index";

type NodeApp = { readonly fetch: Hono["fetch"] };
type CreateNodeEntryParameters = [honoApp: NodeApp, options?: NodeEntryOptions];

describe("public types", () => {
  it("does not expose no-op Node preset options", () => {
    expectTypeOf<typeof createNodeBuildTarget>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<typeof createNodeServerPreset>().parameters.toEqualTypeOf<[]>();
  });

  it("keeps runtime server options on the Node entry helper", () => {
    expectTypeOf<typeof createNodeHost>().parameters.toEqualTypeOf<
      [honoApp: NodeApp, options?: NodeHostOptions]
    >();
    expectTypeOf<typeof createNodeHost>().returns.toEqualTypeOf<NodeHost>();
    expectTypeOf<typeof createNodeEntry>().parameters.toEqualTypeOf<CreateNodeEntryParameters>();
    expectTypeOf<typeof createNodeEntry>().returns.toEqualTypeOf<NodeEntry>();
    expectTypeOf<NodeEntry["close"]>().toEqualTypeOf<(timeoutMs?: number) => Promise<void>>();
  });

  it("exports the deterministic lifecycle conflict Problem", () => {
    expectTypeOf<typeof NodeEntryCloseTimeoutProblem>().toBeConstructibleWith(30_000);
    expectTypeOf<typeof NodeEntryLifecycleProblem>().toBeConstructibleWith("start", "closing");
    expectTypeOf<typeof NodeEntryLifecycleProblem>().toBeConstructibleWith("start", "closed");
    expectTypeOf<typeof NodeEntryLifecycleIoProblem>().toBeConstructibleWith("start", new Error());
    expectTypeOf<typeof NodeEntryLifecycleIoProblem>().toBeConstructibleWith("close", new Error());
  });
});
