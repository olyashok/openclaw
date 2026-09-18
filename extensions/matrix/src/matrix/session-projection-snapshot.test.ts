import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixPublicationContent, type MatrixPublication } from "./projection-publication.js";
import {
  reconcileMatrixProjectionSnapshot,
  MATRIX_SESSION_PROJECTION_CONTENT_KEY as key,
} from "./session-projection-snapshot.js";
const mocks = vi.hoisted(() => ({
  events: [] as any[],
  read: vi.fn(),
  send: vi.fn(),
  redact: vi.fn(),
  note: vi.fn(),
  binding: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({ resolveByConversation: mocks.binding }),
}));
vi.mock("./projection-source-result.js", () => ({ noteMatrixSourceSnapshotResult: mocks.note }));
vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: async (_opts: unknown, run: (client: unknown) => Promise<void>) =>
    run({
      doRequest: mocks.read,
      hydrateEvents: async (_room: string, events: unknown[]) => events,
      getUserId: async () => "@transport:example.org",
      redactEvent: mocks.redact,
    }),
}));
vi.mock("./send.js", () => ({ sendMessageMatrix: mocks.send }));
const message = {
  messageId: "1700000000.000001",
  senderId: "U111",
  role: "user" as const,
  content: "Before",
};
const options = { cfg: {} as never, accountId: "account", roomId: "!room", threadId: "$root" };
function insert(
  body: string,
  publication: MatrixPublication,
  extraContent: Record<string, unknown>,
  index = 0,
  count = 1,
) {
  const eventId = `$event${mocks.events.length}`;
  mocks.events.push({
    event_id: eventId,
    sender: "@transport:example.org",
    type: "m.room.message",
    content: {
      body,
      ...extraContent,
      [key]: matrixPublicationContent(publication, "!room", index, count),
      "m.relates_to": { rel_type: "m.thread", event_id: "$root" },
    },
  });
  return eventId;
}
describe("v2 source reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.binding.mockReturnValue({
      bindingId: "binding",
      metadata: {
        environment: "test",
        projectedConversationId: "conversation",
        sourceAccountId: "source",
      },
    });
    mocks.read.mockImplementation(async () => ({ chunk: [...mocks.events].toReversed() }));
    mocks.send.mockImplementation(
      async (
        _to: string,
        body: string,
        opts: { publication: MatrixPublication; extraContent: Record<string, unknown> },
      ) => ({ messageId: insert(body, opts.publication, opts.extraContent) }),
    );
    mocks.redact.mockImplementation(async (_room: string, id: string) => {
      const event = mocks.events.find((event) => event.event_id === id);
      if (event) event.unsigned = { redacted_because: {} };
    });
  });
  it.each([
    undefined,
    null,
    { complete: false, messages: [] },
    { complete: true, messages: [null] },
    { complete: true, messages: [{ ...message, displayName: "bad\nactor" }] },
  ])("rejects invalid snapshot %# before reads", async (snapshot) => {
    await expect(reconcileMatrixProjectionSnapshot({ ...options, snapshot })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("publishes edits as new immutable revisions then retires the old batch", async () => {
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [message] },
    });
    const changed = { ...message, content: "After", displayName: "Actual Actor" };
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [changed] },
    });
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [changed] },
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.redact).toHaveBeenCalledTimes(1);
    expect(mocks.events[1].content[key]).toMatchObject({
      publicationRevision: 2,
      origin: { messageId: message.messageId, publishedAtMs: 1700000000000 },
    });
    expect(mocks.events[1].content.body).toBe("**Slack · Actual Actor**\nAfter");
  });
  it("preserves distinct wire parts and retires only duplicate own slots", async () => {
    mocks.send.mockImplementationOnce(async (_to: string, body: string, opts: any) => {
      insert(body, opts.publication, opts.extraContent, 0, 2);
      return { messageId: insert(body, opts.publication, opts.extraContent, 1, 2) };
    });
    const params = { ...options, snapshot: { complete: true, messages: [message] } };
    await reconcileMatrixProjectionSnapshot(params);
    mocks.events.push(
      { ...mocks.events[0], event_id: "$duplicate" },
      { ...mocks.events[0], event_id: "$foreign", sender: "@foreign:example.org" },
    );
    await reconcileMatrixProjectionSnapshot(params);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.redact).toHaveBeenCalledWith(
      "!room",
      "$duplicate",
      "Reconciled duplicate source message",
    );
    expect(mocks.redact).toHaveBeenCalledTimes(1);
  });
  it("retries incomplete publication with original revision and stable queue identity", async () => {
    mocks.send.mockImplementationOnce(async (_to: string, body: string, opts: any) => {
      insert(body, opts.publication, opts.extraContent, 0, 2);
      throw new Error("ambiguous send");
    });
    const params = { ...options, snapshot: { complete: true, messages: [message] } };
    await expect(reconcileMatrixProjectionSnapshot(params)).rejects.toThrow("ambiguous");
    expect(mocks.redact).not.toHaveBeenCalled();
    await reconcileMatrixProjectionSnapshot(params);
    const firstSend = mocks.send.mock.calls[0],
      retry = mocks.send.mock.calls[1];
    if (!firstSend || !retry) throw new Error("Expected ambiguous send and publication retry");
    expect(firstSend[2].deliveryQueueId).toBe(retry[2].deliveryQueueId);
    expect(retry[2].publication.publicationRevision).toBe(1);
  });
  it("notes exact accepted snapshot event and retries unchanged rendezvous", async () => {
    const params = { ...options, snapshot: { complete: true, messages: [message] } };
    await reconcileMatrixProjectionSnapshot(params);
    await reconcileMatrixProjectionSnapshot(params);
    expect(mocks.note).toHaveBeenNthCalledWith(1, "binding", message.messageId, "!room", "$event0");
    expect(mocks.note).toHaveBeenCalledTimes(2);
  });
  it("redacts deleted source parts without deleting unrelated history", async () => {
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [message] },
    });
    mocks.events.push({
      event_id: "$foreign",
      sender: "@person:example.org",
      type: "m.room.message",
      content: { body: "Unrelated" },
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
    expect(mocks.redact).toHaveBeenCalledWith("!room", "$event0", "Deleted in Slack");
  });
  it("makes no mutations on incomplete pagination", async () => {
    mocks.read.mockResolvedValue({
      chunk: [{ event_id: "$event", type: "m.room.message", content: {} }],
      end: "repeated",
    });
    await expect(
      reconcileMatrixProjectionSnapshot({ ...options, snapshot: { complete: true, messages: [] } }),
    ).rejects.toThrow("pagination");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
});
