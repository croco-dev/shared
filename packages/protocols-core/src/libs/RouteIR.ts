import type {
  ProblemCategory,
  ProblemRegistryRedaction,
  ProblemRegistryVisibility,
  ProblemStatusPolicy,
} from "@croco/problems-core";
import type { z } from "zod";

export interface RouteIR {
  controllerName: string;
  methodName: string;
  httpMethod: string;
  path: string;
  sourceLocation?: RouteContractSourceLocation;
  routeContract: RouteContractIR | null;
  params: ParamIR[];
  inputSchema: z.ZodType | null;
  inputSchemas: RouteInputSchemas;
  outputSchema: z.ZodType | null;
  /** Declared successful HTTP status. Defaults to 200 for legacy RouteIR artifacts. */
  successStatus?: number;
  problemResponses?: readonly ProblemResponseIR[];
  domain: string | null;
}

export type RouteContractIR = {
  readonly id: string | null;
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly sourceLocation?: RouteContractSourceLocation;
  readonly inputSchemas: RouteInputSchemas;
  readonly outputSchema: z.ZodType | null;
  readonly problemResponsesDeclared: boolean;
  readonly problemResponses: readonly ProblemResponseIR[];
};

export type RouteContractSourceLocation = {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
};

export type RouteInputSchemas = {
  body: z.ZodType | null;
  path: z.ZodType | null;
  query: z.ZodType | null;
  headers: z.ZodType | null;
};

export interface ParamIR {
  /**
   * Original controller method argument position. Optional for compatibility with
   * pre-existing serialized RouteIR artifacts that only preserve declaration order.
   */
  index?: number;
  kind: "body" | "query" | "path" | "header" | "ctx";
  name: string;
  schema: z.ZodType | null;
  contractSchema?: z.ZodType;
  sourceLocation?: RouteContractSourceLocation;
}

export type ProblemResponseIR<
  Code extends string = string,
  Category extends ProblemCategory = ProblemCategory,
  Status extends number = number,
> = {
  readonly code: Code;
  readonly category: Category;
  readonly status: Status;
  readonly description?: string;
  readonly type?: string;
  readonly cookbookPath?: string;
  readonly registry?: ProblemRegistryReferenceIR;
  readonly routeContractProblems?: readonly ProblemResponseIR[];
};

export type ProblemRegistryReferenceIR = {
  readonly package: string;
  readonly code: string;
  readonly category: ProblemCategory;
  readonly status: number;
  readonly statusPolicy?: ProblemStatusPolicy;
  readonly retryable: boolean;
  readonly retryability: "retryable" | "not-retryable";
  readonly public: boolean;
  readonly visibility: ProblemRegistryVisibility;
  readonly redaction: ProblemRegistryRedaction;
  readonly cookbookPath: string;
};
