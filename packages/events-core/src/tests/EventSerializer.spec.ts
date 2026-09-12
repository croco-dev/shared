import { MetadataStorage } from "@croco/framework-context";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainEvent } from "../libs/DomainEvent";
import { EventField, getEventFields } from "../libs/decorators/EventField";
import { EventRegistry, globalEventRegistry, RegisterEvent } from "../libs/EventRegistry";
import { DefaultEventSerializer, type SerializedEvent } from "../libs/EventSerializer";
import {
  DuplicateEventFieldProblem,
  EventDeserializationError,
} from "../libs/problems/EventsProblems";

class TestEvent extends DomainEvent {
  static eventName = "TestEvent";

  @EventField()
  public readonly value: string;

  @EventField()
  public readonly count: number;

  constructor(value: string, count: number) {
    super();
    this.value = value;
    this.count = count;
  }
}

class TestEventWithAggregate extends DomainEvent {
  static eventName = "TestEventWithAggregate";

  @EventField()
  public readonly value: string;

  @EventField()
  public readonly aggregateId: string;

  constructor(value: string, aggregateId: string) {
    super();
    this.value = value;
    this.aggregateId = aggregateId;
  }
}

class ThreeFieldEvent extends DomainEvent {
  static eventName = "ThreeFieldEvent";
  constructor(
    public readonly a: string,
    public readonly b: number,
    public readonly c: boolean,
  ) {
    super();
  }
}

class RegisteredEvent extends DomainEvent {
  static eventName = "RegisteredEvent";

  @EventField()
  public readonly data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }
}

class ConstructorSensitiveEvent extends DomainEvent {
  static eventName = "ConstructorSensitiveEvent";

  @EventField()
  public readonly message: string;

  constructor(message: string) {
    super();
    this.message = message.toUpperCase();
  }
}

class ConstructorSensitiveEventWithFactory extends DomainEvent {
  static eventName = "ConstructorSensitiveEventWithFactory";

  @EventField()
  public readonly message: string;

  constructor(message: string) {
    super();
    this.message = message.toUpperCase();
  }

  static fromPayload(payload: Record<string, unknown>): ConstructorSensitiveEventWithFactory {
    return new ConstructorSensitiveEventWithFactory(String(payload.message ?? ""));
  }
}

class HostileIdentityEvent extends DomainEvent {
  static eventName = "HostileIdentityEvent";
  static reconstructionCount = 0;

  @EventField()
  public readonly value: string;

  constructor(value: string) {
    super();
    this.value = value;
  }

  static fromPayload(payload: Record<string, unknown>): HostileIdentityEvent {
    HostileIdentityEvent.reconstructionCount += 1;
    return new HostileIdentityEvent(String(payload.value ?? ""));
  }
}

class DuplicateSerializedKeyEvent extends DomainEvent {
  static eventName = "DuplicateSerializedKeyEvent";

  public readonly first: string;
  public readonly second: string;

  constructor(first: string, second: string) {
    super();
    this.first = first;
    this.second = second;
  }
}

Reflect.defineMetadata(
  "@croco/events-core:event-fields",
  [
    { propertyKey: "first", serializedKey: "shared" },
    { propertyKey: "second", serializedKey: "shared" },
  ],
  DuplicateSerializedKeyEvent,
);

describe("EventField", () => {
  it("isolates inherited metadata between sibling event classes", () => {
    class BaseUserEvent {
      @EventField()
      public readonly userId = "user-1";
    }

    expect(() => {
      class UserCreatedEvent extends BaseUserEvent {
        @EventField()
        public readonly occurredBy = "admin";
      }

      class UserUpdatedEvent extends BaseUserEvent {
        @EventField()
        public readonly occurredBy = "system";
      }

      expect(getEventFields(BaseUserEvent)).toEqual([
        { propertyKey: "userId", serializedKey: "userId" },
      ]);
      expect(getEventFields(UserCreatedEvent)).toEqual([
        { propertyKey: "userId", serializedKey: "userId" },
        { propertyKey: "occurredBy", serializedKey: "occurredBy" },
      ]);
      expect(getEventFields(UserUpdatedEvent)).toEqual([
        { propertyKey: "userId", serializedKey: "userId" },
        { propertyKey: "occurredBy", serializedKey: "occurredBy" },
      ]);
    }).not.toThrow();
  });
});

