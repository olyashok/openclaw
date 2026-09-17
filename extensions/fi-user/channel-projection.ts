import { KeyedAsyncQueue, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getSessionEntry, sessionDeliveryOrigin } from "openclaw/plugin-sdk/session-store-runtime";

type SlackSnapshot = {
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  memberSenderIds: string[];
  messages: Array<{ messageId: string; senderId: string; content: string; bot: boolean }>;
};

export type SlackProjectionMessage = {
  content: string;
  sessionKey?: string;
  messageId?: string;
  runId?: string;
  senderId?: string;
};
export type SlackProjectionContext = {
  channelId: string;
  sessionKey?: string;
  messageId?: string;
  runId?: string;
  senderId?: string;
  accountId?: string;
};

const CHANNEL_SESSION =
  /^agent:(cellect-fi-user|cellect-fi-admin):slack:channel:([cg][a-z0-9]+):thread:(\d+\.\d+)$/i;
const snapshotQueue = new KeyedAsyncQueue();
type SlackThreadReader = {
  workspaceId: string;
  botUserId: string;
  readThread: (channelId: string, rootMessageId: string) => Promise<SlackSnapshot>;
};

type ChannelProjectionParams = {
  api: OpenClawPluginApi;
  sessionKey: string;
  accountId: string;
  requesterSenderId?: string;
  baseUrl: string;
  token: string;
  reconcile?: boolean;
  projectionRoomId?: string;
  signal?: AbortSignal;
  unavailable?: boolean;
};

export async function projectSlackChannelThread(params: ChannelProjectionParams): Promise<boolean> {
  const match = CHANNEL_SESSION.exec(params.sessionKey);
  const [, rawAgentId, rawChannelId, rootMessageId] = match ?? [];
  if (!rawAgentId || !rawChannelId || !rootMessageId) {
    return false;
  }
  const sourceIdentity = {
    agentId: rawAgentId.toLowerCase(),
    channelId: rawChannelId.toUpperCase(),
    rootMessageId,
  };
  const reader = params.unavailable
    ? undefined
    : params.api.runtime.channel.runtimeContexts.get<SlackThreadReader>({
        channelId: "slack",
        accountId: params.accountId,
        capability: "thread-read-projection",
      });
  // Serialize the read as well as delivery: an older snapshot must never arrive
  // after a newer one and delete its replies or restore revoked membership.
  return snapshotQueue.enqueue(
    `${reader?.workspaceId ?? params.projectionRoomId ?? params.accountId}:${sourceIdentity.channelId}:${rootMessageId}`,
    () => publishSlackThreadSnapshot(params, sourceIdentity, reader),
  );
}

