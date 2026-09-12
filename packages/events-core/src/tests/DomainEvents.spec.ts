import { MetadataStorage } from "@croco/framework-context";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AggregateRoot,
  DefaultHandlerResolver,
  DomainEvent,
  EventBusConfig,
  type EventHandler,
  type EventHandlerClass,
  type HandlerResolver,
  RegisterEventHandler,
} from "../index";

class TestEvent extends DomainEvent {
  static eventName = "TestEvent";
  constructor(
    public readonly data: string,
    eventId?: string,
  ) {
    super(eventId);
  }
}

class AnotherTestEvent extends DomainEvent {
  static eventName = "AnotherTestEvent";
  constructor(public readonly value: number) {
    super();
  }
}

class TestAggregate extends AggregateRoot {
  public triggerEvent(data: string): void {
    this.addDomainEvent(new TestEvent(data));
  }

  public triggerMultipleEvents(): void {
    this.addDomainEvent(new TestEvent("first"));
    this.addDomainEvent(new AnotherTestEvent(42));
  }
}

describe("DomainEvent", () => {
  it("should have eventName equal to constructor name", () => {
    const event = new TestEvent("test");
    expect(event.eventName).toBe("TestEvent");
  });

  it("should have timestamp set automatically", () => {
    const before = new Date();
    const event = new TestEvent("test");
    const after = new Date();

    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should generate a UUID v4 eventId automatically", () => {
    const event = new TestEvent("test");

    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("should preserve an explicitly supplied logical event identity", () => {
    const event = new TestEvent("test", "logical-event-1");

    expect(event.eventId).toBe("logical-event-1");
  });

  it("should store provided data", () => {
    const event = new TestEvent("hello");
    expect(event.data).toBe("hello");
  });
});

describe("AggregateRoot", () => {
  let aggregate!: TestAggregate;

  beforeEach(() => {
    aggregate = new TestAggregate();
  });

  it("should start with no domain events", () => {
    expect(aggregate.hasDomainEvents()).toBe(false);
    expect(aggregate.getDomainEvents()).toHaveLength(0);
  });

  it("should add domain events", () => {
    aggregate.triggerEvent("test");

    expect(aggregate.hasDomainEvents()).toBe(true);
    expect(aggregate.getDomainEvents()).toHaveLength(1);
  });

  it("should return domain events in order", () => {
    aggregate.triggerMultipleEvents();

    const events = aggregate.getDomainEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(TestEvent);
    expect(events[1]).toBeInstanceOf(AnotherTestEvent);
  });

  it("should clear domain events", () => {
    aggregate.triggerEvent("test");
    expect(aggregate.hasDomainEvents()).toBe(true);

    aggregate.clearDomainEvents();
    expect(aggregate.hasDomainEvents()).toBe(false);
    expect(aggregate.getDomainEvents()).toHaveLength(0);
  });

  it("should return a copy of events array", () => {
    aggregate.triggerEvent("test");
    const events1 = aggregate.getDomainEvents();
    const events2 = aggregate.getDomainEvents();

    expect(events1).not.toBe(events2);
    expect(events1).toEqual(events2);
  });
});

describe("EventBusConfig", () => {
  let config!: EventBusConfig;

  beforeEach(() => {
    MetadataStorage.clear();
    config = EventBusConfig.getInstance();
  });

  it("should return singleton instance", () => {
    const instance1 = EventBusConfig.getInstance();
    const instance2 = EventBusConfig.getInstance();
    expect(instance1).toBe(instance2);
  });

  it("should set and get event bus", () => {
    const mockEventBus = {
      publish: async () => {},
      subscribe: () => {},
      unsubscribe: () => {},
      clear: () => {},
    };

    config.setEventBus(mockEventBus);
    expect(config.getEventBus()).toBe(mockEventBus);
  });

  it("should subscribe handlers via decorator on start", async () => {
    const subscriptions: { eventName: string; handlerClass: unknown }[] = [];
    const mockEventBus = {
      publish: async () => {},
      subscribe: (sub: { eventName: string; handlerClass: unknown }) => {
        subscriptions.push(sub);
      },
      unsubscribe: () => {},
      clear: () => {},
    };

    @RegisterEventHandler(TestEvent)
    class DecoratorTestHandler implements EventHandler<TestEvent> {
      async handle(_event: TestEvent): Promise<void> {}
    }

    config.setEventBus(mockEventBus);
    await config.start({ handlers: [DecoratorTestHandler] });

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.eventName).toBe("TestEvent");
    expect(subscriptions[0]?.handlerClass).toBe(DecoratorTestHandler);
  });

  it("should start event bus with subscriptions", async () => {
    const subscriptions: { eventName: string; handlerClass: unknown }[] = [];
    const mockEventBus = {
      publish: async () => {},
      subscribe: (sub: { eventName: string; handlerClass: unknown }) => {
        subscriptions.push(sub);
      },
      unsubscribe: () => {},
      clear: () => {},
    };

    @RegisterEventHandler(AnotherTestEvent)
    class StartTestHandler implements EventHandler<AnotherTestEvent> {
      async handle(_event: AnotherTestEvent): Promise<void> {}
    }

    config.setEventBus(mockEventBus);
    await config.start({ handlers: [StartTestHandler] });

    const anotherEventSubscription = subscriptions.find((s) => s.eventName === "AnotherTestEvent");
    expect(anotherEventSubscription).not.toBeUndefined();
  });
});

describe("HandlerResolver", () => {
  beforeEach(() => {
    const config = EventBusConfig.getInstance();
    config.getEventBus()?.clear();
  });

  describe("DefaultHandlerResolver", () => {
    it("should create handler instance using new operator", () => {
      const resolver = new DefaultHandlerResolver();
      const handlerInstance = resolver.resolve(ResolverTestHandler);

      expect(handlerInstance).toBeInstanceOf(ResolverTestHandler);
    });

    it("should create new instance each time resolve is called", () => {
      const resolver = new DefaultHandlerResolver();
      const instance1 = resolver.resolve(ResolverTestHandler);
      const instance2 = resolver.resolve(ResolverTestHandler);

      expect(instance1).not.toBe(instance2);
    });

    it("should handle events correctly", async () => {
      const resolver = new DefaultHandlerResolver();
      const handler = resolver.resolve(ResolverTestHandler);
      const event = new TestEvent("test-data");

      await expect(handler.handle(event)).resolves.not.toThrow();
    });
  });

  describe("CustomHandlerResolver", () => {
    it("should use custom resolver when provided", async () => {
      let resolveCount = 0;

      class CustomResolver implements HandlerResolver {
        resolve<T extends DomainEvent>(handlerClass: EventHandlerClass<T>): EventHandler<T> {
          resolveCount++;
          return new handlerClass();
        }
      }

      const subscriptions: { handler?: EventHandler<DomainEvent> }[] = [];
      const mockEventBus = {
        publish: async () => {},
        subscribe: (sub: { handler?: EventHandler<DomainEvent> }) => {
          subscriptions.push(sub);
        },
        unsubscribe: () => {},
        clear: () => {},
      };

      const config = EventBusConfig.getInstance();
      config.setEventBus(mockEventBus);
      config.subscribe({ eventName: "TestEvent", handlerClass: ResolverTestHandler });
      await config.start({ handlers: [], resolver: new CustomResolver() });

      const resolverTestHandlerSubscription = subscriptions.find(
        (sub) => sub.handler instanceof ResolverTestHandler,
      );
      expect(resolverTestHandlerSubscription).not.toBeUndefined();
      expect(resolveCount).toBeGreaterThanOrEqual(1);
    });

    it("should use DefaultHandlerResolver when no resolver provided", async () => {
      const subscriptions: { handler?: EventHandler<DomainEvent> }[] = [];
      const mockEventBus = {
        publish: async () => {},
        subscribe: (sub: { handler?: EventHandler<DomainEvent> }) => {
          subscriptions.push(sub);
        },
        unsubscribe: () => {},
        clear: () => {},
      };

      const config = EventBusConfig.getInstance();
      config.setEventBus(mockEventBus);
      config.subscribe({ eventName: "TestEvent", handlerClass: ResolverTestHandler });
      await config.start({ handlers: [] });

      const resolverTestHandlerSubscription = subscriptions.find(
        (sub) => sub.handler instanceof ResolverTestHandler,
      );
      expect(resolverTestHandlerSubscription).not.toBeUndefined();
    });
  });
});

class ResolverTestHandler implements EventHandler<TestEvent> {
  async handle(event: TestEvent): Promise<void> {
    console.log(`ResolverTestHandler received: ${event.data}`);
  }
}
