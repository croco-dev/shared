# @croco/dataloader-core

Request-scoped DataLoader for batching and caching requests. Solves the N+1 query problem in GraphQL and other data-fetching scenarios.

## Features

- **Automatic Batching**: Multiple `load()` calls in the same tick are batched into a single request
- **Request-Scoped Caching**: Results are cached per request context using AsyncLocalStorage
- **Type-Safe**: Full TypeScript support with generic types
- **OpenTelemetry Integration**: Automatic span creation for batch operations
- **Error Handling**: Failed batches clear cache for retry
- **Transaction-Aware**: Dynamic scoping for transaction isolation

## Installation

```bash
pnpm add @croco/dataloader-core
```

## Quick Start

```typescript
import { createBatchLoader } from "@croco/dataloader-core";

const userLoader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => {
    const users = await db.users.findMany({ where: { id: { in: ids } } });
    return ids.map((id) => users.find((u) => u.id === id) || null);
  },
});

// Automatically batches multiple loads in the same tick
const [user1, user2] = await Promise.all([userLoader.load(1), userLoader.load(2)]);
```

## Usage

### Basic Usage

```typescript
import { createBatchLoader } from "@croco/dataloader-core";

const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => {
    const users = await db.users.findByIds(ids);
    return ids.map((id) => users.get(id) ?? null);
  },
});

const user = await loader.load(123);
```

Outside `Context.run()`, each `createBatchLoader()` result retains its own lazily created
loader for batching and caching. Its cache lasts for the lifetime of that result; use
`clear()` or `clearAll()` to invalidate it, or create a separate loader per background job.
Request-context caches remain isolated from this standalone cache.

### With Context

```typescript
import { createBatchLoader } from "@croco/dataloader-core";
import { Context } from "@croco/framework-context";

await Context.run({ requestId: "req-123" }, async () => {
  const loader = createBatchLoader<number, User>({
    name: "users",
    batchFn: async (ids) => await fetchUsers(ids),
  });

  // All loads within this context share the same cache
  await loader.load(1);
  await loader.load(1); // Cached, no batch function call
});
```

### Transaction-Aware Scoping

```typescript
const orderLoader = createBatchLoader<number, Order>({
  name: "orders",
  batchFn: async (ids) => await fetchOrders(ids),
  resolveScope: () => TransactionContext.get()?.id,
});

// Different transactions get separate caches
await TransactionContext.run({ id: "tx-1" }, async () => {
  await orderLoader.load(1); // First transaction
});

await TransactionContext.run({ id: "tx-2" }, async () => {
  await orderLoader.load(1); // Second transaction, separate cache
});
```

### Batching with maxBatchSize

```typescript
const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => await fetchUsers(ids),
  maxBatchSize: 100, // Max 100 items per batch
});

// Loading 150 items results in 2 batch calls
const users = await Promise.all(Array.from({ length: 150 }, (_, i) => loader.load(i)));
```

### Disable Caching

```typescript
const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => await fetchUsers(ids),
  cache: false, // Disable caching
});

await loader.load(1);
await loader.load(1); // Both calls trigger batch function
```

### Manual Cache Management

```typescript
const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => await fetchUsers(ids),
});

// Prime cache with known value
loader.prime(1, { id: 1, name: "John" });

// Clear specific entry
loader.clear(1);

// Clear all cache
loader.clearAll();
```

## API

### createBatchLoader<K, V>(options)

Creates a request-scoped batch loader.

#### Options

- **name** (`string`): Unique name for caching the loader in request context
- **batchFn** (`BatchFn<K, V>`): Function that loads data for multiple keys. It must return a dense array with
  exactly one result per key; sparse arrays are rejected for the whole batch. An explicitly assigned `undefined`
  is a present result when `V` includes `undefined`.
- **maxBatchSize** (`number`, optional): Maximum items per batch. Must be a positive safe integer or `Infinity`
  (default: `Infinity`)
- **cache** (`boolean`, optional): Whether to cache results (default: true)
- **scope** (`string`, optional): Static scope for cache isolation
- **resolveScope** (`() => string | null | undefined`, optional): Dynamic scope function

#### Methods

- **load(key: K)**: Load a single value
- **loadMany(keys: K[])**: Load multiple values
- **clear(key: K)**: Clear cache for a specific key
- **clearAll()**: Clear all cache
- **prime(key: K, value: V | Error)**: Manually populate cache

## Error Handling

The loader handles errors in two ways:

1. **Per-Key Errors**: Return `Error` instances in the batch result for specific failures
2. **Batch-Level Errors**: Throw an error from the batch function to fail all keys

```typescript
const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => {
    return ids.map((id) => {
      if (id === -1) return new Error("Invalid ID");
      return fetchUser(id);
    });
  },
});

await loader.load(-1); // Throws Error('Invalid ID')
```

Batch-level errors clear the cache for all affected keys, allowing retries:

```typescript
const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => {
    if (Math.random() > 0.5) throw new Error("Network error");
    return fetchUsers(ids);
  },
});

try {
  await loader.load(1);
} catch (error) {
  // Cache cleared, can retry
  await loader.load(1); // Will retry batch function
}
```

## OpenTelemetry Integration

Batch operations automatically create OpenTelemetry spans:

```typescript
import { createBatchLoader } from "@croco/dataloader-core";

const loader = createBatchLoader<number, User>({
  name: "users",
  batchFn: async (ids) => await fetchUsers(ids),
});

// Each batch creates a span: "dataloader:users:batch"
await loader.load(1);
```

## License

Apache-2.0
