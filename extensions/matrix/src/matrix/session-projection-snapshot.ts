import { createHash } from "node:crypto";
import { setTimeout as yieldToEventLoop } from "node:timers/promises";
import type { Direction } from "matrix-js-sdk/lib/models/event-timeline.js";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-binding-runtime";
import type { CoreConfig } from "../types.js";
import {
  createMatrixSourcePublication,
  matrixPublicationContent,
  MATRIX_PROJECTION_CONTENT_KEY,
} from "./projection-publication.js";
import { noteMatrixSourceSnapshotResult } from "./projection-source-result.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";
import { editMessageMatrix, sendMessageMatrix } from "./send.js";
import { withResolvedMatrixSendClient } from "./send/client.js";
export const MATRIX_SESSION_PROJECTION_CONTENT_KEY = MATRIX_PROJECTION_CONTENT_KEY;
const SOURCE_CONTENT_REVISION_KEY = "com.openclaw.source_revision";
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
      const latestEdits = new Map<string, Record<string, unknown>>();
      const editIds = new Map<string, string[]>();
      const originals = new Map<
        string,
        Array<{ eventId: string; content: Record<string, unknown> }>
      >();
      // History is newest first, so the first same-author replacement wins.
      for (const event of events) {
        if (
          event.sender !== self ||
          event.unsigned?.redacted_because ||
          event.type !== "m.room.message"
        ) {
          continue;
        }
        const content = object(event.content);
        const relation = object(content?.["m.relates_to"]);
        if (relation?.rel_type === "m.replace" && typeof relation.event_id === "string") {
          const ids = editIds.get(relation.event_id) ?? [];
          ids.push(event.event_id);
          editIds.set(relation.event_id, ids);
          const replacement = object(content?.["m.new_content"]);
          if (replacement && !latestEdits.has(relation.event_id)) {
            latestEdits.set(relation.event_id, replacement);
          }
        }
      }
      for (const event of events.toReversed()) {
        if (
          event.sender !== self ||
          event.unsigned?.redacted_because ||
          event.type !== "m.room.message"
        ) {
          continue;
        }
        const content = object(event.content);
        if (object(content?.["m.relates_to"])?.rel_type === "m.replace") {
          continue;
        }
        const relation = object(content?.["m.relates_to"]);
        if (relation?.rel_type !== "m.thread" || relation.event_id !== params.threadId) {
          continue;
        }
        const current = latestEdits.get(event.event_id) ?? content;
        const metadata = object(current?.[MATRIX_SESSION_PROJECTION_CONTENT_KEY]);
        const origin = object(metadata?.origin);
        if (origin?.provider !== "slack" || typeof origin.messageId !== "string" || !current) {
          continue;
        }
        const group = originals.get(origin.messageId) ?? [];
        group.push({ eventId: event.event_id, content: current });
        originals.set(origin.messageId, group);
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
        const unchanged =
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
          const editable = currentParts[0] ?? existing[0];
          const acceptedMessageId =
            editable && publication
              ? await editMessageMatrix(params.roomId, editable.eventId, body, {
                  cfg: params.cfg,
                  accountId: params.accountId,
                  client,
                  threadId: params.threadId,
                  extraContent: {
                    ...extraContent,
                    [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: matrixPublicationContent(
                      publication,
                      params.roomId,
                      0,
                      1,
                    ),
                  },
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
        // Replace only after every new wire part was accepted. Chunked original
        // events are parts, not duplicate source messages; preserve their slots.
        const slots = new Set<string>();
        const obsolete = sameRevision
          ? existing.filter((event) => {
              const metadata = object(event.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY]);
              if (metadata?.publicationRevision !== targetRevision) {
                return true;
              }
              const slot = JSON.stringify([metadata?.publicationRevision, metadata?.partIndex]);
              if (slots.has(slot)) {
                return true;
              }
              slots.add(slot);
              return false;
            })
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
