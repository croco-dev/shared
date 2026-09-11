import { Problem, ProblemSerializer } from "@croco/problems-core";
import {
  createHttpProblemDetails,
  redactHttpProblemDetailsBody,
} from "../problemResponseSerializer";
import type { ProblemDetails } from "@croco/problems-core";
import type { ExceptionFilter, HttpExceptionFilterResponse } from "../interfaces/ExceptionFilter";
import type { ExecutionContext } from "../interfaces/ExecutionContext";

export type ProblemLike = Problem | ProblemDetails;
export type { HttpExceptionFilterResponse } from "../interfaces/ExceptionFilter";

function parseProblemDetails(exception: unknown, instance: string): ProblemDetails | undefined {
  if (exception instanceof Problem) {
    return createHttpProblemDetails(exception, instance);
  }

  try {
    const problem = ProblemSerializer.fromJson(exception);
    return redactHttpProblemDetailsBody(problem, { instance });
  } catch {
    return undefined;
  }
}

/**
 * 예외를 Problem Details 형식의 HTTP 응답으로 변환하는 기본 필터입니다.
 */
export class HttpExceptionFilter implements ExceptionFilter<unknown, ExecutionContext> {
  catch(exception: unknown, context: ExecutionContext): HttpExceptionFilterResponse {
    let instance: string;
    try {
      instance = context.getRequest().url;
    } catch {
      instance = context.getPath();
    }
    const problem = parseProblemDetails(exception, instance);

    if (problem) {
      return {
        status: problem.status,
        headers: { "Content-Type": "application/problem+json" },
        body: problem,
      };
    }

    return {
      status: 500,
      headers: { "Content-Type": "application/problem+json" },
      body: {
        type: "about:blank",
        title: "Internal Server Error",
        status: 500,
        code: "INTERNAL_SERVER_ERROR",
        detail: "An internal error occurred",
      },
    };
  }
}
