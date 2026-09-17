import type { WebClient } from "@slack/web-api";

/** Complete, account-authorized source snapshot; partial pagination never grants access. */
export async function readSlackThreadSnapshot(
  client: WebClient,
  workspaceId: string,
  channelId: string,
  rootMessageId: string,
) {
  const deadline = Date.now() + 30_000;
  const requireWithinDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error("Slack snapshot deadline exceeded");
    }
  };
  if (
    !/^T[A-Z0-9]+$/.test(workspaceId) ||
    !/^[CG][A-Z0-9]+$/.test(channelId) ||
    !/^\d+\.\d+$/.test(rootMessageId)
  ) {
    throw new Error("Invalid Slack thread identity");
  }
  const identity = await client.auth.test();
  if (!identity.ok || identity.team_id !== workspaceId) {
    throw new Error("Slack reader workspace mismatch");
  }
  const memberSenderIds: string[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    requireWithinDeadline();
    const page = await client.conversations.members({ channel: channelId, limit: 200, cursor });
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
  const messages: Array<{ messageId: string; senderId: string; content: string; bot: boolean }> =
    [];
  cursors.clear();
  do {
    requireWithinDeadline();
    const page = await client.conversations.replies({
      channel: channelId,
      ts: rootMessageId,
      limit: 100,
      cursor,
    });
    if (!page.ok || !Array.isArray(page.messages)) {
      throw new Error("Slack thread unavailable");
    }
    for (const message of page.messages) {
      if (message.ts && message.user && typeof message.text === "string") {
        messages.push({
          messageId: message.ts,
          senderId: message.user,
          content: message.text,
          bot: Boolean(message.bot_id),
        });
      }
    }
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if ((page.has_more && !cursor) || (cursor && cursors.has(cursor))) {
      throw new Error("Slack thread pagination incomplete");
    }
    if (cursor) {
      cursors.add(cursor);
    }
  } while (cursor);
  return {
    workspaceId,
    channelId,
    rootMessageId,
    memberSenderIds: [...new Set(memberSenderIds)],
    messages,
  };
}
