// Projects an existing canonical OpenClaw session into a Matrix room thread.
import { createHash } from "node:crypto";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig } from "../types.js";
import { resolveDefaultMatrixAccountId } from "./accounts.js";
import { sendMessageMatrix } from "./send.js";
import {
  projectionText,
  reconcileMatrixProjectionSnapshot,
  MATRIX_SESSION_PROJECTION_CONTENT_KEY,
  type SourceProjectionSnapshot,
} from "./session-projection-snapshot.js";
import {
  getMatrixThreadBindingManager,
  toSessionBindingRecord,
  listAllBindings,
} from "./thread-bindings-shared.js";

export const MATRIX_SESSION_PROJECTION_BOUND_BY = "session-projection";
export { MATRIX_SESSION_PROJECTION_CONTENT_KEY } from "./session-projection-snapshot.js";

/** Native inventory remains available after its source session is pruned. */
export function listReadOnlyMatrixSessionProjections() {
  return listAllBindings().flatMap((binding) =>
    binding.boundBy === "session-projection-read-only" && binding.parentConversationId
      ? [{ sessionKey: binding.targetSessionKey, roomId: binding.parentConversationId }]
      : [],
  );
}

const projectionCreationQueue = new KeyedAsyncQueue();
// The initial source message can be supplied by an authorized product bridge
// while its ordinary message_received hook is still in flight. Keep the two
// paths from emitting the same Matrix event in that narrow race. Matrix's
// delivery queue remains the durable retry/idempotency layer across restarts.
const projectedDeliveryKeys = new Set<string>();
const MAX_PROJECTED_DELIVERY_KEYS = 10_000;

type ProjectionRole = "user" | "assistant";

type ProjectionBinding = {
  bindingId: string;
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };
  metadata?: Record<string, unknown>;
};

