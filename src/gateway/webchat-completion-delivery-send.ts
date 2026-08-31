// Delivers one final WebChat answer through a server-authorized channel route.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isReplyPayloadStatusNotice, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { deliverInboundReplyWithMessageSendContext } from "../channels/turn/durable-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSuppressedControlReplyText } from "./control-reply-text.js";
import {
  resolveWebchatCompletionDeliveryReason,
  WEBCHAT_COMPLETION_DELIVERY_UNREAD_GRACE_MS,
  type WebchatCompletionDeliveryState,
} from "./webchat-completion-delivery.js";

type CompletionReply = { payload: ReplyPayload; kind: "block" | "final" };

export type WebchatCompletionFallbackParams = {
  cfg: OpenClawConfig;
  state: WebchatCompletionDeliveryState | undefined;
  startedAtMs: number;
  runId: string;
  sessionId: string;
  agentId: string;
  ctx: MsgContext;
  replies: CompletionReply[];
  fallbackError?: string;
  nowMs?: number;
  log: { warn: (message: string) => void };
};

type PendingWebchatCompletion = {
  state: WebchatCompletionDeliveryState;
  sessionKey: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  timer: ReturnType<typeof setTimeout>;
};

// Active chat registrations are removed immediately after the final UI broadcast.
// Keep only the bounded delivery closure here so a reconnecting device can cancel its chase.
const pendingWebchatCompletions = new Map<string, PendingWebchatCompletion>();

export type MarkWebchatCompletionSeenResult = "seen" | "not-found" | "unauthorized";

export function markWebchatCompletionSeen(params: {
  runId?: string;
  sessionKey: string;
  requesterConnId?: string;
  requesterDeviceId?: string;
  nowMs?: number;
}): MarkWebchatCompletionSeenResult {
  const candidates = params.runId
    ? [[params.runId, pendingWebchatCompletions.get(params.runId)] as const]
    : [...pendingWebchatCompletions.entries()];
  let marked = false;
  for (const [runId, pending] of candidates) {
    if (!pending) {
      continue;
    }
    const sameOwner = pending.ownerDeviceId
      ? params.requesterDeviceId === pending.ownerDeviceId
      : Boolean(pending.ownerConnId && params.requesterConnId === pending.ownerConnId);
    if (pending.sessionKey !== params.sessionKey || !sameOwner) {
      if (params.runId) {
        return "unauthorized";
      }
      continue;
    }
    pending.state.seenAtMs = params.nowMs ?? Date.now();
    clearTimeout(pending.timer);
    pendingWebchatCompletions.delete(runId);
    marked = true;
  }
  return marked ? "seen" : "not-found";
}

export function scheduleWebchatCompletionFallback(
  params: WebchatCompletionFallbackParams & {
    sessionKey: string;
    ownerConnId?: string;
    ownerDeviceId?: string;
    unreadGraceMs?: number;
  },
): "scheduled" | "skipped" {
  const state = params.state;
  if (
    !state ||
    state.seenAtMs !== undefined ||
    state.attemptedAtMs !== undefined ||
    pendingWebchatCompletions.has(params.runId)
  ) {
    return "skipped";
  }
  state.completedAtMs = params.nowMs ?? Date.now();
  const unreadGraceMs = params.unreadGraceMs ?? WEBCHAT_COMPLETION_DELIVERY_UNREAD_GRACE_MS;
  const timer = setTimeout(
    () => {
      pendingWebchatCompletions.delete(params.runId);
      void deliverWebchatCompletionFallback({ ...params, nowMs: Date.now() }).catch(
        (error: unknown) => {
          params.log.warn(
            `webchat completion delivery crashed run=${params.runId}: ${String(error)}`,
          );
        },
      );
    },
    Math.max(0, unreadGraceMs),
  );
  timer.unref?.();
  pendingWebchatCompletions.set(params.runId, {
    state,
    sessionKey: params.sessionKey,
    ownerConnId: params.ownerConnId,
    ownerDeviceId: params.ownerDeviceId,
    timer,
  });
  return "scheduled";
}

export async function deliverWebchatCompletionFallback(
  params: WebchatCompletionFallbackParams,
): Promise<"skipped" | "handled" | "failed"> {
  const nowMs = params.nowMs ?? Date.now();
  const reason = resolveWebchatCompletionDeliveryReason({
    state: params.state,
    startedAtMs: params.startedAtMs,
    nowMs,
  });
  const state = params.state;
  if (!state || !reason) {
    return "skipped";
  }
  state.attemptedAtMs = nowMs;
  const finalEntries = params.replies.filter((item) => item.kind === "final");
  const substantiveEntries = finalEntries.filter(
    (item) => !isReplyPayloadStatusNotice(item.payload),
  );
  const candidates = substantiveEntries.length > 0 ? substantiveEntries : finalEntries;
  const replyText = uniqueStrings(
    candidates
      .map((item) => item.payload.text?.trim())
      .filter(
        (text): text is string =>
          typeof text === "string" && text.length > 0 && !isSuppressedControlReplyText(text),
      ),
  ).join("\n\n");
  const answer = params.fallbackError?.trim() || replyText;
  if (!answer) {
    params.log.warn(
      `webchat completion delivery skipped without visible reply run=${params.runId}`,
    );
    return "skipped";
  }
  const reasonText = "Sent to Slack because the Fi reply was not viewed within one minute";
  const payload: ReplyPayload = {
    text: `*Fi chat reply*\n\n${answer}\n\n_${reasonText} · Session ${params.sessionId}_`,
    ...(params.fallbackError ? { isError: true } : {}),
  };
  const route = state.route;
  const result = await deliverInboundReplyWithMessageSendContext({
    cfg: params.cfg,
    channel: route.channel,
    accountId: route.accountId,
    agentId: params.agentId,
    ctxPayload: finalizeInboundContext({
      ...params.ctx,
      OriginatingChannel: route.channel,
      OriginatingTo: route.to,
      AccountId: route.accountId,
      MessageThreadId: undefined,
      ReplyToId: undefined,
      ReplyToIdFull: undefined,
    }),
    payload,
    info: { kind: "final" },
    to: route.to,
    threadId: null,
    replyToId: null,
    requiredCapabilities: {
      text: true,
      messageSendingHooks: true,
      reconcileUnknownSend: true,
    },
  }).catch((error: unknown) => ({ status: "failed" as const, error }));
  if (result.status === "failed") {
    params.log.warn(
      `webchat completion delivery failed run=${params.runId}: ${String(result.error)}`,
    );
    return "failed";
  }
  if (result.status === "unsupported") {
    params.log.warn(
      `webchat completion delivery unsupported run=${params.runId}: ${result.reason}`,
    );
    return "failed";
  }
  return "handled";
}
