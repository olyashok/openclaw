import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  getSessionEntry,
  listSessionKeys,
  sessionDeliveryOrigin,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { ChannelProjectionParams } from "./channel-projection.js";
import {
  RECONCILE_BATCH_SIZE,
  RECONCILE_HISTORY_BATCH_SIZE,
  takePendingOrRotatingBatch,
} from "./reconciliation-batch.js";

type Source = NonNullable<ChannelProjectionParams["detachedSource"]>;
export type ProjectionInventoryBinding = {
  sessionKey: string;
  roomId: string;
  externalSource?: Source;
  sourceAccountId?: string;
};
export type ProjectionInventory = {
  list: () => Promise<ProjectionInventoryBinding[]>;
  /** Structural, read-only dry run of one bound room's reconcile pass. */
  plan?: (roomId: string) => Promise<{ converged: boolean; invariantsOk: boolean }>;
};

/**
 * Structural, read-only plan verdict for one bound room, or undefined when the
 * plan could not be read (logged; the room is planned again later).
 */
export async function planProjectionRoom(
  inventory: ProjectionInventory | undefined,
  roomId: string,
  logger?: { warn: (message: string) => void },
): Promise<{ converged: boolean; invariantsOk: boolean } | undefined> {
  try {
    return await inventory?.plan?.(roomId);
  } catch (error) {
    logger?.warn(
      `fi-user: projection refresh plan failed room=${roomId} error=${safeError(error)}`,
    );
    return undefined;
  }
}

/** One line per periodic full refresh, so the self-healing pass is observable. */
export function logProjectionRefresh(
  logger: { info: (message: string) => void; warn: (message: string) => void },
  lane: "channel" | "detached",
  roomId: string,
  sessionKey: string,
  error?: unknown,
): void {
  const line = `fi-user: projection refresh lane=${lane} room=${roomId} session=${sessionKey}`;
  if (error === undefined) {
    logger.info(`${line} outcome=refreshed`);
  } else {
    logger.warn(`${line} outcome=failed error=${safeError(error)}`);
  }
}

type Scope = NonNullable<ChannelProjectionParams["channelScope"]> & {
  readHistoryPage: (cursor?: string) => Promise<{ roots: string[]; nextCursor?: string }>;
};
type Reader = {
  workspaceId: string;
  botUserId?: string;
  readChannel: (channelId: string, clawBotUserIds?: Iterable<string>) => Promise<Scope>;
};
type ReconcileBudget = {
  /** Existing rooms only need their membership checked. */
  maxExistingRooms?: number;
  /** Historical root discovery is intentionally a separate maintenance lane. */
  allowDiscovery?: boolean;
};
type ConfiguredBinding = {
  agentId: string;
  match: { accountId?: string; peer?: { id: string } };
};
export const PARENT =
  /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:(?:channel|group):([cg][a-z0-9]+)$/i;
const identity = (source: Source) =>
  `${source.workspaceId}:${source.channelId}:${source.rootMessageId}`;
export const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : "Source unavailable")
    .replace(/xox[baprs]-\S+/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);

export async function verifyDetachedProjectionOrigin(
  params: ChannelProjectionParams,
  sourceIdentity: { agentId: string; channelId: string },
  readerWorkspaceId?: string,
) {
  if (!params.detachedSource) {
    throw new Error("Detached source required");
  }
  const entry = getSessionEntry({
    agentId: sourceIdentity.agentId,
    sessionKey: params.sessionKey,
    readConsistency: "latest",
  });
  const origin = sessionDeliveryOrigin(entry);
  const inventory = params.api.runtime.channel.runtimeContexts.get<ProjectionInventory>({
    channelId: "matrix",
    capability: "session-read-projections",
  });
  const persisted = (await inventory?.list())?.find(
    (binding) =>
      binding.sessionKey === params.sessionKey &&
      binding.sourceAccountId === params.accountId &&
      binding.externalSource?.channelId === sourceIdentity.channelId &&
      binding.externalSource.workspaceId === params.detachedSource?.workspaceId,
  );
  if (
    !entry ||
    (!persisted &&
      (origin?.accountId !== params.accountId ||
        origin.nativeChannelId?.toUpperCase() !== sourceIdentity.channelId)) ||
    params.detachedSource.channelId !== sourceIdentity.channelId ||
    readerWorkspaceId !== params.detachedSource.workspaceId
  ) {
    throw new Error("Detached Slack source does not match native parent origin");
  }
}

