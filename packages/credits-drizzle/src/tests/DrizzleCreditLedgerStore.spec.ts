import {
  type CreditAccountId,
  type CreditLedgerCommand,
  CreditLedgerService,
  creditAmount,
  InMemoryCreditLedgerStore,
} from "@croco/credits-core";
import { type TxAdapter, TxManager } from "@croco/tx-core";
import { describe, expect, it } from "vitest";
import {
  createCreditsSchema,
  CreditLedgerPersistenceProblem,
  type DrizzleCreditClient,
  DrizzleCreditLedgerStore,
  type DrizzleCreditTxManager,
} from "../index";

type TestClient = { readonly id: string };

function createTxManager(): TxManager<TestClient> {
  const adapter: TxAdapter<TestClient> = {
    async transaction<T>(fn: (client: TestClient) => Promise<T>): Promise<T> {
      return fn({ id: "test-client" });
    },
    async savepoint<T>(client: TestClient, fn: (client: TestClient) => Promise<T>): Promise<T> {
      return fn(client);
    },
    supportsSavepoint(): boolean {
      return true;
    },
  };

  return new TxManager(adapter);
}

class TxAwareInMemoryCreditLedgerStore extends InMemoryCreditLedgerStore {
  constructor(private readonly txManager: TxManager<TestClient>) {
    super();
  }

  override async execute(command: CreditLedgerCommand) {
    return this.txManager.run(() => super.execute(command));
  }
}

describe("DrizzleCreditLedgerStore", () => {
  it.each([
    { limit: 0, leaseMs: 60_000 },
    { limit: 1001, leaseMs: 60_000 },
    { limit: 1.5, leaseMs: 60_000 },
    { limit: 1, leaseMs: 0 },
    { limit: 1, leaseMs: -1 },
    { limit: 1, leaseMs: 1.5 },
    { limit: 1, leaseMs: Number.NaN },
    { limit: 1, leaseMs: Number.POSITIVE_INFINITY },
    { limit: 1, leaseMs: 2_147_483_648 },
  ])(
    "rejects invalid claim limit $limit or lease $leaseMs before accessing PostgreSQL",
    async ({ limit, leaseMs }) => {
      const store = new DrizzleCreditLedgerStore({} as DrizzleCreditClient, {
        getClient: () => null,
        run: async <T>(operation: () => Promise<T>) => operation(),
      });
      await expect(store.claimPendingEventIntents(limit, leaseMs)).rejects.toThrow("event intent");
    },
  );

  it("redacts driver details from read failures", async () => {
    const driverDetail = "driver detail: internal ledger table name";
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.reject(new Error(driverDetail)),
          }),
        }),
      }),
    } as unknown as DrizzleCreditClient;
    const txManager = {
      getClient: () => null,
      run: async <T>(operation: () => Promise<T>) => operation(),
    } satisfies DrizzleCreditTxManager;
    const store = new DrizzleCreditLedgerStore(db, txManager);

    const failure = await store
      .getAccount("account-redaction" as CreditAccountId)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CreditLedgerPersistenceProblem);
    expect((failure as CreditLedgerPersistenceProblem).detail).not.toContain(driverDetail);
  });

  it("redacts driver details from migration failures", async () => {
    const driverDetail = "migration driver detail: internal schema name";
    const failure = await createCreditsSchema({
      execute: () => Promise.reject(new Error(driverDetail)),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CreditLedgerPersistenceProblem);
    expect((failure as CreditLedgerPersistenceProblem).detail).not.toContain(driverDetail);
  });
});

describe("CreditLedgerService README publisher integration", () => {
  const reference = { type: "test", id: "readme-publisher" };

  async function setup() {
    const txManager = createTxManager();
    const store = new TxAwareInMemoryCreditLedgerStore(txManager);
    const setupService = new CreditLedgerService({
      store,
      eventDelivery: "development",
      idGenerator: () => "account-id",
    });
    const opened = await setupService.openAccount({
      tenantId: "tenant-readme",
      idempotencyKey: "open-readme",
      reference,
    });
    const publishedEventIds: string[] = [];
    const service = new CreditLedgerService({
      store,
      eventDelivery: "development",
      idGenerator: () => "transaction-id",
      eventPublisher: {
        onAfterCommit(publish) {
          txManager.onAfterCommit(publish);
        },
        async publishIdempotently(event) {
          publishedEventIds.push(event.eventId);
        },
      },
    });

    return { opened, publishedEventIds, service, store, txManager };
  }

  it("publishes after the adapter-owned transaction commits without an ambient transaction", async () => {
    const { opened, publishedEventIds, service, store } = await setup();

    await expect(
      service.grantCredits({
        accountId: opened.account.id,
        amount: creditAmount("10"),
        idempotencyKey: "grant-no-ambient",
        reference,
      }),
    ).resolves.toMatchObject({ replayed: false });

    expect(publishedEventIds).toHaveLength(1);
    expect(await store.listPendingEventIntents()).toHaveLength(0);
  });

  it("leaves the committed intent pending inside a plain run until explicit recovery", async () => {
    const { opened, publishedEventIds, service, store, txManager } = await setup();

    await expect(
      txManager.run(() =>
        service.grantCredits({
          accountId: opened.account.id,
          amount: creditAmount("10"),
          idempotencyKey: "grant-plain-run",
          reference,
        }),
      ),
    ).resolves.toMatchObject({ replayed: false });

    expect(publishedEventIds).toHaveLength(0);
    expect(await store.listPendingEventIntents()).toHaveLength(1);
    await expect(service.publishPendingEvents()).resolves.toBe(1);
    expect(publishedEventIds).toHaveLength(1);
    expect(await store.listPendingEventIntents()).toHaveLength(0);
  });
});
