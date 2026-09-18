import type { WebClient } from "@slack/web-api";

/** Names are presentation facts from Slack, never identity or grant evidence. */
export async function hydrateSlackProjectionNames<T extends { senderId: string }>(
  client: WebClient,
  workspaceId: string,
  messages: T[],
  read: <R>(operation: () => Promise<R>) => Promise<R>,
): Promise<Array<T & { displayName?: string }>> {
  const names = new Map<string, string>();
  // Bound optional profile work independently of message history. A missing
  // profile/scope leaves a neutral actor label; it never changes source access.
  for (const senderId of [...new Set(messages.map((message) => message.senderId))].slice(0, 100)) {
    try {
      const result = await read(() => client.users.info({ user: senderId }));
      if (!result.ok || result.user?.id !== senderId || result.user.team_id !== workspaceId)
        continue;
      const name = result.user.profile?.display_name?.trim() || result.user.real_name?.trim();
      if (name) names.set(senderId, name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160));
    } catch {
      // Optional source names cannot turn a complete roster into an access denial.
    }
  }
  return messages.map((message) => ({
    ...message,
    ...(names.has(message.senderId) ? { displayName: names.get(message.senderId) } : {}),
  }));
}
