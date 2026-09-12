import "reflect-metadata";

import { DuplicateEventFieldProblem } from "../problems/EventsProblems";

const EVENT_FIELDS_META_KEY = "@croco/events-core:event-fields";

/**
 * 이벤트 직렬화에 포함할 필드 이름을 커스터마이즈하는 데코레이터입니다.
 */
export function EventField(options?: { name?: string }): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    const existing: EventFieldMeta[] = [
      ...(Reflect.getMetadata(EVENT_FIELDS_META_KEY, target.constructor) ?? []),
    ];
    const serializedKey = options?.name ?? String(propertyKey);

    if (existing.some((field) => field.serializedKey === serializedKey)) {
      throw new DuplicateEventFieldProblem(target.constructor.name, serializedKey);
    }

    existing.push({ propertyKey: String(propertyKey), serializedKey });
    Reflect.defineMetadata(EVENT_FIELDS_META_KEY, existing, target.constructor);
  };
}

export type EventFieldMeta = {
  propertyKey: string;
  serializedKey: string;
};

/**
 * 이벤트 클래스에 등록된 직렬화 필드 메타데이터를 조회합니다.
 */
export function getEventFields(
  EventClass: new (...args: unknown[]) => unknown,
): EventFieldMeta[] | null {
  const fields: EventFieldMeta[] | undefined = Reflect.getMetadata(
    EVENT_FIELDS_META_KEY,
    EventClass,
  );
  return fields && fields.length > 0 ? fields : null;
}