type MessageHookContext = {
  channelId: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

type MessageReceivedEvent = {
  content: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

type ReplyPayloadSendingEvent = {
  kind: string;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  payload: {
    text?: string;
    isReasoning?: boolean;
    isCommentary?: boolean;
    isCompactionNotice?: boolean;
    isFallbackNotice?: boolean;
    isStatusNotice?: boolean;
  };
};

function clean(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeChannel(value: unknown): string {
  return clean(value).toLowerCase();
}

function isProjectionBinding(binding: {
  metadata?: Record<string, unknown>;
  conversation: { channel: string };
}): boolean {
  return (
    binding.conversation.channel === "matrix" &&
    [MATRIX_SESSION_PROJECTION_BOUND_BY, "session-projection-read-only"].includes(
      clean(binding.metadata?.boundBy),
    )
  );
}

function resolveDeliveryIdentity(params: {
  role: ProjectionRole;
  text: string;
  messageId?: string;
  runId?: string;
}): string | null {
  const sourceId = clean(params.messageId) || clean(params.runId);
  if (!sourceId) {
    return null;
  }
  // A final turn may be split into several payloads. The content suffix keeps
  // those parts distinct while making a replay of the same part idempotent.
  const contentId = createHash("sha256").update(params.text).digest("hex").slice(0, 16);
  return `${params.role}:${sourceId}:${contentId}`;
}

async function projectToMatrix(params: {
  cfg: CoreConfig;
  sessionKey: string;
  sourceChannel: string;
  role: ProjectionRole;
  text: string;
  messageId?: string;
  runId?: string;
  bindings?: ProjectionBinding[];
  senderId?: string;
  agentId?: string;
}): Promise<void> {
  const sourceChannel = normalizeChannel(params.sourceChannel);
  if (!sourceChannel || sourceChannel === "matrix") {
    return;
  }
  const sessionKey = clean(params.sessionKey);
  const text = params.text.trim();
  const identity = resolveDeliveryIdentity({ ...params, text });
  if (!sessionKey || !text || !identity) {
    return;
  }

  const bindingService = getSessionBindingService();
  const bindings =
    params.bindings ??
    bindingService
      .listBySession(sessionKey)
      .filter(
        (binding) =>
          isProjectionBinding(binding) &&
          binding.metadata?.boundBy !== "session-projection-read-only",
      );
  await Promise.all(
    bindings.map(async (binding) => {
      const roomId = binding.conversation.parentConversationId;
      const threadId = binding.conversation.conversationId;
      if (!roomId || !threadId) {
        return;
      }
      const deliveryScope =
        binding.metadata?.boundBy === "session-projection-read-only" ? roomId : binding.bindingId;
      const projectionKey = `${deliveryScope}:${identity}`;
      if (projectedDeliveryKeys.has(projectionKey)) {
        return;
      }
      if (projectedDeliveryKeys.size >= MAX_PROJECTED_DELIVERY_KEYS) {
        projectedDeliveryKeys.clear();
      }
      projectedDeliveryKeys.add(projectionKey);
      try {
        await sendMessageMatrix(
          `room:${roomId}`,
          projectionText({
            channel: sourceChannel,
            role: params.role,
            text,
            senderId: params.senderId,
            agentId: params.agentId,
          }),
          {
            cfg: params.cfg,
            accountId: binding.conversation.accountId,
            threadId,
            deliveryQueueId: `matrix-session-projection:${deliveryScope}:${identity}`,
            // Each content-addressed projection is one durable payload part;
            // sendMessageMatrix owns any wire-event splitting within that part.
            deliveryPartIndex: 0,
            deliveryPartCount: 1,
            extraContent: {
              [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: {
                version: 1,
                role: params.role,
                sourceChannel,
                ...(params.senderId ? { senderId: params.senderId } : {}),
                ...(params.agentId ? { agentId: params.agentId } : {}),
                ...(clean(params.messageId) ? { messageId: clean(params.messageId) } : {}),
                ...(clean(params.runId) ? { runId: clean(params.runId) } : {}),
              },
            },
          },
        );
        bindingService.touch(binding.bindingId);
      } catch (error) {
        // A transient Matrix failure must remain retryable on a later source
        // event; the reservation only protects concurrent local emitters.
        projectedDeliveryKeys.delete(projectionKey);
        throw error;
      }
    }),
  );
}

async function projectInitialMessage(params: {
  cfg: CoreConfig;
  targetSessionKey: string;
  initialMessage?: {
    sourceChannel?: string;
    content?: string;
    messageId?: string;
    runId?: string;
    role?: ProjectionRole;
    senderId?: string;
    agentId?: string;
  };
  binding?: ProjectionBinding;
}): Promise<void> {
  const initial = params.initialMessage;
  if (!initial) {
    return;
  }
  await projectToMatrix({
    cfg: params.cfg,
    sessionKey: params.targetSessionKey,
    sourceChannel: clean(initial.sourceChannel),
    role: initial.role ?? "user",
    senderId: initial.senderId,
    agentId: initial.agentId,
    text: clean(initial.content),
    messageId: clean(initial.messageId) || undefined,
    runId: clean(initial.runId) || undefined,
    ...(params.binding ? { bindings: [params.binding] } : {}),
  });
}

export async function handleMatrixSessionProjectionMessageReceived(
  event: MessageReceivedEvent,
  context: MessageHookContext,
  cfg: CoreConfig,
): Promise<void> {
  await projectToMatrix({
    cfg,
    sessionKey: event.sessionKey ?? context.sessionKey ?? "",
    sourceChannel: context.channelId,
    role: "user",
    text: event.content,
    messageId: event.messageId ?? context.messageId,
    runId: event.runId ?? context.runId,
  });
}

function isVisibleAnswerReply(event: ReplyPayloadSendingEvent): boolean {
  const text = clean(event.payload.text);
  return (
    // Completed answer chunks can own delivery in block-streaming mode;
    // the subsequent final payload may be empty or already deduplicated.
    (event.kind === "block" || event.kind === "final") &&
    Boolean(text) &&
    event.payload.isReasoning !== true &&
    event.payload.isCommentary !== true &&
    event.payload.isCompactionNotice !== true &&
    event.payload.isFallbackNotice !== true &&
    event.payload.isStatusNotice !== true &&
    !isSilentReplyPayloadText(text)
  );
}

export async function handleMatrixSessionProjectionReplyPayloadSending(
  event: ReplyPayloadSendingEvent,
  context: MessageHookContext,
  cfg: CoreConfig,
): Promise<void> {
  if (!isVisibleAnswerReply(event)) {
    return;
  }
  await projectToMatrix({
    cfg,
    sessionKey: event.sessionKey ?? context.sessionKey ?? "",
    sourceChannel: event.channel ?? context.channelId,
    role: "assistant",
    text: clean(event.payload.text),
    runId: event.runId ?? context.runId,
  });
}

type ProjectionTarget = {
  cfg: CoreConfig;
  targetSessionKey: string;
  roomId: string;
  accountId?: string;
};

function resolveProjectionTarget(params: ProjectionTarget) {
  const targetSessionKey = clean(params.targetSessionKey);
  const roomId = clean(params.roomId);
  if (!targetSessionKey || !roomId) {
    throw new Error("targetSessionKey and roomId are required");
  }
  if (!roomId.startsWith("!")) {
    throw new Error("roomId must be a Matrix room id");
  }
  if (targetSessionKey.length > 512 || roomId.length > 255) {
    throw new Error("targetSessionKey or roomId is too long");
  }
  const accountId = normalizeAccountId(
    clean(params.accountId) || resolveDefaultMatrixAccountId(params.cfg),
  );
  if (!getMatrixThreadBindingManager(accountId)) {
    throw new Error(`Matrix account ${accountId} is not running`);
  }
  const agentId = resolveSessionAgentIdStrict({ config: params.cfg, sessionKey: targetSessionKey });
  if (!getSessionEntry({ sessionKey: targetSessionKey, agentId })) {
    throw new Error("target OpenClaw session does not exist");
  }
  return { targetSessionKey, accountId, agentId, roomId };
}

function findProjectionBinding(
  target: ReturnType<typeof resolveProjectionTarget>,
  readOnly = false,
) {
  if (readOnly) {
    const shared = getMatrixThreadBindingManager(target.accountId)
      ?.listBindings?.()
      .find(
        (binding) =>
          binding.parentConversationId === target.roomId &&
          binding.boundBy === "session-projection-read-only",
      );
    if (shared) {
      return toSessionBindingRecord(shared, { idleTimeoutMs: 0, maxAgeMs: 0 });
    }
  }
  return getSessionBindingService()
    .listBySession(target.targetSessionKey)
    .find(
      (binding) =>
        isProjectionBinding(binding) &&
        binding.conversation.accountId === target.accountId &&
        binding.conversation.parentConversationId === target.roomId,
    );
}

/** Diagnostics must never create, touch, or replay a binding or its messages. */
export function inspectMatrixSessionProjection(params: ProjectionTarget) {
  const target = resolveProjectionTarget(params);
  const binding = findProjectionBinding(target);
  const { accountId, agentId, roomId } = target;
  return binding
    ? {
        status: "existing" as const,
        accountId,
        agentId,
        roomId,
        threadRootEventId: binding.conversation.conversationId,
      }
    : { status: "missing" as const, accountId, agentId, roomId };
}

export async function createMatrixSessionProjection(params: {
  cfg: CoreConfig;
  targetSessionKey: string;
  roomId: string;
  accountId?: string;
  label?: string;
  readOnly?: boolean;
  sourceSnapshot?: SourceProjectionSnapshot;
  initialMessage?: {
    sourceChannel?: string;
    content?: string;
    messageId?: string;
    runId?: string;
    role?: ProjectionRole;
    senderId?: string;
    agentId?: string;
  };
}): Promise<{
  status: "created" | "existing";
  accountId: string;
  agentId: string;
  roomId: string;
  threadRootEventId: string;
}> {
  const target = resolveProjectionTarget(params);
  const { targetSessionKey, accountId, agentId, roomId } = target;

  const label = (clean(params.label) || `${agentId} session`).slice(0, 160);
  if (params.sourceSnapshot && !params.readOnly) {
    throw new Error("Source snapshots require a read-only projection");
  }
  return await projectionCreationQueue.enqueue(
    `${accountId}\u0000${roomId}\u0000${params.readOnly ? "read-only" : targetSessionKey}`,
    async () => {
      const bindingService = getSessionBindingService();
      const existing = findProjectionBinding(target, params.readOnly);
      if (existing) {
        if (
          params.readOnly === true &&
          existing.metadata?.boundBy !== "session-projection-read-only"
        ) {
          throw new Error("Existing projection is writable");
        }
        const result = {
          status: "existing" as const,
          accountId,
          agentId,
          roomId,
          threadRootEventId: existing.conversation.conversationId,
        };
        // Retry callers may race the original hook or arrive after a prior
        // bind. The narrow in-process reservation and durable delivery key
        // make this safe without replaying any earlier transcript.
        await projectInitialMessage({
          cfg: params.cfg,
          targetSessionKey,
          initialMessage: params.initialMessage,
          binding: existing,
        });
        if (params.sourceSnapshot) {
          await reconcileMatrixProjectionSnapshot({
            cfg: params.cfg,
            accountId,
            roomId,
            threadId: result.threadRootEventId,
            snapshot: params.sourceSnapshot,
          });
        }
        return result;
      }

      const binding = await bindingService.bind({
        targetSessionKey,
        targetKind: "session",
        conversation: {
          channel: "matrix",
          accountId,
          conversationId: roomId,
        },
        placement: "child",
        metadata: {
          agentId,
          label,
          boundBy: params.readOnly
            ? "session-projection-read-only"
            : MATRIX_SESSION_PROJECTION_BOUND_BY,
          introText: `OpenClaw session mirror · ${label}`,
          // Session projections follow the canonical session lifecycle, not the
          // shorter subagent-thread defaults used by ordinary Matrix bindings.
          idleTimeoutMs: 0,
          maxAgeMs: 0,
        },
      });

      const result = {
        status: "created" as const,
        accountId,
        agentId,
        roomId,
        threadRootEventId: binding.conversation.conversationId,
      };
      await projectInitialMessage({
        cfg: params.cfg,
        targetSessionKey,
        initialMessage: params.initialMessage,
        binding,
      });
      if (params.sourceSnapshot) {
        await reconcileMatrixProjectionSnapshot({
          cfg: params.cfg,
          accountId,
          roomId,
          threadId: result.threadRootEventId,
          snapshot: params.sourceSnapshot,
        });
      }
      return result;
    },
  );
}

export async function handleMatrixSessionProjectionCreate({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  try {
    const result = await createMatrixSessionProjection({
      cfg: context.getRuntimeConfig() as CoreConfig,
      targetSessionKey: clean(params?.targetSessionKey),
      roomId: clean(params?.roomId),
      accountId: clean(params?.accountId) || undefined,
      label: clean(params?.label) || undefined,
      readOnly: params?.readOnly === true,
      sourceSnapshot: params?.sourceSnapshot as SourceProjectionSnapshot | undefined,
      initialMessage:
        params?.initialMessage && typeof params.initialMessage === "object"
          ? {
              sourceChannel: clean(
                (params.initialMessage as Record<string, unknown>).sourceChannel,
              ),
              content: clean((params.initialMessage as Record<string, unknown>).content),
              messageId: clean((params.initialMessage as Record<string, unknown>).messageId),
              runId: clean((params.initialMessage as Record<string, unknown>).runId),
              role:
                (params.initialMessage as Record<string, unknown>).role === "assistant"
                  ? "assistant"
                  : "user",
              senderId: clean((params.initialMessage as Record<string, unknown>).senderId),
              agentId: clean((params.initialMessage as Record<string, unknown>).agentId),
            }
          : undefined,
    });
    respond(true, result);
  } catch (error) {
    respond(false, { error: formatErrorMessage(error) });
  }
}

export function handleMatrixSessionProjectionInspect({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): void {
  try {
    respond(
      true,
      inspectMatrixSessionProjection({
        cfg: context.getRuntimeConfig() as CoreConfig,
        targetSessionKey: clean(params?.targetSessionKey),
        roomId: clean(params?.roomId),
        accountId: clean(params?.accountId) || undefined,
      }),
    );
  } catch (error) {
    respond(false, { error: formatErrorMessage(error) });
  }
}
