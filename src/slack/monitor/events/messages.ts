import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { SlackAppMentionEvent, SlackMessageEvent } from "../../types.js";
import { normalizeSlackChannelType } from "../channel-type.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import type {
  SlackMessageChangedEvent,
  SlackMessageDeletedEvent,
  SlackThreadBroadcastEvent,
} from "../types.js";
import { danger } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { writeSlackDiag, writeSlackDiagKv } from "../diag.js";
import { markMessageHandled } from "./file-shared.js";
import { resolveSlackMessageSubtypeHandler } from "./message-subtype-handlers.js";
import { authorizeAndResolveSlackSystemEventContext } from "./system-event-context.js";

writeSlackDiag("diag init: messages.ts loaded");

async function hydrateAppMentionMessage(params: {
  ctx: SlackMonitorContext;
  mention: SlackAppMentionEvent;
}): Promise<SlackMessageEvent> {
  const { ctx, mention } = params;
  if (!mention.ts || !mention.channel) {
    return mention as unknown as SlackMessageEvent;
  }
  try {
    const history = await ctx.app.client.conversations.history({
      channel: mention.channel,
      latest: mention.ts,
      oldest: mention.ts,
      inclusive: true,
      limit: 1,
    });
    const candidate = history.messages?.find((m) => m.ts === mention.ts) ?? history.messages?.[0];
    if (!candidate) {
      return mention as unknown as SlackMessageEvent;
    }
    const channelInfo = await ctx.resolveChannelName(mention.channel);
    return {
      type: "message",
      user: candidate.user ?? mention.user,
      bot_id: candidate.bot_id ?? mention.bot_id,
      subtype: candidate.subtype,
      username: candidate.username,
      text: candidate.text ?? mention.text ?? "",
      ts: candidate.ts ?? mention.ts,
      thread_ts: candidate.thread_ts ?? mention.thread_ts,
      event_ts: mention.event_ts,
      parent_user_id: candidate.parent_user_id,
      channel: mention.channel,
      channel_type: mention.channel_type ?? channelInfo?.type,
      files: (candidate as { files?: SlackMessageEvent["files"] }).files,
      attachments: (candidate as { attachments?: SlackMessageEvent["attachments"] }).attachments,
    } satisfies SlackMessageEvent;
  } catch {
    return mention as unknown as SlackMessageEvent;
  }
}

export function registerSlackMessageEvents(params: {
  ctx: SlackMonitorContext;
  handleSlackMessage: SlackMessageHandler;
}) {
  const { ctx, handleSlackMessage } = params;

  const handleIncomingMessageEvent = async ({ event, body }: { event: unknown; body: unknown }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const message = event as SlackMessageEvent;
      const subtypeHandler = resolveSlackMessageSubtypeHandler(message);
      if (subtypeHandler) {
        const channelId = subtypeHandler.resolveChannelId(message);
        const ingressContext = await authorizeAndResolveSlackSystemEventContext({
          ctx,
          senderId: subtypeHandler.resolveSenderId(message),
          channelId,
          channelType: subtypeHandler.resolveChannelType(message),
          eventKind: subtypeHandler.eventKind,
        });
        if (!ingressContext) {
          return;
        }
        enqueueSystemEvent(subtypeHandler.describe(ingressContext.channelLabel), {
          sessionKey: ingressContext.sessionKey,
          contextKey: subtypeHandler.contextKey(message),
        });
        return;
      }

      await handleSlackMessage(message, { source: "message" });
      if (message.files?.length && message.ts) {
        markMessageHandled(message.ts);
      }
    } catch (err) {
      ctx.runtime.error?.(danger(`slack handler failed: ${String(err)}`));
    }
  };

  // NOTE: Slack Event Subscriptions use names like "message.channels" and
  // "message.groups" to control *which* message events are delivered, but the
  // actual event payload always arrives with `type: "message"`.  The
  // `channel_type` field ("channel" | "group" | "im" | "mpim") distinguishes
  // the source.  Bolt rejects `app.event("message.channels")` since v4.6
  // because it is a subscription label, not a valid event type.
  ctx.app.event("message", async ({ event, body }: SlackEventMiddlewareArgs<"message">) => {
    await handleIncomingMessageEvent({ event, body });
  });

  ctx.app.event("app_mention", async ({ event, body }: SlackEventMiddlewareArgs<"app_mention">) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }

      const mention = event as SlackAppMentionEvent;

      // Skip app_mention for DMs - they're already handled by message.im event
      const channelType = normalizeSlackChannelType(mention.channel_type, mention.channel);
      if (channelType === "im" || channelType === "mpim") {
        return;
      }

      const hydrated = await hydrateAppMentionMessage({ ctx, mention });
      writeSlackDiagKv("diag slack app_mention hydrated", {
        ch: hydrated.channel ?? "?",
        ts: hydrated.ts ?? hydrated.event_ts ?? "?",
        files: hydrated.files?.length ?? 0,
        subtype: hydrated.subtype ?? "-",
      });
      await handleSlackMessage(hydrated, {
        source: "app_mention",
        wasMentioned: true,
      });
      if (hydrated.files?.length && hydrated.ts) {
        markMessageHandled(hydrated.ts);
      }
    } catch (err) {
      ctx.runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
    }
  });
}
