import { recordEvent, withSpan } from "@croco/telemetry-api";

import { resetCreditOperationsServiceForTests } from "./creditOperations";
import type {
  AdminConsoleSnapshot,
  AdminOperation,
  AdminUser,
  CreateAdminUserInput,
  TenantSummary,
} from "./controllers/adminSchemas";
import { AdminUserNotFoundProblem } from "./problems";

const DEFAULT_TENANT_ID = "tenant_acme";

const TENANTS: readonly TenantSummary[] = [
  { tenantId: "tenant_acme", name: "Acme Operations", permissionMode: "owner-managed" },
  { tenantId: "tenant_globex", name: "Globex Support", permissionMode: "support-managed" },
];

class InMemoryAdminUserStore {
  private readonly users = new Map<string, AdminUser>();
  private nextUserIndex = 10;

  constructor(seedUsers: readonly AdminUser[]) {
    for (const user of seedUsers) {
      this.users.set(user.id, user);
    }
  }

  list(tenantId: string): AdminUser[] {
    return [...this.users.values()].filter((user) => user.tenantId === tenantId);
  }

  findById(id: string, tenantId: string): AdminUser | null {
    const user = this.users.get(id);

    return user?.tenantId === tenantId ? user : null;
  }

  create(input: CreateAdminUserInput): AdminUser {
    const user: AdminUser = {
      id: `admin-user-${this.nextUserIndex}`,
      tenantId: input.tenantId,
      name: input.name,
      email: input.email,
      role: input.role,
      status: "invited",
      lastSeenAt: "pending-first-login",
    };

    this.nextUserIndex += 1;
    this.users.set(user.id, user);

    return user;
  }
}

class OperationsTimeline {
  private readonly operations: AdminOperation[];
  private nextOperationIndex = 10;

  constructor(seedOperations: readonly AdminOperation[]) {
    this.operations = [...seedOperations];
  }

  list(tenantId: string): AdminOperation[] {
    return this.operations.filter((operation) => operation.tenantId === tenantId);
  }

  record(input: Omit<AdminOperation, "id" | "occurredAt">): AdminOperation {
    const operation: AdminOperation = {
      id: `op-${this.nextOperationIndex}`,
      occurredAt: `2026-01-01T00:${String(this.nextOperationIndex).padStart(2, "0")}:00.000Z`,
      ...input,
    };

    this.nextOperationIndex += 1;
    this.operations.unshift(operation);

    return operation;
  }
}

export class AdminConsoleService {
  constructor(
    private readonly users: InMemoryAdminUserStore,
    private readonly operations: OperationsTimeline,
  ) {}

  async snapshot(tenantId = DEFAULT_TENANT_ID): Promise<AdminConsoleSnapshot> {
    return await withSpan(
      async () => ({
        tenant: resolveTenant(tenantId),
        users: this.users.list(tenantId),
        operations: this.operations.list(tenantId),
      }),
      { name: "admin.snapshot" },
    );
  }

  async listUsers(tenantId = DEFAULT_TENANT_ID): Promise<AdminUser[]> {
    return await withSpan(() => Promise.resolve(this.users.list(tenantId)), {
      name: "admin.users.list",
    });
  }

  async getUser(id: string, tenantId = DEFAULT_TENANT_ID): Promise<AdminUser> {
    return await withSpan(
      async () => {
        const user = this.users.findById(id, tenantId);
        if (!user) {
          this.operations.record({
            tenantId,
            resource: "admin-user",
            action: "user.lookup_failed",
            actor: "system",
            summary: `Lookup failed for ${id}; refresh the table or invite the user again.`,
            status: "blocked",
          });
          recordEvent("admin.user_lookup_failed", { "tenant.id": tenantId, "user.id": id });
          throw new AdminUserNotFoundProblem(id);
        }

        return user;
      },
      { name: "admin.users.get" },
    );
  }

  async createUser(input: CreateAdminUserInput): Promise<AdminUser> {
    return await withSpan(
      async () => {
        const user = this.users.create(input);
        this.operations.record({
          tenantId: input.tenantId,
          resource: "admin-user",
          action: "user.invited",
          actor: "console-admin",
          summary: `${user.email} invited as ${user.role}.`,
          status: "needs-review",
        });
        recordEvent("admin.user_invited", {
          "tenant.id": input.tenantId,
          "user.id": user.id,
        });

        return user;
      },
      { name: "admin.users.create" },
    );
  }

  async listOperations(tenantId = DEFAULT_TENANT_ID): Promise<AdminOperation[]> {
    return await withSpan(() => Promise.resolve(this.operations.list(tenantId)), {
      name: "admin.operations.list",
    });
  }
}

type AdminRuntime = {
  readonly service: AdminConsoleService;
};

let adminRuntime = createAdminRuntime();

export function getAdminConsoleService(): AdminConsoleService {
  return adminRuntime.service;
}

export function resetAdminRuntimeForTests(): void {
  initializeAdminRuntime();
}

export function initializeAdminRuntime(): void {
  adminRuntime = createAdminRuntime();
  resetCreditOperationsServiceForTests();
}

function createAdminRuntime(): AdminRuntime {
  const users = new InMemoryAdminUserStore([
    {
      id: "admin-user-1",
      tenantId: "tenant_acme",
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "owner",
      status: "active",
      lastSeenAt: "2026-01-01T09:30:00.000Z",
    },
    {
      id: "admin-user-2",
      tenantId: "tenant_acme",
      name: "Grace Hopper",
      email: "grace@example.com",
      role: "admin",
      status: "invited",
      lastSeenAt: "pending-first-login",
    },
    {
      id: "admin-user-3",
      tenantId: "tenant_globex",
      name: "Katherine Johnson",
      email: "katherine@example.com",
      role: "viewer",
      status: "active",
      lastSeenAt: "2026-01-02T11:00:00.000Z",
    },
  ]);
  const operations = new OperationsTimeline([
    {
      id: "op-1",
      tenantId: "tenant_acme",
      resource: "admin-user",
      action: "user.created",
      actor: "seed",
      summary: "Seeded owner and admin resource rows.",
      status: "succeeded",
      occurredAt: "2026-01-01T00:01:00.000Z",
    },
    {
      id: "op-2",
      tenantId: "tenant_acme",
      resource: "permissions",
      action: "permission.reviewed",
      actor: "seed",
      summary: "Verified owner-managed tenant permission mode.",
      status: "succeeded",
      occurredAt: "2026-01-01T00:02:00.000Z",
    },
    {
      id: "op-3",
      tenantId: "tenant_globex",
      resource: "admin-user",
      action: "user.created",
      actor: "seed",
      summary: "Seeded support-managed viewer row.",
      status: "succeeded",
      occurredAt: "2026-01-01T00:03:00.000Z",
    },
  ]);

  return {
    service: new AdminConsoleService(users, operations),
  };
}

function resolveTenant(tenantId: string): TenantSummary {
  return (
    TENANTS.find((tenant) => tenant.tenantId === tenantId) ?? {
      tenantId,
      name: tenantId,
      permissionMode: "support-managed",
    }
  );
}
