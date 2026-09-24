import { createHash } from "node:crypto";
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import type { Direction } from "matrix-js-sdk/lib/models/event-timeline.js";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { CoreConfig } from "../types.js";
import { ProjectionError } from "./projection-error.js";
import {
  createMatrixSourcePublication,
  MATRIX_PROJECTION_CONTENT_KEY,
} from "./projection-publication.js";
import { noteMatrixSourceSnapshotResult } from "./projection-source-result.js";
import { getMatrixProjectionStatus } from "./projection-source.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";
import { editMessageMatrix, sendMessageMatrix } from "./send.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
import { checkProjectionInvariants } from "./session-projection-invariants.js";
import {
  object,
  planProjectionReconcile,
  projectionMapping,
  projectionThreadOriginals,
  SOURCE_CONTENT_REVISION_KEY,
  sourceMessageContentHash,
  type ProjectionAction,
  type ProjectionHistory,
  type SourceProjectionMessage,
  type SourceProjectionSnapshot,
} from "./session-projection-plan.js";
export type {
  SourceProjectionMessage,
  SourceProjectionSnapshot,
} from "./session-projection-plan.js";
export const MATRIX_SESSION_PROJECTION_CONTENT_KEY = MATRIX_PROJECTION_CONTENT_KEY;
const EDIT_READ_CONCURRENCY = 16;
const PROJECTION_DECRYPT_BATCH_SIZE = 4;
const RECONCILE_DEADLINE_MS = 45_000;

