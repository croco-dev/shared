import { DomainEvent, EventBusConfig, EventPublisher, type EventHandler } from "@croco/events-core";
import { InMemoryEventBus } from "@croco/events-inmemory";
import { Container } from "@croco/framework-context";
import type { KeyedRepositoryResult, Repository } from "@croco/repository-core";
import { RetryTemplate } from "@croco/retry-core";
import { recordEvent, withSpan } from "@croco/telemetry-api";
import type { CreateUserInput, User } from "./controllers/userSchemas";
import { UserNotFoundProblem } from "./problems";

type UserRepository = Repository<User, string> & {
  list(): Promise<ReadonlyArray<User>>;
};

export class UserCreatedEvent extends DomainEvent {
  static eventName = "user.created";

  constructor(public readonly user: User) {
    super();
  }
}

class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, User>();

  constructor(seedUsers: readonly User[]) {
    for (const user of seedUsers) {
      this.users.set(user.id, user);
    }
  }

  async list(): Promise<ReadonlyArray<User>> {
    return [...this.users.values()];
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async findByIds(
    ids: readonly string[],
  ): Promise<ReadonlyArray<KeyedRepositoryResult<string, User>>> {
    return ids.flatMap((id) => {
      const user = this.users.get(id);

      return user ? [{ key: id, value: user }] : [];
    });
  }

  async save(entity: User): Promise<User> {
    this.users.set(entity.id, entity);

    return entity;
  }

  async deleteById(id: string): Promise<void> {
    this.users.delete(id);
  }
}

class UserCreatedAuditLog {
  private readonly entries: string[] = [];

  record(userId: string): void {
    this.entries.push(userId);
  }

  list(): readonly string[] {
    return this.entries;
  }
}

class UserCreatedAuditHandler implements EventHandler<UserCreatedEvent> {
  constructor(private readonly auditLog: UserCreatedAuditLog) {}

  handle(event: UserCreatedEvent): void {
    this.auditLog.record(event.user.id);
    recordEvent("starter.user_created.audit", { "user.id": event.user.id });
  }
}

class UserService {
  constructor(
    private readonly repository: UserRepository,
    private readonly publisher: EventPublisher,
    private readonly retryTemplate: RetryTemplate,
  ) {}

  async list(): Promise<ReadonlyArray<User>> {
    return await withSpan(() => this.repository.list(), { name: "starter.users.list" });
  }

  async getById(id: string): Promise<User> {
    return await withSpan(
      async () => {
        const user = await this.repository.findById(id);
        if (!user) {
          throw new UserNotFoundProblem(id);
        }

        return user;
      },
      { name: "starter.users.get" },
    );
  }

  async create(input: CreateUserInput): Promise<User> {
    return await withSpan(
      async () => {
        const user = {
          id: `user-${Date.now().toString(36)}`,
          name: input.name,
          email: input.email,
        };

        const saved = await this.retryTemplate.execute(() => this.repository.save(user));
        await this.publisher.publishNow(new UserCreatedEvent(saved));
        recordEvent("starter.user_created", { "user.id": saved.id });

        return saved;
      },
      { name: "starter.users.create" },
    );
  }

  async update(id: string, input: CreateUserInput): Promise<User> {
    return await withSpan(
      async () => {
        const existing = await this.getById(id);
        const updated = { ...existing, name: input.name, email: input.email };

        return await this.retryTemplate.execute(() => this.repository.save(updated));
      },
      { name: "starter.users.update" },
    );
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    return await withSpan(
      async () => {
        const existing = await this.repository.findById(id);
        if (!existing) {
          throw new UserNotFoundProblem(id);
        }

        await this.retryTemplate.execute(() => this.repository.deleteById(id));

        return { deleted: true };
      },
      { name: "starter.users.delete" },
    );
  }
}

type UserRuntime = {
  readonly service: UserService;
  readonly auditLog: UserCreatedAuditLog;
};

let userRuntime = createUserRuntime();

export function getUserService(): UserService {
  return userRuntime.service;
}

export function getUserAuditEntries(): readonly string[] {
  return userRuntime.auditLog.list();
}

export function resetUserRuntimeForTests(): void {
  initializeUserRuntime();
}

export function initializeUserRuntime(): void {
  userRuntime = createUserRuntime();
}

function createUserRuntime(): UserRuntime {
  const repository = new InMemoryUserRepository([
    { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
    { id: "user-2", name: "Grace Hopper", email: "grace@example.com" },
  ]);
  const auditLog = new UserCreatedAuditLog();
  const eventBusConfig = new EventBusConfig();
  const eventBus = new InMemoryEventBus({ maxConcurrency: 10 });

  EventBusConfig.setInstance(eventBusConfig);
  eventBusConfig.setEventBus(eventBus);
  Container.set(UserCreatedAuditHandler, new UserCreatedAuditHandler(auditLog));
  eventBus.subscribe({
    eventName: UserCreatedEvent.eventName,
    handlerClass: UserCreatedAuditHandler,
  });

  return {
    service: new UserService(
      repository,
      new EventPublisher(eventBusConfig),
      new RetryTemplate({ maxAttempts: 2 }),
    ),
    auditLog,
  };
}
