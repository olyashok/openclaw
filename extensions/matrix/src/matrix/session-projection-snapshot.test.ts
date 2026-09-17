import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MATRIX_SESSION_PROJECTION_CONTENT_KEY,
  reconcileMatrixProjectionSnapshot,
} from "./session-projection-snapshot.js";

const mocks = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  read: vi.fn(),
  send: vi.fn(),
  edit: vi.fn(),
  redact: vi.fn(),
}));
vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: async (_opts: unknown, run: (client: unknown) => Promise<void>) =>
    run({
      doRequest: mocks.read,
      hydrateEvents: async (_room: string, events: unknown[]) => events,
      getUserId: async () => "@transport:example.org",
      redactEvent: mocks.redact,
    }),
}));
vi.mock("./send.js", () => ({ sendMessageMatrix: mocks.send, editMessageMatrix: mocks.edit }));

const message = {
  messageId: "1700000000.000001",
  senderId: "U111",
  role: "user" as const,
  content: "Before",
};
const options = { cfg: {} as never, accountId: "fi-user", roomId: "!room", threadId: "$root" };
describe("Matrix source snapshot reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.read.mockImplementation(async () => ({ chunk: [...mocks.events].toReversed() }));
    mocks.send.mockImplementation(
      async (
        _to: string,
        body: string,
        opts: { extraContent: Record<string, unknown>; threadId: string },
      ) => {
        mocks.events.push({
          event_id: "$original",
          sender: "@transport:example.org",
          type: "m.room.message",
          content: {
            body,
            ...opts.extraContent,
            "m.relates_to": { rel_type: "m.thread", event_id: opts.threadId },
          },
        });
      },
    );
    mocks.edit.mockImplementation(
      async (
        _room: string,
        original: string,
        body: string,
        opts: { extraContent: Record<string, unknown> },
      ) => {
        mocks.events.push({
          event_id: "$edit",
          sender: "@transport:example.org",
          type: "m.room.message",
          content: {
            "m.relates_to": { rel_type: "m.replace", event_id: original },
            "m.new_content": { body, ...opts.extraContent },
          },
        });
      },
    );
    mocks.redact.mockImplementation(async (_room: string, eventId: string) => {
      const event = mocks.events.find((entry) => entry.event_id === eventId);
      if (event) {
        event.unsigned = { redacted_because: {} };
      }
    });
  });
  it.each([
    undefined,
    null,
    { complete: "true", messages: [] },
    { complete: 1, messages: [] },
    { complete: false, messages: [] },
    { complete: true, messages: [null] },
    { complete: true, messages: [{ ...message, agentId: 1 }] },
  ])("rejects invalid runtime snapshot %# before reading or changing history", async (snapshot) => {
    await expect(reconcileMatrixProjectionSnapshot({ ...options, snapshot })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
  it("edits the original event and replays idempotently without duplicate messages", async () => {
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [message] },
    });
    const changed = { ...message, content: "After" };
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [changed] },
    });
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [changed] },
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.edit).toHaveBeenCalledWith(
      "!room",
      "$original",
      "**Slack · U111**\nAfter",
      expect.objectContaining({
        extraContent: {
          [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: expect.objectContaining({
            messageId: message.messageId,
          }),
        },
      }),
    );
  });
  it("retires an unchanged source-owned duplicate while preserving another sender's event", async () => {
    const params = { ...options, snapshot: { complete: true, messages: [message] } };
    await reconcileMatrixProjectionSnapshot(params);
    const original = mocks.events[0];
    if (!original) {
      throw new Error("Expected original projection event");
    }
    mocks.events.push(
      { ...original, event_id: "$duplicate" },
      { ...original, event_id: "$unrelated", sender: "@other:example.org" },
    );
    await reconcileMatrixProjectionSnapshot(params);
    await reconcileMatrixProjectionSnapshot(params);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.redact).toHaveBeenCalledTimes(1);
    expect(mocks.redact).toHaveBeenCalledWith(
      "!room",
      "$duplicate",
      "Reconciled duplicate source message",
    );
  });
  it("rebases a hidden generation idempotently and retires only its mirrors after complete replay", async () => {
    mocks.events.push(
      {
        event_id: "$old-root",
        sender: "@transport:example.org",
        type: "m.room.message",
        content: { body: "Old root" },
      },
      {
        event_id: "$old-message",
        sender: "@transport:example.org",
        type: "m.room.message",
        content: {
          "m.relates_to": { rel_type: "m.thread", event_id: "$old-root" },
          [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: {
            sourceChannel: "slack",
            messageId: message.messageId,
          },
        },
      },
      {
        event_id: "$cron",
        sender: "@transport:example.org",
        type: "m.room.message",
        content: { body: "Unrelated cron" },
      },
    );
    const params = {
      ...options,
      retireThreadId: "$old-root",
      snapshot: { complete: true, messages: [message] },
    };
    mocks.send.mockRejectedValueOnce(new Error("send failed"));
    await expect(reconcileMatrixProjectionSnapshot(params)).rejects.toThrow("send failed");
    expect(mocks.redact).not.toHaveBeenCalled();
    await reconcileMatrixProjectionSnapshot(params);
    await reconcileMatrixProjectionSnapshot(params);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenLastCalledWith(
      "room:!room",
      expect.any(String),
      expect.objectContaining({
        deliveryQueueId: `matrix-slack-source:!room:$root:${message.messageId}`,
      }),
    );
    expect(
      mocks.redact.mock.calls
        .map((call) => call[1])
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["$old-message", "$old-root"]);
  });
  it("retains an unmatched legacy DM answer when Slack delivery never succeeded", async () => {
    for (const [eventId, body] of [
      ["$matched", "**Slack · Assistant**\nDelivered"],
      ["$unmatched", "**Slack · Assistant**\nOnly Matrix received this"],
    ]) {
      mocks.events.push({
        event_id: eventId,
        sender: "@transport:example.org",
        type: "m.room.message",
        content: {
          body,
          "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
          [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: {
            sourceChannel: "slack",
            role: "assistant",
            runId: eventId,
          },
        },
      });
    }
    await reconcileMatrixProjectionSnapshot({
      ...options,
      retireLegacyDirectReplies: true,
      snapshot: {
        complete: true,
        messages: [{ ...message, role: "assistant", content: "Delivered" }],
      },
    });
    expect(mocks.redact.mock.calls.map((call) => call[1])).toEqual(["$matched"]);
  });
  it("redacts a deleted source message once, without touching unrelated history", async () => {
    mocks.events.push({
      event_id: "$unrelated",
      sender: "@person:example.org",
      type: "m.room.message",
      content: { body: "Not projected" },
    });
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [message] },
    });
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [] },
    });
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [] },
    });
    expect(mocks.redact).toHaveBeenCalledTimes(1);
    expect(mocks.redact).toHaveBeenCalledWith("!room", "$original", "Deleted in Slack");
  });
  it("makes no mutations if Matrix history pagination is incomplete", async () => {
    mocks.read.mockResolvedValue({
      chunk: [{ event_id: "$e", type: "m.room.message", content: {} }],
      end: "repeated",
    });
    await expect(
      reconcileMatrixProjectionSnapshot({ ...options, snapshot: { complete: true, messages: [] } }),
    ).rejects.toThrow("pagination");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
});
