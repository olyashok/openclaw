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
  type WebchatCompletionDeliveryState,
} from "./webchat-completion-delivery.js";

type CompletionReply = { payload: ReplyPayload; kind: "block" | "final" };

export async function deliverWebchatCompletionFallback(params: {
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
}): Promise<"skipped" | "handled" | "failed"> {
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
  const reasonText =
    reason === "slow"
      ? "Sent to Slack because the Fi reply took more than one minute"
      : "Sent to Slack because you left the Fi chat before it finished";
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
