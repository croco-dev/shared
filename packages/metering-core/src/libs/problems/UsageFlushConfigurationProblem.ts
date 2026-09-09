import { Problem, ProblemCategory } from "@croco/problems-core";

export class UsageFlushConfigurationProblem extends Problem {
  constructor(reason: string) {
    super(
      "metering/usage-flush-configuration",
      ProblemCategory.InternalServerError,
      `Invalid usage flush configuration: ${reason}`,
      { extensions: { reason } },
    );
  }
}