describe("DefaultEventSerializer", () => {
  let registry!: EventRegistry;
  let serializer!: DefaultEventSerializer;

  beforeEach(() => {
    registry = new EventRegistry();
    serializer = new DefaultEventSerializer(registry);
    MetadataStorage.clear();
    globalEventRegistry.clear();
  });

  describe("serialize", () => {
    it("should serialize event with all required fields", () => {
      const event = new TestEvent("hello", 42);
      const serialized = serializer.serialize(event);

      expect(serialized).toMatchObject({
        eventType: "TestEvent",
        occurredAt: expect.any(String),
        payload: {
          value: "hello",
          count: 42,
        },
      });

      expect(serialized.eventId).toBe(event.eventId);
      expect(new Date(serialized.occurredAt)).toBeInstanceOf(Date);
    });

    it("should extract aggregateId if present", () => {
      const event = new TestEventWithAggregate("test", "agg-123");
      const serialized = serializer.serialize(event);

      expect(serialized.aggregateId).toBe("agg-123");
      expect(serialized.payload).toEqual({
        value: "test",
        aggregateId: "agg-123",
      });
    });

    it("should not include eventName in payload", () => {
      const event = new TestEvent("test", 1);
      const serialized = serializer.serialize(event);

      expect(serialized.payload).not.toHaveProperty("eventName");
    });

    it("should not include eventId in payload", () => {
      const event = new TestEvent("test", 1);
      const serialized = serializer.serialize(event);

      expect(serialized.payload).not.toHaveProperty("eventId");
    });

    it("should not include timestamp in payload", () => {
      const event = new TestEvent("test", 1);
      const serialized = serializer.serialize(event);

      expect(serialized.payload).not.toHaveProperty("timestamp");
    });

    it("should generate unique eventIds", () => {
      const event1 = new TestEvent("a", 1);
      const event2 = new TestEvent("b", 2);

      const serialized1 = serializer.serialize(event1);
      const serialized2 = serializer.serialize(event2);

      expect(serialized1.eventId).not.toBe(serialized2.eventId);
    });

    it("should fail fast when duplicate serialized keys are detected during serialization", () => {
      const event = new DuplicateSerializedKeyEvent("a", "b");

      expect(() => serializer.serialize(event)).toThrow(DuplicateEventFieldProblem);
      expect(() => serializer.serialize(event)).toThrow(
        "Duplicate event field mapping detected for 'DuplicateSerializedKeyEvent' with serialized key 'shared'",
      );
    });
  });

  describe("deserialize", () => {
    beforeEach(() => {
      registry.register(TestEvent);
      registry.register(TestEventWithAggregate);
      registry.register(ConstructorSensitiveEvent);
      registry.register(ConstructorSensitiveEventWithFactory);
      registry.register(HostileIdentityEvent);
      HostileIdentityEvent.reconstructionCount = 0;
    });

    it("should deserialize event successfully", () => {
      const data: SerializedEvent = {
        eventType: "TestEvent",
        eventId: "evt_123_abc",
        occurredAt: "2026-01-02T03:04:05.000Z",
        payload: {
          value: "world",
          count: 100,
        },
      };

      const event = serializer.deserialize<TestEvent>(data);

      expect(event).toBeInstanceOf(TestEvent);
      expect(event.value).toBe("world");
      expect(event.count).toBe(100);
      expect(event.eventName).toBe("TestEvent");
      expect(event.eventId).toBe(data.eventId);
      expect(event.timestamp.toISOString()).toBe(data.occurredAt);
    });

    it("should deserialize event with aggregateId", () => {
      const data: SerializedEvent = {
        eventType: "TestEventWithAggregate",
        eventId: "evt_456_def",
        occurredAt: new Date().toISOString(),
        aggregateId: "agg-789",
        payload: {
          value: "test",
          aggregateId: "agg-789",
        },
      };

      const event = serializer.deserialize<TestEventWithAggregate>(data);

      expect(event.aggregateId).toBe("agg-789");
    });

    it("should throw error for unknown event type", () => {
      const data: SerializedEvent = {
        eventType: "UnknownEvent",
        eventId: "evt_000_xyz",
        occurredAt: new Date().toISOString(),
        payload: {},
      };

      expect(() => serializer.deserialize(data)).toThrow("Unknown event type: 'UnknownEvent'");
    });

    it.each([
      ["missing", undefined],
      ["non-string", 42],
      ["empty", ""],
      ["whitespace-only", "   "],
    ])("should reject a %s eventId before reconstructing the event", (_, eventId) => {
      const data = {
        eventType: "HostileIdentityEvent",
        eventId,
        occurredAt: "2026-01-02T03:04:05.000Z",
        payload: { value: "hostile" },
      } as unknown as SerializedEvent;

      expect(() => serializer.deserialize<HostileIdentityEvent>(data)).toThrow(
        EventDeserializationError,
      );
      expect(() => serializer.deserialize<HostileIdentityEvent>(data)).toThrow(
        "Cannot deserialize event 'HostileIdentityEvent': eventId must be a non-empty string",
      );
      expect(HostileIdentityEvent.reconstructionCount).toBe(0);
    });

    it.each([
      ["missing", undefined],
      ["non-string", 42],
      ["empty", ""],
      ["whitespace-only", "   "],
    ])("should reject a %s eventType before registry lookup", (_, eventType) => {
      const data = {
        eventType,
        eventId: "evt_hostile_identity",
        occurredAt: "2026-01-02T03:04:05.000Z",
        payload: { value: "hostile" },
      } as unknown as SerializedEvent;

      expect(() => serializer.deserialize<HostileIdentityEvent>(data)).toThrow(
        EventDeserializationError,
      );
      expect(() => serializer.deserialize<HostileIdentityEvent>(data)).toThrow(
        "Cannot deserialize event '<unknown>': eventType must be a non-empty string",
      );
      expect(HostileIdentityEvent.reconstructionCount).toBe(0);
    });

    it("should restore the validated eventId snapshot when the external envelope changes", () => {
      let eventIdAccessCount = 0;
      const data = {
        eventType: "HostileIdentityEvent",
        get eventId() {
          eventIdAccessCount += 1;
          return eventIdAccessCount === 1 ? "evt_stable_identity" : "";
        },
        occurredAt: "2026-01-02T03:04:05.000Z",
        payload: { value: "hostile" },
      } satisfies SerializedEvent;

      const event = serializer.deserialize<HostileIdentityEvent>(data);

      expect(event.eventId).toBe("evt_stable_identity");
      expect(eventIdAccessCount).toBe(1);
    });

    it("should fail fast when occurredAt is not a valid serialized timestamp", () => {
      const data: SerializedEvent = {
        eventType: "TestEvent",
        eventId: "evt_invalid_timestamp",
        occurredAt: "not-a-date",
        payload: {
          value: "world",
          count: 100,
        },
      };

      expect(() => serializer.deserialize<TestEvent>(data)).toThrow(EventDeserializationError);
      expect(() => serializer.deserialize<TestEvent>(data)).toThrow(
        "Cannot deserialize event 'TestEvent': Invalid occurredAt: not-a-date",
      );
    });

    it("BUG-79 생성자 인자가 필수인 @EventField 이벤트는 static fromPayload 없이 역직렬화되면 안 된다", () => {
      const data: SerializedEvent = {
        eventType: "ConstructorSensitiveEvent",
        eventId: "evt_bug_79",
        occurredAt: new Date().toISOString(),
        payload: {
          message: "safe payload",
        },
      };

      expect(() => serializer.deserialize<ConstructorSensitiveEvent>(data)).toThrow(
        EventDeserializationError,
      );
      expect(() => serializer.deserialize<ConstructorSensitiveEvent>(data)).toThrow(
        "Cannot deserialize event 'ConstructorSensitiveEvent': Events with required constructor arguments must provide a static fromPayload() method for deserialization.",
      );
    });

    it("should deserialize constructor-sensitive events through static fromPayload", () => {
      const data: SerializedEvent = {
        eventType: "ConstructorSensitiveEventWithFactory",
        eventId: "evt_factory_174",
        occurredAt: "2026-02-03T04:05:06.000Z",
        payload: {
          message: "safe payload",
        },
      };

      const event = serializer.deserialize<ConstructorSensitiveEventWithFactory>(data);

      expect(event).toBeInstanceOf(ConstructorSensitiveEventWithFactory);
      expect(event.message).toBe("SAFE PAYLOAD");
      expect(event.eventId).toBe(data.eventId);
      expect(event.timestamp.toISOString()).toBe(data.occurredAt);
    });

    it("should fail fast when duplicate serialized keys are detected during deserialization", () => {
      registry.register(DuplicateSerializedKeyEvent);

      const data: SerializedEvent = {
        eventType: "DuplicateSerializedKeyEvent",
        eventId: "evt_dup_1",
        occurredAt: new Date().toISOString(),
        payload: {
          shared: "value",
        },
      };

      expect(() => serializer.deserialize(data)).toThrow(DuplicateEventFieldProblem);
      expect(() => serializer.deserialize(data)).toThrow(
        "Duplicate event field mapping detected for 'DuplicateSerializedKeyEvent' with serialized key 'shared'",
      );
    });
  });

  describe("round-trip serialization", () => {
    beforeEach(() => {
      registry.register(TestEvent);
      registry.register(TestEventWithAggregate);
      registry.register(ThreeFieldEvent);
    });

    it("should preserve event data through serialize/deserialize", () => {
      const original = new TestEvent("roundtrip", 999);
      const serialized = serializer.serialize(original);
      const deserialized = serializer.deserialize<TestEvent>(serialized);

      expect(deserialized.value).toBe(original.value);
      expect(deserialized.count).toBe(original.count);
    });

    it("should handle event with multiple constructor arguments", () => {
      const original = new TestEventWithAggregate("multi", "agg-multi");
      const serialized = serializer.serialize(original);
      const deserialized = serializer.deserialize<TestEventWithAggregate>(serialized);

      expect(deserialized.value).toBe(original.value);
      expect(deserialized.aggregateId).toBe(original.aggregateId);
    });

    it("BUG-04 필드 3개 이상 이벤트의 직렬화 라운드트립에서 생성자 인자 순서를 보장해야 한다", () => {
      const original = new ThreeFieldEvent("alpha", 7, true);
      const serialized = serializer.serialize(original);

      const reorderedPayload = {
        c: serialized.payload.c,
        a: serialized.payload.a,
        b: serialized.payload.b,
      };

      expect(() =>
        serializer.deserialize<ThreeFieldEvent>({
          ...serialized,
          payload: reorderedPayload,
        }),
      ).toThrow(EventDeserializationError);
    });
  });

  describe("with global registry", () => {
    it("should use metadata-derived registry by default", () => {
      @RegisterEvent()
      class DefaultRegisteredEvent extends DomainEvent {
        static eventName = "registered.event";

        @EventField()
        public readonly data: string;

        constructor(data: string) {
          super();
          this.data = data;
        }
      }

      const defaultSerializer = new DefaultEventSerializer();

      const data: SerializedEvent = {
        eventType: "registered.event",
        eventId: "evt_global_123",
        occurredAt: new Date().toISOString(),
        payload: {
          data: "registered",
        },
      };

      const event = defaultSerializer.deserialize<DefaultRegisteredEvent>(data);

      expect(event).toBeInstanceOf(DefaultRegisteredEvent);
      expect(event.data).toBe("registered");
    });

    it("should still support explicit global registry injection", () => {
      const defaultSerializer = new DefaultEventSerializer(globalEventRegistry);

      globalEventRegistry.register(RegisteredEvent);

      const data: SerializedEvent = {
        eventType: "RegisteredEvent",
        eventId: "evt_global_123",
        occurredAt: new Date().toISOString(),
        payload: {
          data: "registered",
        },
      };

      const event = defaultSerializer.deserialize<RegisteredEvent>(data);

      expect(event).toBeInstanceOf(RegisteredEvent);
      expect(event.data).toBe("registered");
    });
  });

  describe("edge cases", () => {
    beforeEach(() => {
      registry.register(TestEvent);
    });

    it("should handle event with no custom properties", () => {
      class EmptyEvent extends DomainEvent {
        static readonly eventName = "EmptyEvent";
      }
      registry.register(EmptyEvent);

      const original = new EmptyEvent();
      const serialized = serializer.serialize(original);
      expect(() => serializer.deserialize<EmptyEvent>(serialized)).toThrow(
        EventDeserializationError,
      );
    });

    it("should handle event with complex payload values", () => {
      class ComplexEvent extends DomainEvent {
        static readonly eventName = "ComplexEvent";
        constructor(
          public readonly nested: Record<string, unknown>,
          public readonly array: number[],
        ) {
          super();
        }
      }
      registry.register(ComplexEvent);

      const original = new ComplexEvent({ key: "value" }, [1, 2, 3]);
      const serialized = serializer.serialize(original);
      expect(() => serializer.deserialize<ComplexEvent>(serialized)).toThrow(
        EventDeserializationError,
      );
    });
  });
});