/**
 * The Slack account that may serve an existing detached room: its durable
 * source account, else the parent session's delivery account, and only when a
 * configured binding still admits it for this agent and channel.
 */
export function resolveDetachedRoomAccount(
  configured: readonly ConfiguredBinding[],
  binding: ProjectionInventoryBinding,
): { accountId?: string; allowed: boolean } {
  const source = binding.externalSource;
  const agentId = PARENT.exec(binding.sessionKey)?.[1];
  const entry = agentId
    ? getSessionEntry({ agentId, sessionKey: binding.sessionKey, readConsistency: "latest" })
    : undefined;
  const accountId = binding.sourceAccountId ?? sessionDeliveryOrigin(entry)?.accountId;
  const allowed = configured.some(
    (candidate) =>
      candidate.agentId === agentId &&
      candidate.match.accountId === accountId &&
      (!candidate.match.peer || candidate.match.peer.id.toUpperCase() === source?.channelId),
  );
  return { accountId, allowed: Boolean(entry && source && accountId && allowed) };
}

/** Cursor state is only a bounded scheduler; durable source/room identity makes restart replay safe. */
export function createDetachedProjectionReconciler(
  api: OpenClawPluginApi,
  publish: (params: ChannelProjectionParams) => Promise<boolean>,
) {
  const scans = new Map<
    string,
    {
      cursor?: string;
      roots: string[];
      failed: Set<string>;
      pages: number;
      done: boolean;
      completedAt?: number;
      created: number;
      existing: number;
      skipped: number;
      error?: string;
    }
  >();
  let channelCursor = "";
  let existingCursor = "";
  let refreshAt = 0;
  const existingOutcomes = new Map<string, "ok" | "unavailable" | "error">();
  const run = async (
    connection: { baseUrl: string; token: string },
    bindings: ProjectionInventoryBinding[],
    signal: AbortSignal,
    knownRoots: Set<string>,
    budget: ReconcileBudget = {},
  ) => {
    const config = api.runtime.config?.current?.() ?? api.config;
    const configured = (config?.bindings ?? []).filter(
      (binding) =>
        binding.match.channel === "slack" &&
        ["cellect-fi-user", "cellect-fi-admin", "cellect-main"].includes(binding.agentId) &&
        binding.match.accountId &&
        binding.match.accountId !== "*",
    );
    const parents = new Map<
      string,
      { sessionKey: string; accountId: string; workspaceId: string; channelId: string }
    >();
    let unavailable = 0;
    for (const agentId of new Set(configured.map((binding) => binding.agentId))) {
      for (const sessionKey of await listSessionKeys({ agentId })) {
        const channelId = PARENT.exec(sessionKey)?.[2]?.toUpperCase();
        if (!channelId) {
          continue;
        }
        const persisted = bindings.find(
          (binding) =>
            binding.sessionKey === sessionKey &&
            binding.sourceAccountId &&
            binding.externalSource?.channelId === channelId,
        );
        const configuredAccounts = new Set(
          configured
            .filter(
              (binding) =>
                binding.agentId === agentId &&
                (!binding.match.peer || binding.match.peer.id.toUpperCase() === channelId),
            )
            .map((binding) => binding.match.accountId),
        );
        const accountId =
          persisted?.sourceAccountId ??
          (configuredAccounts.size === 1 ? [...configuredAccounts][0] : undefined);
        const allowed =
          accountId &&
          (!persisted || persisted.externalSource?.channelId.toUpperCase() === channelId) &&
          configured.some(
            (binding) =>
              binding.agentId === agentId &&
              binding.match.accountId === accountId &&
              (!binding.match.peer || binding.match.peer.id.toUpperCase() === channelId),
          );
        const reader = allowed
          ? api.runtime.channel.runtimeContexts.get<Reader>({
              channelId: "slack",
              accountId,
              capability: "thread-read-projection",
            })
          : undefined;
        if (!accountId || !reader) {
          unavailable++;
          continue;
        }
        const key = `${reader.workspaceId}:${channelId}`;
        if (!parents.has(key)) {
          parents.set(key, { sessionKey, accountId, workspaceId: reader.workspaceId, channelId });
        }
      }
    }
    for (const key of scans.keys()) {
      if (!parents.has(key)) {
        scans.delete(key);
      }
    }
    // History is read with one account per channel, but any Claw bot in the
    // workspace makes a thread a Claw conversation.
    const clawBots = new Map<string, Set<string>>();
    for (const binding of configured) {
      const bot = api.runtime.channel.runtimeContexts.get<Reader>({
        channelId: "slack",
        accountId: binding.match.accountId,
        capability: "thread-read-projection",
      });
      if (bot?.botUserId) {
        const bots = clawBots.get(bot.workspaceId) ?? new Set<string>();
        bots.add(bot.botUserId);
        clawBots.set(bot.workspaceId, bots);
      }
    }
    const scopes = new Map<string, { at: number; scope: Promise<Scope> }>();
    const scopeFor = (accountId: string, channelId: string) => {
      const key = `${accountId}:${channelId}`;
      let cached = scopes.get(key);
      if (!cached || Date.now() - cached.at > 20_000) {
        const reader = api.runtime.channel.runtimeContexts.get<Reader>({
          channelId: "slack",
          accountId,
          capability: "thread-read-projection",
        });
        cached = {
          at: Date.now(),
          scope: reader
            ? reader.readChannel(channelId, clawBots.get(reader.workspaceId))
            : Promise.reject(new Error("Slack parent reader unavailable")),
        };
        scopes.set(key, cached);
      }
      return cached.scope;
    };
    const existing = bindings.filter(
      (binding) => binding.externalSource?.provider === "slack" && PARENT.test(binding.sessionKey),
    );
    const currentRooms = new Set(existing.map((binding) => binding.roomId));
    for (const roomId of existingOutcomes.keys()) {
      if (!currentRooms.has(roomId)) {
        existingOutcomes.delete(roomId);
      }
    }
    const roomIds = existing.map((binding) => binding.roomId).toSorted();
    const scheduled = takePendingOrRotatingBatch(
      roomIds,
      new Set(existingOutcomes.keys()),
      existingCursor,
      budget.maxExistingRooms ?? RECONCILE_BATCH_SIZE,
    );
    const existingRooms = scheduled.batch;
    existingCursor = scheduled.cursor;
    for (const binding of existing) {
      const source = binding.externalSource;
      if (!source) {
        continue;
      }
      knownRoots.add(identity(source));
      if (!existingRooms.has(binding.roomId)) {
        continue;
      }
      signal.throwIfAborted();
      const { accountId, allowed } = resolveDetachedRoomAccount(configured, binding);
      try {
        if (!allowed || !accountId) {
          throw new Error("Detached parent unavailable");
        }
        // A detached room already has its historical snapshot, so readers are
        // reconciled without replaying it. Drifted rooms are refreshed by the
        // reconciler's drift pass, not here.
        await publish({
          api,
          ...connection,
          sessionKey: binding.sessionKey,
          accountId,
          detachedSource: source,
          reconcile: true,
          projectionRoomId: binding.roomId,
          channelScope: await scopeFor(accountId, source.channelId),
          membershipOnly: true,
          signal,
        });
        existingOutcomes.set(binding.roomId, "ok");
      } catch (error) {
        const revoked = await publish({
          api,
          ...connection,
          sessionKey: binding.sessionKey,
          accountId: accountId ?? "unavailable",
          detachedSource: source,
          reconcile: true,
          projectionRoomId: binding.roomId,
          unavailable: true,
          signal,
        }).then(
          () => true,
          () => false,
        );
        existingOutcomes.set(binding.roomId, revoked ? "unavailable" : "error");
        api.logger.warn(
          `fi-user: detached source unavailable room=${binding.roomId} error=${safeError(error)}`,
        );
      }
    }
    const keys = [...parents.keys()].toSorted();
    if (!budget.allowDiscovery && budget.maxExistingRooms !== undefined) {
      const states = [...scans.values()];
      return {
        channels: parents.size,
        pending:
          keys.filter((candidate) => !scans.get(candidate)?.done).length +
          roomIds.filter((roomId) => !existingOutcomes.has(roomId)).length,
        unavailable:
          unavailable +
          [...existingOutcomes.values()].filter((outcome) => outcome === "unavailable").length,
        error:
          states.filter((state) => state.error).length +
          [...existingOutcomes.values()].filter((outcome) => outcome === "error").length,
        created: states.reduce((sum, state) => sum + state.created, 0),
        existing: states.reduce((sum, state) => sum + state.existing, 0),
        skipped: states.reduce((sum, state) => sum + state.skipped, 0),
      };
    }
    if (
      refreshAt &&
      Date.now() >= refreshAt &&
      keys.every((candidate) => scans.get(candidate)?.done)
    ) {
      scans.clear();
      refreshAt = 0;
    }
    const ordered = [
      ...keys.filter((key) => key > channelCursor),
      ...keys.filter((key) => key <= channelCursor),
    ];
    const key = ordered.find((candidate) => !scans.get(candidate)?.done);
    const parent = key ? parents.get(key) : undefined;
    if (key && parent) {
      channelCursor = key;
      const state = scans.get(key) ?? {
        roots: [],
        failed: new Set<string>(),
        pages: 0,
        done: false,
        created: 0,
        existing: 0,
        skipped: 0,
      };
      scans.set(key, state);
      try {
        const scope = await scopeFor(parent.accountId, parent.channelId);
        if (!state.roots.length) {
          if (state.pages > 0 && !state.cursor) {
            state.roots = [...state.failed].slice(0, RECONCILE_HISTORY_BATCH_SIZE);
          } else {
            if (state.failed.size >= 1000) {
              throw new Error(
                "Too many failed roots; resolve source failures before continuing discovery",
              );
            }
            const page = await scope.readHistoryPage(state.cursor);
            state.pages++;
            state.cursor = page.nextCursor;
            state.roots = [...page.roots];
          }
        }
        for (const rootMessageId of state.roots.slice(0, RECONCILE_HISTORY_BATCH_SIZE)) {
          signal.throwIfAborted();
          const source: Source = {
            provider: "slack",
            workspaceId: parent.workspaceId,
            channelId: parent.channelId,
            rootMessageId,
          };
          try {
            if (knownRoots.has(identity(source))) {
              state.existing++;
            } else {
              await publish({
                api,
                ...connection,
                sessionKey: parent.sessionKey,
                accountId: parent.accountId,
                detachedSource: source,
                discover: true,
                channelScope: await scopeFor(parent.accountId, parent.channelId),
                signal,
                onResult: (status) => {
                  state[status]++;
                },
              });
            }
            state.failed.delete(rootMessageId);
          } catch (error) {
            state.failed.delete(rootMessageId);
            state.failed.add(rootMessageId);
            state.error = safeError(error);
          }
          state.roots.shift();
        }
        state.done = !state.cursor && !state.roots.length && !state.failed.size;
        if (state.done) {
          state.completedAt = Date.now();
        }
        if (!state.failed.size) {
          state.error = undefined;
        }
      } catch (error) {
        state.error = safeError(error);
        api.logger.warn(`fi-user: detached discovery source=${key} error=${state.error}`);
      }
    }
    const states = [...scans.values()];
    if (!refreshAt && keys.every((candidate) => scans.get(candidate)?.done)) {
      refreshAt = Date.now() + 300_000;
    }
    return {
      channels: parents.size,
      pending:
        keys.filter((candidate) => !scans.get(candidate)?.done).length +
        roomIds.filter((roomId) => !existingOutcomes.has(roomId)).length,
      unavailable:
        unavailable +
        [...existingOutcomes.values()].filter((outcome) => outcome === "unavailable").length,
      error:
        states.filter((state) => state.error).length +
        [...existingOutcomes.values()].filter((outcome) => outcome === "error").length,
      created: states.reduce((sum, state) => sum + state.created, 0),
      existing: states.reduce((sum, state) => sum + state.existing, 0),
      skipped: states.reduce((sum, state) => sum + state.skipped, 0),
    };
  };
  return {
    reconcile: run,
    invalidate: (sessionKey: string) => {
      const channelId = PARENT.exec(sessionKey)?.[2]?.toUpperCase();
      if (!channelId) {
        return;
      }
      for (const [key, scan] of scans) {
        if (key.endsWith(`:${channelId}`) && scan.done) {
          scans.delete(key);
          refreshAt = 0;
        }
      }
    },
  };
}