export function projectionText(params: {
  channel: string;
  role: "user" | "assistant";
  text: string;
  senderId?: string;
  agentId?: string;
  displayName?: string;
}): string {
  const author = params.displayName || params.agentId || params.senderId;
  const speaker = author
    ? author
        .replace(/[\\`*_[\]<>]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 100)
    : params.role === "user"
      ? "User"
      : "Assistant";
  const source =
    params.channel === "webchat"
      ? "OpenClaw"
      : `${params.channel.slice(0, 1).toUpperCase()}${params.channel.slice(1)}`;
  return `**${source} · ${speaker}**\n${params.text}`;
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

async function hydrateProjectionEvents(
  client: MatrixClient,
  roomId: string,
  events: MatrixRawEvent[],
): Promise<MatrixRawEvent[]> {
  const hydrated: MatrixRawEvent[] = [];
  for (let index = 0; index < events.length; index += PROJECTION_DECRYPT_BATCH_SIZE) {
    hydrated.push(
      ...(await client.hydrateEvents(
        roomId,
        events.slice(index, index + PROJECTION_DECRYPT_BATCH_SIZE),
      )),
    );
    // matrix-rust-sdk decryption can be CPU-heavy for old encrypted threads.
    // Yield between small batches so gateway health and ingress stay responsive.
    await yieldToEventLoop(0);
  }
  return hydrated;
}

async function readProjectionHistory(
  client: MatrixClient,
  roomId: string,
  threadId: string,
  checkDeadline: () => void,
) {
  const events: MatrixRawEvent[] = [];
  let from: string | undefined;
  const cursors = new Set<string>();
  // A complete bounded read of this projection thread is required before
  // changing or deleting anything. Reading the whole room is both unnecessary
  // and dangerous in long-lived DMs: decrypting unrelated threads blocks the
  // gateway event loop while a source snapshot is reconciled.
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    checkDeadline();
    const page = await client.getRelations(roomId, threadId, "m.thread", undefined, {
      dir: "b" as Direction,
      limit: 100,
      from,
    });
    if (!Array.isArray(page.events)) {
      throw new Error("Invalid Matrix projection history");
    }
    const hydrated = await hydrateProjectionEvents(client, roomId, page.events);
    if (hydrated.some((event) => event.type === "m.room.encrypted")) {
      throw new Error("Incomplete decrypted Matrix projection history");
    }
    events.push(...hydrated);
    const next = page.nextBatch ?? undefined;
    if (!next) {
      return events;
    }
    if (cursors.has(next)) {
      throw new Error("Incomplete Matrix projection history pagination");
    }
    cursors.add(next);
    from = next;
  }
  throw new Error("Matrix projection history exceeds reconciliation bound");
}

/**
 * Same-author replacements per original. Edits relate to their target with
 * m.replace, so a thread-relations read never returns them, and Tuwunel does
 * not bundle them into `unsigned`. Without this read the reconciler compares
 * against stale original content and re-edits on every refresh. Returned raw,
 * newest first per original; `readProjectionThread` interprets them.
 */
async function readSelfEdits(
  client: MatrixClient,
  roomId: string,
  originalIds: string[],
  checkDeadline: () => void,
) {
  const edits: MatrixRawEvent[] = [];
  for (let index = 0; index < originalIds.length; index += EDIT_READ_CONCURRENCY) {
    checkDeadline();
    const pages = await Promise.all(
      originalIds.slice(index, index + EDIT_READ_CONCURRENCY).map(async (eventId) => {
        const page = await client.getRelations(roomId, eventId, "m.replace", undefined, {
          dir: "b" as Direction,
          limit: 100,
        });
        if (!Array.isArray(page.events)) {
          throw new Error("Invalid Matrix edit history");
        }
        return hydrateProjectionEvents(client, roomId, page.events);
      }),
    );
    edits.push(...pages.flat());
  }
  return edits;
}

export function parseSourceProjectionSnapshot(value: unknown): SourceProjectionSnapshot {
  const rawSnapshot = object(value);
  if (
    rawSnapshot?.complete !== true ||
    !Array.isArray(rawSnapshot.messages) ||
    rawSnapshot.messages.length > 1000
  ) {
    throw new Error("Complete bounded source snapshot required");
  }
  const messages: SourceProjectionMessage[] = [];
  const sourceIds = new Set<string>();
  let totalContent = 0;
  for (const rawMessage of rawSnapshot.messages) {
    const message = object(rawMessage);
    if (
      !message ||
      typeof message.messageId !== "string" ||
      message.messageId.length > 64 ||
      !/^\d+\.\d+$/.test(message.messageId) ||
      sourceIds.has(message.messageId) ||
      typeof message.content !== "string" ||
      message.content.length > 100_000 ||
      typeof message.senderId !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      (message.agentId !== undefined && typeof message.agentId !== "string") ||
      (message.displayName !== undefined &&
        (typeof message.displayName !== "string" ||
          message.displayName.length > 200 ||
          hasAsciiControl(message.displayName)))
    ) {
      throw new Error("Invalid source snapshot message");
    }
    totalContent += message.content.length;
    if (totalContent > 1_000_000) {
      throw new Error("Source snapshot exceeds bounded content");
    }
    sourceIds.add(message.messageId);
    messages.push({
      messageId: message.messageId,
      senderId: message.senderId,
      content: message.content,
      role: message.role,
      agentId: message.agentId,
      ...(typeof message.displayName === "string" ? { displayName: message.displayName } : {}),
    });
  }
  return { complete: true, messages };
}

export function sourceProjectionSnapshotDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(parseSourceProjectionSnapshot(value)))
    .digest("hex");
}

function reconcileDeadline() {
  const deadline = Date.now() + RECONCILE_DEADLINE_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error("Matrix snapshot reconciliation deadline exceeded");
    }
  };
}

/** Reads, without writing, everything a reconcile pass plans from. */
async function recordProjectionHistory(
  client: MatrixClient,
  roomId: string,
  threadId: string,
  checkDeadline: () => void,
): Promise<ProjectionHistory> {
  const events = await readProjectionHistory(client, roomId, threadId, checkDeadline);
  const self = await client.getUserId();
  const edits = await readSelfEdits(
    client,
    roomId,
    projectionThreadOriginals(events, self, threadId).map((event) => event.event_id),
    checkDeadline,
  );
  return { self, threadId, events, edits };
}

function resolveProjectionBinding(accountId: string, roomId: string, threadId: string) {
  return getSessionBindingService().resolveByConversation({
    channel: "matrix",
    accountId,
    conversationId: threadId,
    parentConversationId: roomId,
  });
}

/** The binding facts `createMatrixSourcePublication` needs to issue a publication. */
function bindingPublishes(binding: ReturnType<typeof resolveProjectionBinding>): boolean {
  const present = (value: unknown) => typeof value === "string" && value.trim() !== "";
  return Boolean(
    binding &&
    present(binding.metadata?.environment) &&
    present(binding.metadata?.projectedConversationId),
  );
}

const REDACTION_REASONS = {
  duplicate: "Reconciled duplicate source message",
  deleted_in_source: "Deleted in Slack",
  rebased_history: "Rebased shared projection history",
} as const;

/** Performs a plan's Matrix writes in order; the only writer in reconciliation. */
export async function applyProjectionPlan(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  threadId: string;
  client: MatrixClient;
  snapshot: SourceProjectionSnapshot;
  actions: ProjectionAction[];
  checkDeadline: () => void;
}) {
  const messages = new Map<string, SourceProjectionMessage>(
    params.snapshot.messages.map((message) => [message.messageId, message]),
  );
  for (const action of params.actions) {
    params.checkDeadline();
    if (action.kind === "redact" || action.kind === "retire_notice") {
      await params.client.redactEvent(
        params.roomId,
        action.eventId,
        action.kind === "redact" ? REDACTION_REASONS[action.reason] : "Retired binding notice",
      );
      continue;
    }
    const message = messages.get(action.messageId);
    if (!message) {
      throw new Error("Projection plan references a message outside its snapshot");
    }
    const binding = resolveProjectionBinding(params.accountId, params.roomId, params.threadId);
    const publication = binding
      ? createMatrixSourcePublication({
          bindingId: binding.bindingId,
          roomId: params.roomId,
          threadId: params.threadId,
          provider: "slack",
          accountId: params.accountId,
          messageId: message.messageId,
          actorId: message.senderId,
          publishedAtMs: Math.floor(Number(message.messageId) * 1000),
          role: message.role,
          displayName: message.displayName,
          publicationRevision: action.revision,
        })
      : undefined;
    if (action.kind === "unchanged") {
      if (binding && publication && action.finalEventId) {
        await noteMatrixSourceSnapshotResult(
          binding.bindingId,
          message.messageId,
          params.roomId,
          action.finalEventId,
        );
      }
      continue;
    }
    const extraContent = {
      [SOURCE_CONTENT_REVISION_KEY]: { contentHash: sourceMessageContentHash(message) },
    };
    const body = projectionText({
      channel: "slack",
      role: message.role,
      text: message.content || "[Message has no text]",
      senderId: message.senderId,
      agentId: message.agentId,
      displayName: message.displayName,
    });
    let acceptedMessageId: string;
    if (action.kind === "edit") {
      // The plan chose an in-place edit because the binding could publish;
      // redactions that follow assume this slot is retained.
      if (!publication) {
        throw new ProjectionError(
          "ownership_changed",
          "Projection binding changed during reconciliation",
        );
      }
      await editMessageMatrix(params.roomId, action.eventId, body, {
        cfg: params.cfg,
        accountId: params.accountId,
        client: params.client,
        threadId: params.threadId,
        extraContent,
        publication,
      });
      acceptedMessageId = action.eventId;
    } else {
      acceptedMessageId = (
        await sendMessageMatrix(`room:${params.roomId}`, body, {
          cfg: params.cfg,
          accountId: params.accountId,
          client: params.client,
          threadId: params.threadId,
          extraContent,
          publication,
          deliveryQueueId: `matrix-slack-source:${params.roomId}:${params.threadId}:${message.messageId}:${action.revision}`,
          deliveryPartIndex: 0,
          deliveryPartCount: 1,
        })
      ).messageId;
    }
    if (binding && publication) {
      await noteMatrixSourceSnapshotResult(
        binding.bindingId,
        message.messageId,
        params.roomId,
        acceptedMessageId,
      );
    }
  }
}

export async function reconcileMatrixProjectionSnapshot(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  threadId: string;
  snapshot: unknown;
  retireThreadId?: string;
}) {
  const checkDeadline = reconcileDeadline();
  const snapshot = parseSourceProjectionSnapshot(params.snapshot);
  await withResolvedMatrixSendClient(
    { cfg: params.cfg, accountId: params.accountId, timeoutMs: 10_000 },
    async (client) => {
      const history = await recordProjectionHistory(
        client,
        params.roomId,
        params.threadId,
        checkDeadline,
      );
      const actions = planProjectionReconcile(history, snapshot, {
        publishable: bindingPublishes(
          resolveProjectionBinding(params.accountId, params.roomId, params.threadId),
        ),
        retireThreadId: params.retireThreadId,
      });
      await applyProjectionPlan({
        cfg: params.cfg,
        accountId: params.accountId,
        roomId: params.roomId,
        threadId: params.threadId,
        client,
        snapshot,
        actions,
        checkDeadline,
      });
    },
  );
}

/**
 * Read-only dry run for `matrix.sessionProjection.plan`: what a reconcile
 * pass would write, invariant verdicts and the current source mapping. With
 * no `sourceSnapshot` the plan is structural (see `planProjectionReconcile`).
 */
export async function planMatrixProjectionRoom(params: {
  cfg: CoreConfig;
  roomId?: unknown;
  accountId?: unknown;
  sourceSnapshot?: unknown;
}) {
  const roomId = typeof params.roomId === "string" ? params.roomId.trim() : "";
  if (!roomId.startsWith("!") || roomId.length > 255) {
    throw new ProjectionError("invalid_request", "A Matrix room id is required");
  }
  if (params.accountId !== undefined && typeof params.accountId !== "string") {
    throw new ProjectionError("invalid_request", "accountId must be a string");
  }
  let snapshot: SourceProjectionSnapshot | undefined;
  let status: ReturnType<typeof getMatrixProjectionStatus>;
  try {
    snapshot =
      params.sourceSnapshot === undefined
        ? undefined
        : parseSourceProjectionSnapshot(params.sourceSnapshot);
    status = getMatrixProjectionStatus(roomId, params.accountId?.trim() || undefined);
  } catch (error) {
    throw new ProjectionError("invalid_request", formatErrorMessage(error));
  }
  if (status.status === "missing") {
    throw new ProjectionError("session_missing", "No session projection is bound to this room");
  }
  const { accountId, threadRootEventId } = status;
  const checkDeadline = reconcileDeadline();
  return withResolvedMatrixSendClient(
    { cfg: params.cfg, accountId, timeoutMs: 10_000 },
    async (client) => {
      const history = await recordProjectionHistory(
        client,
        roomId,
        threadRootEventId,
        checkDeadline,
      );
      const actions = planProjectionReconcile(history, snapshot, {
        publishable: bindingPublishes(
          resolveProjectionBinding(accountId, roomId, threadRootEventId),
        ),
      });
      return {
        roomId,
        accountId,
        threadRootEventId,
        source: snapshot ? ("snapshot" as const) : ("history" as const),
        converged: actions.every((action) => action.kind === "unchanged"),
        actions,
        invariants: checkProjectionInvariants(history),
        mapping: projectionMapping(history),
      };
    },
  );
}
