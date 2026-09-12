import { EventDefinitionProblem, EventDeserializationError } from "./problems/EventsProblems";

export type EventTraceContext = {
  traceId?: string;
  spanId?: string;
  traceFlags?: number;
  isValid?: boolean;
};

export type DomainEventMetadata = {
  [key: string]: unknown;
  traceContext?: EventTraceContext;
};

export abstract class DomainEvent {
  public static eventName?: string;

  public readonly eventId: string;
  public readonly eventName: string;
  public readonly timestamp: Date;
  public metadata: DomainEventMetadata;

  constructor(eventId?: string) {
    const ctor = this.constructor as typeof DomainEvent & { eventName?: string };

    if (!ctor.eventName) {
      throw new EventDefinitionProblem();
    }

    this.eventId = eventId ?? globalThis.crypto.randomUUID();
    this.eventName = ctor.eventName;
    this.timestamp = new Date();
    this.metadata = {};
  }
}

/**
 * Restores the stable identity and occurrence time of a serialized event.
 * Use only while deserializing events or reconstructing completed events for redelivery.
 */
export function restoreSerializedEventIdentity(
  event: DomainEvent,
  eventId: string,
  occurredAt: string,
): void {
  const parsedOccurredAt = new Date(occurredAt);
  if (Number.isNaN(parsedOccurredAt.getTime())) {
    throw new EventDeserializationError(event.eventName, `Invalid occurredAt: ${occurredAt}`);
  }

  const mutableEvent = event as unknown as {
    eventId: string;
    timestamp: Date;
  };

  mutableEvent.eventId = eventId;
  mutableEvent.timestamp = parsedOccurredAt;
}
