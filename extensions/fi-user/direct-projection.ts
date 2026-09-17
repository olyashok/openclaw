import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionEntries,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";

const DIRECT_SESSION = /^agent:(cellect-fi-user|cellect-fi-admin):slack:direct:([uw][a-z0-9]+)$/i;
type DirectReader = {
  botUserId: string;
  readDirect: (
    channelId: string,
    peerSenderId: string,
  ) => Promise<{
    directSource: { workspaceId: string; channelId: string; peerSenderId: string };
    messages: Array<{ messageId: string; senderId: string; content: string; bot: boolean }>;
  }>;
};

/** Native direct sessions remain one conversation per agent/account/peer, not per message. */
export async function reconcileSlackDirectProjections(
  api: OpenClawPluginApi,
  connection: { baseUrl: string; token: string },
  bindings: Array<{ sessionKey: string; roomId: string }>,
  signal: AbortSignal,
) {
  const config = api.runtime.config?.current?.() ?? api.config;
  const configured = (config?.bindings ?? []).filter(
    (binding) =>
      binding.match.channel === "slack" &&
      ["cellect-fi-user", "cellect-fi-admin"].includes(binding.agentId) &&
      binding.match.accountId &&
      binding.match.accountId !== "*",
  );
  const sessions = new Set(
    bindings
      .filter((binding) => DIRECT_SESSION.test(binding.sessionKey))
      .map((binding) => binding.sessionKey),
  );
  for (const agentId of new Set(configured.map((binding) => binding.agentId))) {
    for (const { sessionKey } of listSessionEntries({ agentId, readOnly: true })) {
      if (DIRECT_SESSION.test(sessionKey)) {
        sessions.add(sessionKey);
      }
    }
  }
  const report = { scanned: sessions.size, created: 0, existing: 0, skipped: 0, error: 0 };
  const post = async (body: unknown) => {
    const response = await fetch(`${connection.baseUrl}/api/openclaw-session-projection`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(70_000)]),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Fi direct projection failed (${response.status})`);
    }
    const result = (await response.json()) as { status?: unknown };
    if (
      result.status !== "created" &&
      result.status !== "existing" &&
      result.status !== "skipped"
    ) {
      throw new Error("Invalid Fi direct projection result");
    }
    return result.status;
  };
  for (const sessionKey of [...sessions].toSorted()) {
    signal.throwIfAborted();
    const [, agentId, rawPeer] = DIRECT_SESSION.exec(sessionKey) ?? [];
    if (!agentId || !rawPeer) {
      continue;
    }
    const peerSenderId = rawPeer.toUpperCase();
    const binding = bindings.find((candidate) => candidate.sessionKey === sessionKey);
    try {
      const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
      const origin = sessionDeliveryOrigin(entry);
      const accountId = origin?.accountId;
      const channelId = origin?.nativeChannelId;
      const allowed = configured.some(
        (candidate) =>
          candidate.agentId === agentId &&
          candidate.match.accountId === accountId &&
          (!candidate.match.peer || candidate.match.peer.id.toUpperCase() === peerSenderId),
      );
      if (!entry || !allowed || !accountId || !channelId?.startsWith("D")) {
        throw new Error("Direct source identity unavailable");
      }
      const reader = api.runtime.channel.runtimeContexts.get<DirectReader>({
        channelId: "slack",
        accountId,
        capability: "thread-read-projection",
      });
      if (!reader) {
        throw new Error("Direct source reader unavailable");
      }
      const source = await reader.readDirect(channelId, peerSenderId);
      const status = await post({
        discover: true,
        agentId,
        sessionKey,
        directSource: source.directSource,
        snapshot: {
          complete: true,
          messages: source.messages.map((message) => ({
            messageId: message.messageId,
            senderId: message.senderId,
            content: message.content,
            role: message.bot ? "assistant" : "user",
            agentId: message.bot && message.senderId === reader.botUserId ? agentId : undefined,
          })),
        },
      });
      report[status]++;
    } catch (error) {
      report.error++;
      if (binding) {
        await post({
          reconcile: true,
          unavailable: true,
          projectionRoomId: binding.roomId,
          agentId,
          sessionKey,
        }).catch(() => {
          api.logger.warn(
            `fi-user: failed to revoke unavailable direct projection session=${sessionKey}`,
          );
        });
      }
      api.logger.warn(
        `fi-user: direct projection session=${sessionKey} failed (${error instanceof Error ? error.message.replace(/xox[baprs]-\S+/g, "[redacted]").slice(0, 150) : "unknown"})`,
      );
    }
  }
  return report;
}
