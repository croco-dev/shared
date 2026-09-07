import { DefaultEventSerializer, EventRegistry } from "@croco/events-core";
import { describe, expect, it } from "vitest";
import { SubscriptionCanceledEvent } from "../libs/events/SubscriptionCanceledEvent";
import { planVersionRef } from "../libs/planVersionRef";

describe("SubscriptionCanceledEvent", () => {
  const serializer = new DefaultEventSerializer(
    new EventRegistry().register(SubscriptionCanceledEvent),
  );

  it("should retain the pinned plan and event identity through JSON serialization", () => {
    const ref = planVersionRef("pro@v1");
    const event = new SubscriptionCanceledEvent("tenant-1", "sub-1", false, "cancel-1", ref);
    const serialized = JSON.parse(JSON.stringify(serializer.serialize(event)));
    const restored = serializer.deserialize<SubscriptionCanceledEvent>(serialized);

    expect(serialized.payload.planVersionRef).toBe(ref);
    expect(restored).toBeInstanceOf(SubscriptionCanceledEvent);
    expect(restored).toMatchObject({
      tenantId: "tenant-1",
      externalSubscriptionId: "sub-1",
      cancelAtPeriodEnd: false,
      eventId: "cancel-1",
      planVersionRef: ref,
      timestamp: event.timestamp,
    });
  });

  it("should deserialize legacy payloads without a plan reference", () => {
    const restored = serializer.deserialize<SubscriptionCanceledEvent>({
      eventType: SubscriptionCanceledEvent.eventName,
      eventId: "legacy-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      payload: { tenantId: "tenant-1", externalSubscriptionId: "sub-1", cancelAtPeriodEnd: false },
    });

    expect(restored.planVersionRef).toBeUndefined();
    expect(restored.eventId).toBe("legacy-1");
    expect(restored.cancelAtPeriodEnd).toBe(false);
  });
});