async function publishSlackThreadSnapshot(
  params: ChannelProjectionParams,
  sourceIdentity: { agentId: string; channelId: string; rootMessageId: string },
  reader: SlackThreadReader | undefined,
): Promise<boolean> {
  params.signal?.throwIfAborted();
  const { agentId, channelId, rootMessageId } = sourceIdentity;
  const post = async (body: unknown) => {
    const response = await fetch(`${params.baseUrl}/api/openclaw-session-projection`, {
      method: "POST",
      signal: params.signal ?? AbortSignal.timeout(70_000),
      headers: { authorization: `Bearer ${params.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Fi channel projection failed (${response.status})`);
    }
  };
  let snapshot: SlackSnapshot;
  try {
    if (!reader) {
      throw new Error("Slack thread reader unavailable for this account");
    }
    snapshot = await reader.readThread(channelId, rootMessageId);
  } catch (error) {
    if (params.reconcile) {
      // Loss of source access removes readers, but must never be interpreted
      // as an empty message snapshot or delete mirrored history.
      await post({
        reconcile: true,
        ...(params.projectionRoomId
          ? { unavailable: true, projectionRoomId: params.projectionRoomId }
          : reader
            ? {
                source: {
                  workspaceId: reader.workspaceId,
                  channelId,
                  rootMessageId,
                  memberSenderIds: [],
                },
              }
            : {}),
        agentId,
        sessionKey: params.sessionKey,
      });
    }
    throw error;
  }
  const requesterSenderId =
    params.requesterSenderId ?? snapshot.messages.find((message) => !message.bot)?.senderId;
  if (
    !params.reconcile &&
    (!requesterSenderId || !snapshot.memberSenderIds.includes(requesterSenderId))
  ) {
    throw new Error("Slack requester is not a current channel member");
  }
  const { messages, ...source } = snapshot;
  const config = params.api.runtime.config?.current?.() ?? params.api.config;
  const botAgents = new Map<string, Set<string>>();
  for (const binding of config?.bindings ?? []) {
    if (
      binding.match.channel !== "slack" ||
      !binding.match.accountId ||
      !["cellect-fi-user", "cellect-fi-admin"].includes(binding.agentId)
    ) {
      continue;
    }
    const identity = params.api.runtime.channel.runtimeContexts.get<{
      workspaceId: string;
      botUserId: string;
    }>({
      channelId: "slack",
      accountId: binding.match.accountId,
      capability: "thread-read-projection",
    });
    if (!identity || identity.workspaceId !== snapshot.workspaceId || !identity.botUserId) {
      continue;
    }
    const agents = botAgents.get(identity.botUserId) ?? new Set<string>();
    agents.add(binding.agentId);
    botAgents.set(identity.botUserId, agents);
  }
  // Current session is authoritative even when an integration has no account binding.
  if (reader && !botAgents.has(reader.botUserId)) {
    botAgents.set(reader.botUserId, new Set([agentId]));
  }
  await post({
    requesterSenderId,
    ...(params.reconcile ? { reconcile: true } : {}),
    agentId,
    sessionKey: params.sessionKey,
    source,
    snapshot: {
      complete: true,
      messages: messages.map((message) => ({
        messageId: message.messageId,
        senderId: message.senderId,
        content: message.content,
        role: message.bot ? "assistant" : "user",
        agentId:
          message.bot && botAgents.get(message.senderId)?.size === 1
            ? botAgents.get(message.senderId)?.values().next().value
            : undefined,
      })),
    },
  });
  return true;
}

export function registerSlackChannelProjection(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string },
) {
  registerSlackProjectionReconciler(api, connection);
  api.registerGatewayMethod(
    "fi.slackProjection.sync",
    async ({ params, respond }) => {
      const { baseUrl, token } = connection();
      try {
        if (
          !token ||
          typeof params?.sessionKey !== "string" ||
          typeof params.accountId !== "string" ||
          typeof params.requesterSenderId !== "string"
        ) {
          throw new Error("Missing Slack projection parameters");
        }
        const projected = await projectSlackChannelThread({
          api,
          token,
          baseUrl,
          sessionKey: params.sessionKey,
          accountId: params.accountId,
          requesterSenderId: params.requesterSenderId,
        });
        if (!projected) {
          throw new Error("Unsupported Slack channel session");
        }
        respond(true, { projected: true });
      } catch (error) {
        respond(false, {
          error: error instanceof Error ? error.message : "Slack projection failed",
        });
      }
    },
    { scope: "operator.admin" },
  );
  api.on("message_sent", async (event, context) => {
    if (!event.success || context.channelId !== "slack" || !context.accountId) {
      return;
    }
    const sessionKey = event.sessionKey ?? context.sessionKey;
    const { baseUrl, token } = connection();
    if (!sessionKey || !token) {
      return;
    }
    void projectSlackChannelThread({
      api,
      token,
      baseUrl,
      sessionKey,
      accountId: context.accountId,
    }).catch(() => {
      api.logger.warn("fi-user: channel projection failed after Slack delivery");
    });
  });
}

/** Reconstruct work from durable session/binding stores; no timer state is authoritative. */
export function registerSlackProjectionReconciler(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let stopped = true;
  const reconcile = async () => {
    const generation = controller;
    if (!generation) {
      return;
    }
    try {
      const config = connection();
      if (!config.token) {
        return;
      }
      const inventory = api.runtime.channel.runtimeContexts.get<{
        list: () => Promise<Array<{ sessionKey: string; roomId: string }>>;
      }>({ channelId: "matrix", capability: "session-read-projections" });
      if (!inventory) {
        throw new Error("Matrix projection inventory unavailable");
      }
      for (const { sessionKey, roomId } of await inventory.list()) {
        if (stopped || controller !== generation) {
          return;
        }
        const agentId = CHANNEL_SESSION.exec(sessionKey)?.[1];
        if (!agentId) {
          continue;
        }
        const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
        const accountId = sessionDeliveryOrigin(entry)?.accountId;
        try {
          await projectSlackChannelThread({
            api,
            ...config,
            token: config.token,
            sessionKey,
            accountId: accountId ?? "unavailable",
            unavailable: !entry || !accountId,
            reconcile: true,
            projectionRoomId: roomId,
            signal: AbortSignal.any([generation.signal, AbortSignal.timeout(90_000)]),
          });
        } catch (error) {
          const detail =
            error instanceof Error
              ? error.message
                  .replace(/xox[baprs]-\S+/g, "[redacted]")
                  .replace(/\s+/g, " ")
                  .slice(0, 200)
              : "unknown error";
          api.logger.warn(
            `fi-user: Slack reconciliation account=${accountId} session=${sessionKey}: ${detail}`,
          );
        }
      }
    } catch {
      api.logger.warn("fi-user: Slack projection reconciliation scan failed");
    } finally {
      if (!stopped && controller === generation) {
        timer = setTimeout(() => void reconcile(), 60_000);
        timer.unref();
      }
    }
  };
  api.registerService({
    id: "fi-slack-projection-reconciler",
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      controller = new AbortController();
      timer = setTimeout(() => void reconcile(), 5_000);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      controller?.abort();
      controller = undefined;
    },
  });
}
