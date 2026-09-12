import { Problem, ProblemCategory } from "@croco/problems-core";
import { describe, expect, it, vi } from "vitest";
import {
  InMemorySagaStore,
  SagaExecutionFailedProblem,
  SagaRunner,
  type SagaDefinition,
  type SagaStepDefinition,
} from "../index";

class ProviderProblem extends Problem {
  constructor(detail: string) {
    super("workflow-core/test-provider-problem", ProblemCategory.InternalServerError, detail);
  }
}

describe("Saga compensation outbox", () => {
  it("automatically publishes compensation only after its terminal failure is durable", async () => {
    const store = new InMemorySagaStore();
    const published: string[] = [];
    const definition: SagaDefinition = {
      name: "durable-compensation-outbox",
      outbox: {
        publish: async (message, context) => {
          const persisted = await store.findById(context.executionId);
          expect(persisted).toMatchObject({
            status: "compensated",
            error: { message: "provision failed" },
            compensationFailures: [],
            completedAt: expect.any(Date),
          });
          expect(persisted?.steps[0]).toMatchObject({
            status: "compensated",
            outboxMessages: expect.arrayContaining([
              expect.objectContaining({
                deliveryId: message.deliveryId,
                phase: "compensation",
                status: "pending",
              }),
            ]),
          });
          published.push(message.id);
        },
      },
      steps: [
        {
          id: "reserve",
          run: (_input, { enqueueOutbox }) => {
            enqueueOutbox({ id: "reserved", topic: "reserved", payload: {} });
          },
          compensate: (_input, { enqueueOutbox }) => {
            enqueueOutbox({ id: "released", topic: "released", payload: {} });
          },
        },
        {
          id: "provision",
          run: () => {
            throw new ProviderProblem("provision failed");
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    await expect(runner.execute(definition, {})).rejects.toThrow(SagaExecutionFailedProblem);

    expect(published).toEqual(["released"]);
    const [execution] = await runner.listExecutions();
    expect(execution.steps[0]?.outboxMessages).toEqual([
      expect.objectContaining({ id: "reserved", phase: "step", status: "pending" }),
      expect.objectContaining({ id: "released", phase: "compensation", status: "published" }),
    ]);
  });

  it.each(["execute", "dispatchOutbox"] as const)(
    "recovers a compensation publish failure through %s without repeating completed effects",
    async (recovery) => {
      const runner = new SagaRunner();
      const publishAttempts: string[] = [];
      const publishFailure = new ProviderProblem("compensation publisher unavailable");
      let rejectPublish = true;
      const reserve = vi.fn<SagaStepDefinition["run"]>((_input, { enqueueOutbox }) => {
        enqueueOutbox({ id: "reserved", topic: "reserved", payload: {} });
      });
      const compensate = vi.fn<NonNullable<SagaStepDefinition["compensate"]>>(
        (_input, { enqueueOutbox }) => {
          enqueueOutbox({ id: "released", topic: "released", payload: {} });
          enqueueOutbox({ id: "refunded", topic: "refunded", payload: {} });
        },
      );
      const fail = vi.fn(() => {
        throw new ProviderProblem("provision failed");
      });
      const definition: SagaDefinition = {
        name: "recover-compensation-outbox",
        idempotencyKey: "order-1",
        outbox: {
          publish: (message) => {
            publishAttempts.push(message.deliveryId);
            if (message.id === "refunded" && rejectPublish) {
              throw publishFailure;
            }
          },
        },
        steps: [
          { id: "reserve", run: reserve, compensate },
          { id: "provision", run: fail },
        ],
      };

      await expect(runner.execute(definition, {})).rejects.toBe(publishFailure);
      const [failed] = await runner.listExecutions();
      expect(failed).toMatchObject({
        status: "compensated",
        error: { message: "provision failed" },
        compensationFailures: [],
      });
      expect(failed.steps[0]?.outboxMessages).toEqual([
        expect.objectContaining({ id: "reserved", status: "pending" }),
        expect.objectContaining({ id: "released", status: "published" }),
        expect.objectContaining({ id: "refunded", status: "pending" }),
      ]);
      const pending = failed.steps[0]?.outboxMessages[2];
      expect(pending).not.toHaveProperty("publishedAt");
      expect(publishAttempts).toHaveLength(2);

      rejectPublish = false;
      if (recovery === "execute") {
        await expect(runner.execute(definition, {})).rejects.toThrow(SagaExecutionFailedProblem);
      } else {
        await expect(runner.dispatchOutbox(definition, failed.id)).resolves.toMatchObject({
          status: "compensated",
        });
      }
      const recovered = await runner.getExecution(failed.id);
      expect(recovered.error).toEqual(failed.error);
      expect(recovered.status).toBe("compensated");
      expect(recovered.steps[0]?.outboxMessages).toEqual([
        expect.objectContaining({ id: "reserved", status: "pending" }),
        expect.objectContaining({ id: "released", status: "published" }),
        expect.objectContaining({
          id: "refunded",
          deliveryId: pending?.deliveryId,
          status: "published",
          publishedAt: expect.any(String),
        }),
      ]);
      expect(publishAttempts).toEqual([
        failed.steps[0]?.outboxMessages[1]?.deliveryId,
        pending?.deliveryId,
        pending?.deliveryId,
      ]);
      await runner.dispatchOutbox(definition, failed.id);
      expect(publishAttempts).toHaveLength(3);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(compensate).toHaveBeenCalledTimes(1);
      expect(fail).toHaveBeenCalledTimes(1);
      await expect(runner.listExecutions()).resolves.toHaveLength(1);
    },
  );

  it("dispatches successful compensation when another compensation fails", async () => {
    const store = new InMemorySagaStore();
    const published: string[] = [];
    const definition: SagaDefinition = {
      name: "partial-compensation-outbox",
      outbox: {
        publish: async (message, context) => {
          const persisted = await store.findById(context.executionId);
          expect(persisted).toMatchObject({
            status: "failed",
            error: { message: "provision failed" },
            compensationFailures: [{ message: "refund failed" }],
          });
          published.push(message.id);
        },
      },
      steps: [
        {
          id: "reserve",
          run: (_input, { enqueueOutbox }) => {
            enqueueOutbox({ id: "reserved", topic: "reserved", payload: {} });
          },
          compensate: (_input, { enqueueOutbox }) => {
            enqueueOutbox({ id: "released", topic: "released", payload: {} });
          },
        },
        {
          id: "charge",
          run: (_input, { enqueueOutbox }) => {
            enqueueOutbox({ id: "charged", topic: "charged", payload: {} });
          },
          compensate: (_input, { enqueueOutbox }) => {
            enqueueOutbox({ id: "refunded", topic: "refunded", payload: {} });
            throw new ProviderProblem("refund failed");
          },
        },
        {
          id: "provision",
          run: () => {
            throw new ProviderProblem("provision failed");
          },
        },
      ],
    };
    const runner = new SagaRunner(store);

    await expect(runner.execute(definition, {})).rejects.toMatchObject({
      code: "workflow-core/saga-execution-failed",
      extensions: expect.objectContaining({ sagaStatus: "failed" }),
    });

    expect(published).toEqual(["released"]);
    const [execution] = await runner.listExecutions();
    expect(execution.steps.map((step) => step.status)).toEqual([
      "compensated",
      "compensation_failed",
      "failed",
    ]);
    expect(execution.steps.flatMap((step) => step.outboxMessages)).toEqual([
      expect.objectContaining({ id: "reserved", status: "pending" }),
      expect.objectContaining({ id: "released", status: "published" }),
      expect.objectContaining({ id: "charged", status: "pending" }),
    ]);
    await runner.dispatchOutbox(definition, execution.id);
    expect(published).toEqual(["released"]);
  });
});
