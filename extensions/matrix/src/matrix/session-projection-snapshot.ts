import { createHash } from "node:crypto";
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import type { Direction } from "matrix-js-sdk/lib/models/event-timeline.js";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { CoreConfig } from "../types.js";
import { isMatrixBindingNoticeText } from "./binding-notice.js";
import {
  createMatrixSourcePublication,
  MATRIX_PROJECTION_CONTENT_KEY,
} from "./projection-publication.js";
import { noteMatrixSourceSnapshotResult } from "./projection-source-result.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";
import { editMessageMatrix, sendMessageMatrix } from "./send.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
export const MATRIX_SESSION_PROJECTION_CONTENT_KEY = MATRIX_PROJECTION_CONTENT_KEY;
const SOURCE_CONTENT_REVISION_KEY = "com.openclaw.source_revision";
// First-generation projections carried only this marker. They are the same
// source message as any later v2 publication and must converge with it.
const LEGACY_SESSION_PROJECTION_KEY = "com.openclaw.session_projection";
const EDIT_READ_CONCURRENCY = 8;
const PROJECTION_DECRYPT_BATCH_SIZE = 4;
export type SourceProjectionMessage = {
  messageId: string;
  senderId: string;
  content: string;
  role: "user" | "assistant";
  agentId?: string;
  displayName?: string;
};
export type SourceProjectionSnapshot = { complete: true; messages: SourceProjectionMessage[] };

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

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
 * Latest same-author replacement per original. Edits relate to their target
 * with m.replace, so a thread-relations read never returns them, and Tuwunel
 * does not bundle them into `unsigned`. Without this read the reconciler
 * compares against stale original content and re-edits on every refresh.
 */
async function readSelfEdits(
  client: MatrixClient,
  roomId: string,
  originalIds: string[],
  self: string,
  checkDeadline: () => void,
) {
  const latest = new Map<string, Record<string, unknown>>();
  const editIds = new Map<string, string[]>();
  for (let index = 0; index < originalIds.length; index += EDIT_READ_CONCURRENCY) {
    checkDeadline();
    await Promise.all(
      originalIds.slice(index, index + EDIT_READ_CONCURRENCY).map(async (eventId) => {
        const page = await client.getRelations(roomId, eventId, "m.replace", undefined, {
          dir: "b" as Direction,
          limit: 100,
        });
        if (!Array.isArray(page.events)) {
          throw new Error("Invalid Matrix edit history");
        }
        // Newest first: the first same-author replacement is authoritative.
        for (const edit of await hydrateProjectionEvents(client, roomId, page.events)) {
          if (edit.sender !== self || edit.unsigned?.redacted_because) {
            continue;
          }
          const content = object(edit.content);
          if (object(content?.["m.relates_to"])?.event_id !== eventId) {
            continue;
          }
          editIds.set(eventId, [...(editIds.get(eventId) ?? []), edit.event_id]);
          const replacement = object(content?.["m.new_content"]);
          if (replacement && !latest.has(eventId)) {
            latest.set(eventId, replacement);
          }
        }
      }),
    );
  }
  return { latest, editIds };
}

