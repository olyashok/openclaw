import { KeyedAsyncQueue, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionEntries,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  createDetachedProjectionReconciler,
  verifyDetachedProjectionOrigin,
  type ProjectionInventoryBinding,
} from "./detached-projection.js";
import {
  reconcileSlackDirectProjections,
  recoverSlackDirectProjection,
} from "./direct-projection.js";
import { RECONCILE_BATCH_SIZE, takeSweepBatch } from "./reconciliation-batch.js";

type SlackSnapshot = {
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
  memberSenderIds: string[];
  messages: Array<{
    messageId: string;
    senderId: string;
    displayName?: string;
    content: string;
    bot: boolean;
  }>;
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
  readChannel: (channelId: string) => Promise<SlackChannelScope>;
};
type SlackChannelScope = Omit<SlackSnapshot, "rootMessageId" | "messages"> & {
  readThread: (rootMessageId: string) => Promise<SlackSnapshot>;
};

export type ChannelProjectionParams = {
  api: OpenClawPluginApi;
  sessionKey: string;
  accountId: string;
  requesterSenderId?: string;
  baseUrl: string;
  token: string;
  reconcile?: boolean;
  discover?: boolean;
  projectionRoomId?: string;
  signal?: AbortSignal;
  unavailable?: boolean;
  detachedSource?: {
    provider: "slack";
    workspaceId: string;
    channelId: string;
    rootMessageId: string;
  };
  channelScope?: SlackChannelScope;
  membershipOnly?: boolean;
  onResult?: (status: "created" | "existing" | "skipped") => void;
};

