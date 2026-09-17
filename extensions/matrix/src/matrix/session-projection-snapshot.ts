import { createHash } from "node:crypto";
import type { CoreConfig } from "../types.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";
import { editMessageMatrix, sendMessageMatrix } from "./send.js";
import { withResolvedMatrixSendClient } from "./send/client.js";

export const MATRIX_SESSION_PROJECTION_CONTENT_KEY = "com.openclaw.session_projection";
export type SourceProjectionMessage = {
  messageId: string;
  senderId: string;
  content: string;
  role: "user" | "assistant";
  agentId?: string;
};
export type SourceProjectionSnapshot = { complete: true; messages: SourceProjectionMessage[] };

export function projectionText(params: {
  channel: string;
  role: "user" | "assistant";
  text: string;
  senderId?: string;
  agentId?: string;
}): string {
  const author = params.agentId || params.senderId;
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

async function readProjectionHistory(
  client: MatrixClient,
  roomId: string,
  checkDeadline: () => void,
) {
  const events: MatrixRawEvent[] = [];
  let from: string | undefined;
  const cursors = new Set<string>();
  // A complete bounded read is required before changing or deleting anything.
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    checkDeadline();
    const page = (await client.doRequest(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { dir: "b", limit: 100, from },
    )) as { chunk: MatrixRawEvent[]; end?: string };
    if (!Array.isArray(page.chunk)) {
      throw new Error("Invalid Matrix projection history");
    }
    const hydrated = await client.hydrateEvents(roomId, page.chunk);
    if (hydrated.some((event) => event.type === "m.room.encrypted")) {
      throw new Error("Incomplete decrypted Matrix projection history");
    }
    events.push(...hydrated);
    if (!page.chunk.length || !page.end) {
      return events;
    }
    if (cursors.has(page.end)) {
      throw new Error("Incomplete Matrix projection history pagination");
    }
    cursors.add(page.end);
    from = page.end;
  }
  throw new Error("Matrix projection history exceeds reconciliation bound");
}

export async function reconcileMatrixProjectionSnapshot(params: {
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  threadId: string;
  snapshot: unknown;
}) {
  const deadline = Date.now() + 45_000;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error("Matrix snapshot reconciliation deadline exceeded");
    }
  };
  const rawSnapshot = object(params.snapshot);
  if (
    rawSnapshot?.complete !== true ||
    !Array.isArray(rawSnapshot.messages) ||
    rawSnapshot.messages.length > 1000
  ) {
    throw new Error("Complete bounded source snapshot required");
  }
  const messages: SourceProjectionMessage[] = [];
  const sourceIds = new Set<string>();
  for (const rawMessage of rawSnapshot.messages) {
    const message = object(rawMessage);
    if (
      !message ||
      typeof message.messageId !== "string" ||
      !/^\d+\.\d+$/.test(message.messageId) ||
      sourceIds.has(message.messageId) ||
      typeof message.content !== "string" ||
      typeof message.senderId !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      (message.agentId !== undefined && typeof message.agentId !== "string")
    ) {
      throw new Error("Invalid source snapshot message");
    }
    sourceIds.add(message.messageId);
    messages.push({
      messageId: message.messageId,
      senderId: message.senderId,
      content: message.content,
      role: message.role,
      agentId: message.agentId,
    });
  }
  const snapshot: SourceProjectionSnapshot = { complete: true, messages };
  await withResolvedMatrixSendClient(
    { cfg: params.cfg, accountId: params.accountId, timeoutMs: 10_000 },
    async (client) => {
      const events = await readProjectionHistory(client, params.roomId, checkDeadline);
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
        const current = latestEdits.get(event.event_id) ?? content;
        const metadata = object(current?.[MATRIX_SESSION_PROJECTION_CONTENT_KEY]);
        if (
          metadata?.sourceChannel !== "slack" ||
          typeof metadata.messageId !== "string" ||
          !current
        ) {
          continue;
        }
        const group = originals.get(metadata.messageId) ?? [];
        group.push({ eventId: event.event_id, content: current });
        originals.set(metadata.messageId, group);
      }
      for (const message of snapshot.messages) {
        checkDeadline();
        const contentHash = createHash("sha256").update(JSON.stringify(message)).digest("hex");
        const metadata = {
          version: 1,
          sourceChannel: "slack",
          role: message.role,
          senderId: message.senderId,
          messageId: message.messageId,
          ...(message.agentId ? { agentId: message.agentId } : {}),
          contentHash,
        };
        const extraContent = { [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: metadata };
        const body = projectionText({
          channel: "slack",
          role: message.role,
          text: message.content || "[Message has no text]",
          senderId: message.senderId,
          agentId: message.agentId,
        });
        const existing = originals.get(message.messageId) ?? [];
        const first = existing[0];
        if (!first) {
          await sendMessageMatrix(`room:${params.roomId}`, body, {
            cfg: params.cfg,
            accountId: params.accountId,
            client,
            threadId: params.threadId,
            extraContent,
            deliveryQueueId: `matrix-slack-source:${params.roomId}:${message.messageId}`,
            deliveryPartIndex: 0,
            deliveryPartCount: 1,
          });
        } else if (
          object(first.content[MATRIX_SESSION_PROJECTION_CONTENT_KEY])?.contentHash !== contentHash
        ) {
          await editMessageMatrix(params.roomId, first.eventId, body, {
            cfg: params.cfg,
            accountId: params.accountId,
            client,
            extraContent,
          });
          for (const duplicate of existing.slice(1)) {
            for (const eventId of [...(editIds.get(duplicate.eventId) ?? []), duplicate.eventId]) {
              await client.redactEvent(params.roomId, eventId, "Reconciled source message edit");
            }
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
    },
  );
}
