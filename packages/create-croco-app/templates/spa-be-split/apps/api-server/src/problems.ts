import { Problem, ProblemCategory } from "@croco/problems-core";

export class InvalidEnvironmentProblem extends Problem {
  readonly code = "starter/invalid-environment";
  readonly category = ProblemCategory.ValidationError;

  constructor(detail: string) {
    super(undefined, undefined, `Invalid environment: ${detail}`);
  }
}

export class UserNotFoundProblem extends Problem {
  readonly code = "starter/user-not-found";
  readonly category = ProblemCategory.NotFound;

  constructor(id: string) {
    super(undefined, undefined, `User ${id} was not found.`);
  }
}
