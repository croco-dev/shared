import { Client } from "@upstash/qstash";
import { Problem } from "@croco/problems-core";
import type {
  TaskDispatcher,
  TaskDispatchOptions,
  TaskDispatchResult,
  TaskReference,
} from "@croco/tasks-core";
import {
  QStashTaskConfigProblem,
  QStashTaskPublishProblem,
  QStashTaskValidationProblem,
} from "./problems/QStashTaskProblems";

export type QStashTaskRunnerOptions = {
  /**
   * QStash 인증 토큰입니다.
   */
  token: string;
  /**
   * 태스크 웹훅을 수신할 목적지 URL입니다.
   */
  destinationUrl: string;
  /**
   * 메시지 전달 전 기본 지연 시간입니다.
   */
  defaultDelay?: number;
  /**
   * 모든 요청에 공통으로 포함할 기본 헤더입니다.
   */
  defaultHeaders?: Record<string, string>;
};

export type QStashTaskExecuteOptions = TaskDispatchOptions;

/**
 * QStash에 태스크 메시지를 발행하는 태스크 러너입니다.
 */
export class QStashTaskRunner implements TaskDispatcher {
  private readonly client: Client;
  private readonly destinationUrl: string;
  private readonly defaultDelay?: number;
  private readonly defaultHeaders?: Record<string, string>;

  constructor(options: QStashTaskRunnerOptions) {
    validateRequiredString(options.token, "token");
    validateDestinationUrl(options.destinationUrl);
    validateDelay(options.defaultDelay, "defaultDelay");

    this.client = new Client({ token: options.token });
    this.destinationUrl = options.destinationUrl;
    this.defaultDelay = options.defaultDelay;
    this.defaultHeaders = options.defaultHeaders;
  }

  /**
   * 태스크 식별자 또는 참조와 페이로드를 QStash에 발행합니다.
   */
  async execute(
    task: string | TaskReference,
    payload: unknown,
    options?: QStashTaskExecuteOptions,
  ): Promise<TaskDispatchResult> {
    const taskId = typeof task === "string" ? task : task.name;
    validateRequiredString(taskId, "taskId");
    const delay = options?.delay ?? this.defaultDelay;
    validateDelay(delay, "delay");
    validateIdempotencyKey(options?.idempotencyKey);
    const headers = {
      ...this.defaultHeaders,
      ...options?.headers,
    };

    const response = await runQStashTaskOperation(() =>
      this.client.publishJSON({
        url: this.destinationUrl,
        body: {
          taskId,
          payload,
        },
        delay,
        headers,
        ...(options?.idempotencyKey ? { deduplicationId: options.idempotencyKey } : {}),
      }),
    );

    return { messageId: response.messageId };
  }
}

function validateRequiredString(value: string, configKey: string): void {
  if (!value || value.trim().length === 0) {
    throw new QStashTaskConfigProblem(configKey);
  }
}

function validateDestinationUrl(value: string): void {
  validateRequiredString(value, "destinationUrl");

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      throw new QStashTaskValidationProblem("QStash destinationUrl must use https.");
    }
  } catch (error) {
    if (error instanceof QStashTaskValidationProblem) {
      throw error;
    }

    throw new QStashTaskValidationProblem("QStash destinationUrl must be a valid URL.");
  }
}

function validateDelay(value: number | undefined, fieldName: string): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new QStashTaskValidationProblem(`${fieldName} must be a non-negative finite number.`);
  }
}

function validateIdempotencyKey(value: string | undefined): void {
  if (value !== undefined && value.trim().length === 0) {
    throw new QStashTaskValidationProblem("idempotencyKey must not be empty.");
  }
}

async function runQStashTaskOperation<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Problem) {
      throw error;
    }

    throw new QStashTaskPublishProblem(error);
  }
}
