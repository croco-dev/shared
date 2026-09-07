import { Container } from "@croco/framework-context";
import { Problem, ProblemCategory } from "@croco/problems-core";
import { TxManager } from "@croco/tx-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDrizzleTxAdapter, createRlsTxAdapter, SavepointUnsupportedProblem } from "../index";

class NestedWriteProblem extends Problem {
  constructor() {
    super("test/nested-write-failed", ProblemCategory.InternalServerError, "inner write failed");
  }
}

function createDatabase<TClient>(client: TClient, lifecycle: string[] = []) {
  const transaction = async <T>(fn: (tx: TClient) => Promise<T>): Promise<T> => {
    try {
      const result = await fn(client);
      lifecycle.push("commit");
      return result;
    } catch (error) {
      lifecycle.push("rollback");
      throw error;
    }
  };
  return { transaction: vi.fn(transaction) as typeof transaction };
}

describe("Savepoint capability", () => {
  beforeEach(() => {
    Container.reset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should join the parent client when the active client has no transaction method", async () => {
    const client = { id: "root" };
    const db = createDatabase(client);
    const manager = new TxManager(createDrizzleTxAdapter(db));
    let parent: unknown;
    let nested: unknown;

    await manager.run(async () => {
      parent = manager.getClient();
      await manager.run(
        async () => {
          nested = manager.getClient();
        },
        { nesting: "savepoint" },
      );
    });

    expect(nested).toBe(parent);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("should commit joined writes before running nested afterCommit hooks", async () => {
    const lifecycle: string[] = [];
    const pending: string[] = [];
    const committed: string[] = [];
    const client = { insert: (value: string) => pending.push(value) };
    const db = {
      transaction: async <T>(fn: (tx: typeof client) => Promise<T>): Promise<T> => {
        const result = await fn(client);
        committed.push(...pending);
        lifecycle.push("commit");
        return result;
      },
    };
    const manager = new TxManager(createDrizzleTxAdapter(db));

    await manager.runWithOutcome(async () => {
      manager.getClient()?.insert("outer");
      await manager.run(
        async () => {
          manager.getClient()?.insert("inner");
          manager.onAfterCommit(async () => {
            lifecycle.push(`afterCommit:${committed.join(",")}`);
          });
        },
        { nesting: "savepoint" },
      );
      lifecycle.push("outer:complete");
    });

    expect(lifecycle).toEqual(["outer:complete", "commit", "afterCommit:outer,inner"]);
  });

  it("should propagate joined nested errors and roll back the root transaction", async () => {
    const lifecycle: string[] = [];
    const db = createDatabase({ id: "root" }, lifecycle);
    const manager = new TxManager(createDrizzleTxAdapter(db));
    const failure = new NestedWriteProblem();
    const afterCommit = vi.fn();

    await expect(
      manager.runWithOutcome(async () => {
        manager.onAfterCommit(afterCommit);
        await manager.run(
          async () => {
            throw failure;
          },
          { nesting: "savepoint" },
        );
      }),
    ).rejects.toBe(failure);

    expect(lifecycle).toEqual(["rollback"]);
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it("should use a savepoint when the active client supports nested transactions", async () => {
    const nested = { id: "nested" };
    const transaction = vi.fn(async <T>(fn: (tx: typeof nested) => Promise<T>) => fn(nested));
    const db = createDatabase({ id: "root", transaction });
    const manager = new TxManager(createDrizzleTxAdapter(db));

    const result = await manager.run(async () =>
      manager.run(async () => manager.getClient()?.id, { nesting: "savepoint" }),
    );

    expect(result).toBe("nested");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("should join without invoking a throwing transaction stub when support is disabled", async () => {
    const transaction = vi.fn(async () => {
      throw new SavepointUnsupportedProblem();
    });
    const client = { id: "root", transaction };
    const adapter = createDrizzleTxAdapter(createDatabase(client), { supportsSavepoint: false });
    const manager = new TxManager(adapter);

    const result = await manager.run(async () =>
      manager.run(async () => manager.getClient()?.id, { nesting: "savepoint" }),
    );

    expect(result).toBe("root");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("should reject direct savepoint calls when support is disabled", async () => {
    const transaction = vi.fn(async () => {
      throw new SavepointUnsupportedProblem();
    });
    const client = { transaction };
    const adapter = createDrizzleTxAdapter(createDatabase(client), { supportsSavepoint: false });
    const callback = vi.fn(async () => "result");

    await expect(adapter.savepoint(client, callback)).rejects.toBeInstanceOf(
      SavepointUnsupportedProblem,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it("should not advertise missing transaction methods even when support is explicitly enabled", () => {
    const client = { id: "root" };
    const adapter = createDrizzleTxAdapter(createDatabase(client), { supportsSavepoint: true });

    expect(adapter.supportsSavepoint(client)).toBe(false);
  });

  it("should recognize inherited transaction methods", async () => {
    class Client {
      id = "root";
      async transaction<T>(fn: (tx: Client) => Promise<T>): Promise<T> {
        return fn(new Client());
      }
    }
    const client = new Client();
    const adapter = createDrizzleTxAdapter(createDatabase(client));
    const manager = new TxManager(adapter);
    let nested: unknown;

    await manager.run(async () => {
      await manager.run(
        async () => {
          nested = manager.getClient();
        },
        { nesting: "savepoint" },
      );
    });

    expect(adapter.supportsSavepoint(client)).toBe(true);
    expect(nested).toBeInstanceOf(Client);
    expect(nested).not.toBe(client);
  });

  it("should forward the active client through the RLS adapter capability check", async () => {
    const execute = vi.fn(async (_query: unknown) => undefined);
    const client = { id: "rls-root", execute };
    const adapter = createRlsTxAdapter(createDatabase(client), { getTenantId: () => "tenant-1" });
    const manager = new TxManager(adapter);

    let parent: unknown;
    const result = await manager.run(async () => {
      parent = manager.getClient();
      return manager.run(async () => manager.getClient(), { nesting: "savepoint" });
    });

    expect(result).toBe(parent);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("should evaluate each client independently while retaining the historical no-client default", () => {
    type Client = { id: string; transaction?: <T>(fn: (tx: Client) => Promise<T>) => Promise<T> };
    const unsupported: Client = { id: "unsupported" };
    const supported: Client = { id: "supported", transaction: async (fn) => fn(supported) };
    const adapter = createDrizzleTxAdapter(createDatabase(unsupported));

    expect(adapter.supportsSavepoint(unsupported)).toBe(false);
    expect(adapter.supportsSavepoint(supported)).toBe(true);
    expect(adapter.supportsSavepoint(unsupported)).toBe(false);
    expect(adapter.supportsSavepoint()).toBe(true);
  });
});