/** Slack message id for current (v2) or first-generation (v1) projections. */
function projectedSlackMessageId(content: Record<string, unknown>): string | undefined {
  const origin = object(object(content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.origin);
  if (origin) {
    return origin.provider === "slack" && typeof origin.messageId === "string"
      ? origin.messageId
      : undefined;
  }
  const legacy = object(content[LEGACY_SESSION_PROJECTION_KEY]);
  return legacy?.sourceChannel === "slack" && typeof legacy.messageId === "string"
    ? legacy.messageId
    : undefined;
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

export async function reconcileMatrixProjectionSnapshot(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  threadId: string;
  snapshot: unknown;
  retireThreadId?: string;
}) {
  const deadline = Date.now() + 45_000;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error("Matrix snapshot reconciliation deadline exceeded");
    }
  };
  const snapshot = parseSourceProjectionSnapshot(params.snapshot);
  const sourceIds = new Set(snapshot.messages.map((message) => message.messageId));
  await withResolvedMatrixSendClient(
    { cfg: params.cfg, accountId: params.accountId, timeoutMs: 10_000 },
    async (client) => {
      const events = await readProjectionHistory(
        client,
        params.roomId,
        params.threadId,
        checkDeadline,
      );
      const self = await client.getUserId();
      const threadOriginals = events.toReversed().filter((event) => {
        if (
          event.sender !== self ||
          event.unsigned?.redacted_because ||
          event.type !== "m.room.message"
        ) {
          return false;
        }
        const relation = object(object(event.content)?.["m.relates_to"]);
        return relation?.rel_type === "m.thread" && relation.event_id === params.threadId;
      });
      const { latest: latestEdits, editIds } = await readSelfEdits(
        client,
        params.roomId,
        threadOriginals.map((event) => event.event_id),
        self,
        checkDeadline,
      );
      const originals = new Map<
        string,
        Array<{ eventId: string; content: Record<string, unknown> }>
      >();
      const notices: string[] = [];
      for (const event of threadOriginals) {
        const current = latestEdits.get(event.event_id) ?? object(event.content);
        if (!current) {
          continue;
        }
        // Earlier in-place edits could drop the projection marker; the original
        // event still identifies the source message, and the next edit restores it.
        const messageId =
          projectedSlackMessageId(current) ?? projectedSlackMessageId(object(event.content) ?? {});
        if (!messageId) {
          if (isMatrixBindingNoticeText(current.body)) {
            notices.push(event.event_id);
          }
          continue;
        }
        const group = originals.get(messageId) ?? [];
        group.push({ eventId: event.event_id, content: current });
        originals.set(messageId, group);
      }
      for (const message of snapshot.messages) {
        checkDeadline();
        const contentHash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const existing = originals.get(message.messageId) ?? [];
        const revision = Math.max(
          0,
          ...existing.map(
            (event) =>
              Number(
                object(event.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.publicationRevision,
              ) || 0,
          ),
        );
        const currentParts = existing.filter(
          (event) =>
            object(event.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.publicationRevision ===
            revision,
        );
        const sameRevision = currentParts.some(
          (event) =>
            object(event.content[SOURCE_CONTENT_REVISION_KEY])?.contentHash === contentHash,
        );
        const expectedParts = Number(
          object(currentParts[0]?.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.partCount,
        );
        const indexes = new Set(
          currentParts.map(
            (event) => object(event.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.partIndex,
          ),
        );
        const complete =
          sameRevision &&
          Number.isSafeInteger(expectedParts) &&
          expectedParts > 0 &&
          expectedParts <= 256 &&
          indexes.size === expectedParts &&
          Array.from({ length: expectedParts }, (_, index) => index).every((index) =>
            indexes.has(index),
          ) &&
          currentParts.some(
            (event) =>
              object(event.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.complete === true,
          );
        // The earliest copy of each current wire part is kept; any other copy
        // (a repeated slot, an older revision or a legacy v1 mirror) converges.
        const kept = new Map<unknown, string>();
        for (const event of currentParts) {
          const index = object(event.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.partIndex;
          if (!kept.has(index)) {
            kept.set(index, event.eventId);
          }
        }
        const keptIds = new Set(complete ? kept.values() : []);
        // Clients order a thread by Matrix event time. A single-part message
        // whose earliest copy is not current is re-published into that slot;
        // chunked parts cannot be merged into one event and keep their slots.
        const unchanged =
          complete && (expectedParts > 1 || keptIds.has(existing[0]?.eventId ?? ""));
        const targetRevision = sameRevision ? revision : revision + 1;
        const binding = getSessionBindingService().resolveByConversation({
          channel: "matrix",
          accountId: params.accountId,
          conversationId: params.threadId,
          parentConversationId: params.roomId,
        });
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
              publicationRevision: targetRevision,
            })
          : undefined;
        const extraContent = { [SOURCE_CONTENT_REVISION_KEY]: { contentHash } };
        const body = projectionText({
          channel: "slack",
          role: message.role,
          text: message.content || "[Message has no text]",
          senderId: message.senderId,
          agentId: message.agentId,
          displayName: message.displayName,
        });
        let retainedEventId: string | undefined;
        if (!unchanged) {
          // Clients order a thread by Matrix event time, not source time. Keep
          // the earliest copy so converged history retains Slack's order.
          const editable = existing[0];
          const acceptedMessageId =
            editable && publication
              ? await editMessageMatrix(params.roomId, editable.eventId, body, {
                  cfg: params.cfg,
                  accountId: params.accountId,
                  client,
                  threadId: params.threadId,
                  extraContent,
                  publication,
                }).then(() => editable.eventId)
              : await sendMessageMatrix(`room:${params.roomId}`, body, {
                  cfg: params.cfg,
                  accountId: params.accountId,
                  client,
                  threadId: params.threadId,
                  extraContent,
                  publication,
                  deliveryQueueId: `matrix-slack-source:${params.roomId}:${params.threadId}:${message.messageId}:${targetRevision}`,
                  deliveryPartIndex: 0,
                  deliveryPartCount: 1,
                }).then((accepted) => accepted.messageId);
          retainedEventId = editable?.eventId;
          if (binding && publication) {
            await noteMatrixSourceSnapshotResult(
              binding.bindingId,
              message.messageId,
              params.roomId,
              acceptedMessageId,
            );
          }
        } else if (binding && publication) {
          const final = currentParts.find(
            (part) =>
              keptIds.has(part.eventId) &&
              object(part.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.partIndex ===
                expectedParts - 1,
          );
          if (final) {
            await noteMatrixSourceSnapshotResult(
              binding.bindingId,
              message.messageId,
              params.roomId,
              final.eventId,
            );
          }
        }
        // Retire copies only after the retained event was accepted.
        const obsolete = unchanged
          ? existing.filter((event) => !keptIds.has(event.eventId))
          : existing.filter((event) => event.eventId !== retainedEventId);
        for (const duplicate of obsolete) {
          for (const eventId of [...(editIds.get(duplicate.eventId) ?? []), duplicate.eventId]) {
            checkDeadline();
            await client.redactEvent(params.roomId, eventId, "Reconciled duplicate source message");
          }
        }
      }
      for (const [messageId, originalsForMessage] of originals) {
        checkDeadline();
        if (sourceIds.has(messageId)) {
          continue;
        }
        for (const original of originalsForMessage) {
          for (const eventId of [...(editIds.get(original.eventId) ?? []), original.eventId]) {
            await client.redactEvent(params.roomId, eventId, "Deleted in Slack");
          }
        }
      }
      // A source transcript contains source messages only; binder chatter
      // (intro and "session active" notices) is retired once history is present.
      for (const notice of notices) {
        for (const eventId of [...(editIds.get(notice) ?? []), notice]) {
          checkDeadline();
          await client.redactEvent(params.roomId, eventId, "Retired binding notice");
        }
      }
      // Only after the complete new generation is present may hidden legacy
      // mirrors be retired. Replays retry redaction without duplicating messages.
      if (params.retireThreadId && params.retireThreadId !== params.threadId) {
        for (const event of events) {
          if (event.sender !== self || event.unsigned?.redacted_because) {
            continue;
          }
          const content = object(event.content);
          const relation = object(content?.["m.relates_to"]);
          const metadata = object(content?.[MATRIX_SESSION_PROJECTION_CONTENT_KEY]);
          const oldSource =
            relation?.rel_type === "m.thread" &&
            relation.event_id === params.retireThreadId &&
            object(metadata?.origin)?.provider === "slack";
          if (!oldSource && event.event_id !== params.retireThreadId) {
            continue;
          }
          for (const eventId of [...(editIds.get(event.event_id) ?? []), event.event_id]) {
            checkDeadline();
            await client.redactEvent(params.roomId, eventId, "Rebased shared projection history");
          }
        }
      }
    },
  );
}
