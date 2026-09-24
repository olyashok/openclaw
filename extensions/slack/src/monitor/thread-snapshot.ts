import type { WebClient } from "@slack/web-api";
import { hydrateSlackProjectionNames } from "./projection-actor.js";
import { slackProjectionContent } from "./projection-content.js";
import { createProjectionDeadline } from "./projection-deadline.js";

/** Complete, account-authorized source snapshot; partial pagination never grants access. */
export async function readSlackThreadSnapshot(
  client: WebClient,
  workspaceId: string,
  channelId: string,
  rootMessageId: string,
) {
  const channel = await readSlackProjectionChannel(client, workspaceId, channelId);
  return channel.readThread(rootMessageId);
}

/** One bounded sweep scope; roster is never cached across background sweeps. */
export async function readSlackProjectionChannel(
  client: WebClient,
  workspaceId: string,
  channelId: string,
) {
  const read = createProjectionDeadline();
  if (!/^T[A-Z0-9]+$/.test(workspaceId) || !/^[CG][A-Z0-9]+$/.test(channelId)) {
    throw new Error("Invalid Slack thread identity");
  }
  const identity = await read(() => client.auth.test());
  if (!identity.ok || identity.team_id !== workspaceId) {
    throw new Error("Slack reader workspace mismatch");
  }
  const memberSenderIds: string[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page = await read(() =>
      client.conversations.members({ channel: channelId, limit: 200, cursor }),
    );
    if (!page.ok || !Array.isArray(page.members)) {
      throw new Error("Slack membership unavailable");
    }
    memberSenderIds.push(...page.members);
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if (cursor && cursors.has(cursor)) {
      throw new Error("Slack membership pagination incomplete");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  const source = { workspaceId, channelId, memberSenderIds: [...new Set(memberSenderIds)] };
  const readerUserId = identity.user_id;
  const readerBotId = identity.bot_id;
  const involvesReader = (message: {
    user?: string;
    bot_id?: string;
    text?: string;
    reply_users?: string[];
  }) =>
    Boolean(
      (readerBotId && message.bot_id === readerBotId) ||
      (readerUserId &&
        (message.user === readerUserId ||
          message.reply_users?.includes(readerUserId) ||
          (message.text ?? "").includes(`<@${readerUserId}>`))),
    );
  return {
    ...source,
    readHistoryPage: async (historyCursor?: string) => {
      const page = await read(() =>
        client.conversations.history({ channel: channelId, limit: 100, cursor: historyCursor }),
      );
      if (!page.ok || !Array.isArray(page.messages)) {
        throw new Error("Slack channel history unavailable");
      }
      const nextCursor = page.response_metadata?.next_cursor?.trim() || undefined;
      if ((page.has_more && !nextCursor) || (nextCursor && nextCursor === historyCursor)) {
        throw new Error("Incomplete Slack channel history pagination");
      }
      // Only threads this bot is part of are projected: it wrote the root, was
      // mentioned in it, or replied in it. Human-only threads, and other apps'
      // posts, stay in Slack.
      return {
        roots: page.messages.flatMap((message) =>
          message.ts && involvesReader(message) ? [message.ts] : [],
        ),
        nextCursor,
      };
    },
    readThread: async (rootMessageId: string) => {
      if (!/^\d+\.\d+$/.test(rootMessageId)) {
        throw new Error("Invalid Slack thread identity");
      }
      const messages: Array<{
        messageId: string;
        senderId: string;
        content: string;
        bot: boolean;
      }> = [];
      const messageCursors = new Set<string>();
      let messageCursor: string | undefined;
      do {
        const page = await read(() =>
          client.conversations.replies({
            channel: channelId,
            ts: rootMessageId,
            limit: 100,
            cursor: messageCursor,
          }),
        );
        if (!page.ok || !Array.isArray(page.messages)) {
          throw new Error("Slack thread unavailable");
        }
        for (const message of page.messages) {
          if (message.ts && message.user && typeof message.text === "string") {
            messages.push({
              messageId: message.ts,
              senderId: message.user,
              content: slackProjectionContent(message),
              bot: Boolean(message.bot_id),
            });
          }
        }
        messageCursor = page.response_metadata?.next_cursor?.trim() || undefined;
        if (
          (page.has_more && !messageCursor) ||
          (messageCursor && messageCursors.has(messageCursor))
        ) {
          throw new Error("Slack thread pagination incomplete");
        }
        if (messageCursor) {
          messageCursors.add(messageCursor);
        }
      } while (messageCursor);
      return {
        workspaceId,
        channelId,
        rootMessageId,
        memberSenderIds: [...new Set(memberSenderIds)],
        messages: await hydrateSlackProjectionNames(client, workspaceId, messages, read),
      };
    },
  };
}