export async function projectSlackChannelThread(params: ChannelProjectionParams): Promise<boolean> {
  const match = params.detachedSource
    ? /^agent:(cellect-fi-user|cellect-fi-admin):slack:(?:channel|group):([cg][a-z0-9]+)$/i.exec(
        params.sessionKey,
      )
    : CHANNEL_SESSION.exec(params.sessionKey);
  const [, rawAgentId, rawChannelId, nativeRoot] = match ?? [];
  const rootMessageId = params.detachedSource?.rootMessageId ?? nativeRoot;
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
  if (params.detachedSource && !params.unavailable) {
    await verifyDetachedProjectionOrigin(params, sourceIdentity, reader?.workspaceId);
  }
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
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(70_000)])
        : AbortSignal.timeout(70_000),
      headers: { authorization: `Bearer ${params.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...(body as Record<string, unknown>),
        ...(params.detachedSource ? { sourceDetached: true } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Fi channel projection failed (${response.status})`);
    }
    if (params.onResult) {
      const result = (await response.json()) as { status?: unknown };
      if (
        result.status !== "created" &&
        result.status !== "existing" &&
        result.status !== "skipped"
      ) {
        throw new Error("Invalid Fi projection response status");
      }
      params.onResult(result.status);
    }
  };
  let snapshot: SlackSnapshot;
  try {
    if (!reader) {
      throw new Error("Slack thread reader unavailable for this account");
    }
    if (params.membershipOnly && params.channelScope) {
      const { readThread: _readThread, ...source } = params.channelScope;
      await post({
        reconcile: true,
        agentId,
        sessionKey: params.sessionKey,
        source: { ...source, rootMessageId },
      });
      return true;
    }
    snapshot = params.channelScope
      ? await params.channelScope.readThread(rootMessageId)
      : await reader.readThread(channelId, rootMessageId);
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
        ...(params.detachedSource
          ? { source: { ...params.detachedSource, memberSenderIds: [] } }
          : {}),
      });
    }
    throw error;
  }
  const requesterSenderId =
    params.requesterSenderId ?? snapshot.messages.find((message) => !message.bot)?.senderId;
  if (
    !params.reconcile &&
    !params.discover &&
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
  if (
    params.detachedSource &&
    !params.reconcile &&
    !messages.some(
      (message) =>
        (message.bot && botAgents.get(message.senderId)?.size === 1) ||
        [...botAgents].some(
          ([botId, agents]) => agents.size === 1 && message.content.includes(`<@${botId}>`),
        ),
    )
  ) {
    params.onResult?.("skipped");
    return true;
  }
  await post({
    requesterSenderId,
    ...(params.reconcile ? { reconcile: true } : {}),
    ...(params.discover ? { discover: true } : {}),
    agentId,
    sessionKey: params.sessionKey,
    source,
    snapshot: {
      complete: true,
      messages: messages.map((message) => ({
        messageId: message.messageId,
        senderId: message.senderId,
        displayName: message.displayName,
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
  const reconciler = registerSlackProjectionReconciler(api, connection);
  api.registerGatewayMethod(
    "fi.slackProjection.sync",
    async ({ params, respond }) => {
      const { baseUrl, token } = connection();
      try {
        if (token && typeof params?.sessionKey === "string" && params.directSource) {
          respond(
            true,
            await recoverSlackDirectProjection(
              api,
              { baseUrl, token },
              params.sessionKey,
              params.directSource,
            ),
          );
          return;
        }
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
    if (/^agent:[^:]+:slack:(channel|group):[cg][a-z0-9]+$/i.test(sessionKey)) {
      reconciler.wake(sessionKey);
      return;
    }
    void projectSlackChannelThread({
      api,
      token,
      baseUrl,
      sessionKey,
      accountId: context.accountId,
      discover: true,
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
  let running = false;
  let wakeRequested = false;
  let discoveryCursor = "";
  const bindingSweepSeen = new Set<string>();
  const outcomes = new Map<string, "created" | "existing" | "skipped" | "error">();
  let report = {
    scanned: 0,
    pending: 0,
    created: 0,
    existing: 0,
    skipped: 0,
    error: 0,
    unavailable: 0,
    historyDiscoveryPending: 0,
    complete: false,
  };
  let directReport = { scanned: 0, created: 0, existing: 0, skipped: 0, error: 0 };
  let detachedReport = {
    channels: 0,
    pending: 0,
    unavailable: 0,
    error: 0,
    created: 0,
    existing: 0,
    skipped: 0,
  };
  const reconcileDetached = createDetachedProjectionReconciler(api, projectSlackChannelThread);
  api.registerGatewayMethod(
    "fi.slackProjection.status",
    async ({ respond }) => {
      respond(true, { ...report, direct: directReport, detached: detachedReport });
    },
    { scope: "operator.admin" },
  );
  const reconcile = async () => {
    const generation = controller;
    if (!generation || running) {
      return;
    }
    running = true;
    try {
      report = { ...report, complete: false };
      const config = connection();
      if (!config.token) {
        return;
      }
      const inventory = api.runtime.channel.runtimeContexts.get<{
        list: () => Promise<ProjectionInventoryBinding[]>;
      }>({ channelId: "matrix", capability: "session-read-projections" });
      if (!inventory) {
        throw new Error("Matrix projection inventory unavailable");
      }
      const bindings = await inventory.list();
      const runtimeConfig = api.runtime.config?.current?.() ?? api.config;
      const configuredBindings = (runtimeConfig?.bindings ?? []).filter(
        (binding) =>
          binding.match.channel === "slack" &&
          Boolean(binding.match.accountId && binding.match.accountId !== "*") &&
          ["cellect-fi-user", "cellect-fi-admin"].includes(binding.agentId),
      );
      const resolveAccount = (
        agentId: string,
        channelId: string,
        sessionKey: string,
        stored?: string,
      ) => {
        const accounts = new Set(
          configuredBindings
            .filter(
              (binding) =>
                binding.agentId === agentId &&
                (!binding.match.peer ||
                  binding.match.peer.id.toUpperCase() === channelId.toUpperCase()),
            )
            .map((binding) => binding.match.accountId),
        );
        const durable = bindings.find(
          (binding) => binding.sessionKey === sessionKey,
        )?.sourceAccountId;
        if (durable) {
          return accounts.has(durable) ? durable : undefined;
        }
        return stored && accounts.has(stored)
          ? stored
          : accounts.size === 1
            ? [...accounts][0]
            : undefined;
      };
      const discovered = new Map<string, { sessionKey: string; accountId: string }>();
      const knownRoots = new Set<string>();
      const unavailableSessions = new Set<string>();
      const rootIdentity = (sessionKey: string, accountId: string) => {
        const match = CHANNEL_SESSION.exec(sessionKey);
        const reader = api.runtime.channel.runtimeContexts.get<SlackThreadReader>({
          channelId: "slack",
          accountId,
          capability: "thread-read-projection",
        });
        return match && reader
          ? `${reader.workspaceId}:${match[2]?.toUpperCase()}:${match[3]}`
          : undefined;
      };
      for (const { sessionKey } of bindings) {
        const [, agentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
        if (!agentId || !channelId) {
          continue;
        }
        const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
        const accountId = resolveAccount(
          agentId,
          channelId,
          sessionKey,
          sessionDeliveryOrigin(entry)?.accountId,
        );
        const identity = accountId && rootIdentity(sessionKey, accountId);
        if (identity) {
          knownRoots.add(identity);
        } else {
          unavailableSessions.add(sessionKey);
        }
      }
      for (const agentId of new Set(configuredBindings.map((binding) => binding.agentId))) {
        for (const { sessionKey, entry } of listSessionEntries({ agentId, readOnly: true })) {
          const [, sourceAgentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
          if (sourceAgentId !== agentId || !channelId) {
            continue;
          }
          const accountId = resolveAccount(
            agentId,
            channelId,
            sessionKey,
            sessionDeliveryOrigin(entry)?.accountId,
          );
          if (!accountId) {
            unavailableSessions.add(sessionKey);
            continue;
          }
          const identity = rootIdentity(sessionKey, accountId);
          if (identity && !knownRoots.has(identity) && !discovered.has(identity)) {
            discovered.set(identity, { sessionKey, accountId });
          } else if (!identity) {
            unavailableSessions.add(sessionKey);
          }
        }
      }
      // Restart re-enumerates durable sessions. Only scheduling position is transient;
      // Fi/source identity makes replay idempotent and opt-outs remain authoritative.
      const keys = [...discovered.keys()].toSorted();
      const ordered = [
        ...keys.filter((key) => key > discoveryCursor),
        ...keys.filter((key) => key <= discoveryCursor),
      ];
      const batch = ordered.slice(0, RECONCILE_BATCH_SIZE).flatMap((key) => {
        const candidate = discovered.get(key);
        if (!candidate) {
          return [];
        }
        discoveryCursor = key;
        return [{ ...candidate, roomId: undefined }];
      });
      const bindingKeys = bindings
        .filter((binding) => CHANNEL_SESSION.test(binding.sessionKey))
        .map((binding) => binding.sessionKey)
        .toSorted();
      const bindingBatch = takeSweepBatch(bindingKeys, bindingSweepSeen, RECONCILE_BATCH_SIZE);
      const channelScopes = new Map<
        string,
        { createdAt: number; scope: Promise<SlackChannelScope> }
      >();
      const projects = [
        ...bindings.filter((binding) => bindingBatch.has(binding.sessionKey)),
        ...batch,
      ];
      // Both ACL and source-history work are bounded. A full-room ACL sweep in one
      // tick exhausts Fi's shared provisioning credential before live traffic can
      // authenticate. Active Slack deliveries still project immediately; this loop
      // is the durable repair path.
      for (const { sessionKey, roomId } of projects) {
        if (stopped || controller !== generation) {
          return;
        }
        const [, agentId, channelId] = CHANNEL_SESSION.exec(sessionKey) ?? [];
        if (!agentId || !channelId) {
          continue;
        }
        const entry = getSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
        const accountId = resolveAccount(
          agentId,
          channelId,
          sessionKey,
          sessionDeliveryOrigin(entry)?.accountId,
        );
        const identity = accountId && rootIdentity(sessionKey, accountId);
        let enteredPublisher = false;
        try {
          let channelScope: SlackChannelScope | undefined;
          if (entry && accountId) {
            const reader = api.runtime.channel.runtimeContexts.get<SlackThreadReader>({
              channelId: "slack",
              accountId,
              capability: "thread-read-projection",
            });
            if (reader) {
              const scopeKey = `${accountId}:${reader.workspaceId}:${channelId.toUpperCase()}`;
              let cached = channelScopes.get(scopeKey);
              if (!cached || Date.now() - cached.createdAt > 20_000) {
                cached = {
                  createdAt: Date.now(),
                  scope: reader.readChannel(channelId.toUpperCase()),
                };
                channelScopes.set(scopeKey, cached);
              }
              channelScope = await cached.scope;
            }
          }
          enteredPublisher = true;
          await projectSlackChannelThread({
            api,
            ...config,
            token: config.token,
            sessionKey,
            accountId: accountId ?? "unavailable",
            unavailable: !entry || !accountId,
            reconcile: Boolean(roomId),
            discover: !roomId,
            projectionRoomId: roomId,
            channelScope,
            membershipOnly: false,
            onResult: (status) => {
              if (identity) {
                outcomes.set(identity, status);
              }
            },
            signal: AbortSignal.any([generation.signal, AbortSignal.timeout(90_000)]),
          });
        } catch (error) {
          if (identity) {
            outcomes.set(identity, "error");
          }
          if (roomId && !enteredPublisher) {
            await projectSlackChannelThread({
              api,
              ...config,
              token: config.token,
              sessionKey,
              accountId: accountId ?? "unavailable",
              unavailable: true,
              reconcile: true,
              projectionRoomId: roomId,
              signal: AbortSignal.any([generation.signal, AbortSignal.timeout(70_000)]),
            }).catch(() => {
              api.logger.warn(
                `fi-user: failed to revoke unavailable projection session=${sessionKey}`,
              );
            });
          }
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
      const candidates = new Set([...knownRoots, ...discovered.keys()]);
      for (const identity of outcomes.keys()) {
        if (!candidates.has(identity)) {
          outcomes.delete(identity);
        }
      }
      const counts = { created: 0, existing: 0, skipped: 0, error: 0 };
      for (const identity of candidates) {
        const outcome = outcomes.get(identity);
        if (outcome) {
          counts[outcome]++;
        }
      }
      const pending =
        [...candidates].filter((identity) => !outcomes.has(identity)).length +
        unavailableSessions.size;
      // Existing channel ACLs run first; slower historical/direct hydration cannot delay them.
      detachedReport = await reconcileDetached.reconcile(
        { ...config, token: config.token },
        bindings,
        generation.signal,
        knownRoots,
      );
      directReport = await reconcileSlackDirectProjections(
        api,
        { ...config, token: config.token },
        bindings,
        generation.signal,
      );
      report = {
        scanned: candidates.size,
        pending,
        ...counts,
        unavailable: unavailableSessions.size,
        historyDiscoveryPending: detachedReport.pending,
        complete:
          pending === 0 &&
          counts.error === 0 &&
          unavailableSessions.size === 0 &&
          directReport.error === 0 &&
          detachedReport.pending === 0 &&
          detachedReport.error === 0 &&
          detachedReport.unavailable === 0,
      };
      api.logger.info(`fi-user: Slack discovery ${JSON.stringify(report)}`);
    } catch {
      report = { ...report, complete: false, error: report.error + 1 };
      api.logger.warn("fi-user: Slack projection reconciliation scan failed");
    } finally {
      running = false;
      if (!stopped && controller === generation) {
        timer = setTimeout(() => void reconcile(), wakeRequested ? 1_000 : 60_000);
        wakeRequested = false;
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
  return {
    wake: (sessionKey: string) => {
      reconcileDetached.invalidate(sessionKey);
      if (stopped) {
        return;
      }
      if (running) {
        wakeRequested = true;
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void reconcile(), 1_000);
      timer.unref();
    },
  };
}
