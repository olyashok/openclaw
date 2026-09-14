import type { ChatType } from "../channels/chat-type.js";
import type { RestartSentinelContinuation } from "../infra/restart-sentinel.js";
import type {
  QueuedSessionDelivery,
  QueuedSessionDeliveryPayload,
  SessionDeliveryRoute,
} from "../infra/session-delivery-queue.records.js";

const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;

const buildRestartContinuationMessageId = (params: {
  sessionKey: string;
  kind: RestartSentinelContinuation["kind"];
  revision: number;
}) => `restart-sentinel:${params.sessionKey}:${params.kind}:${params.revision}`;

export function resolveRestartContinuationRoute(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
}): SessionDeliveryRoute | undefined {
  if (!params.channel || !params.to) {
    return undefined;
  }
  return {
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    chatType: params.chatType,
  };
}

export function resolveQueuedSessionDeliveryContext(entry: QueuedSessionDelivery):
  | {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    }
  | undefined {
  if (entry.kind === "completionFallback") {
    return undefined;
  }
  if (entry.kind === "agentTurn" && entry.route) {
    return {
      channel: entry.route.channel,
      to: entry.route.to,
      ...(entry.route.accountId ? { accountId: entry.route.accountId } : {}),
      ...(entry.route.threadId ? { threadId: entry.route.threadId } : {}),
    };
  }
  return entry.deliveryContext;
}

export function buildQueuedRestartContinuation(params: {
  sessionKey: string;
  agentId?: string;
  continuation: RestartSentinelContinuation;
  route?: SessionDeliveryRoute;
  expectedSessionId?: string;
  revision: number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  const idempotencyKey =
    params.idempotencyKey ??
    buildRestartContinuationMessageId({
      sessionKey: params.sessionKey,
      kind: params.continuation.kind,
      revision: params.revision,
    });
  if (params.continuation.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      text: params.continuation.text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      idempotencyKey,
      maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
      completionRetention: "permanent",
    };
  }
  return {
    kind: "agentTurn",
    sessionKey: params.sessionKey,
    message: params.continuation.message,
    messageId: idempotencyKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
    completionRetention: "permanent",
    ...(params.route ? { route: params.route } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey,
  };
}
