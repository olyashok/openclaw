import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixSourcePublication,
  matrixPublicationContent,
  type MatrixPublication,
} from "./projection-publication.js";
import {
  reconcileMatrixProjectionSnapshot,
  MATRIX_SESSION_PROJECTION_CONTENT_KEY as key,
} from "./session-projection-snapshot.js";
const mocks = vi.hoisted(() => ({
  events: [] as any[],
  // Tuwunel neither bundles edits nor lists them under a thread relation;
  // with realEdits they are visible only through their own m.replace read.
  realEdits: false,
  edits: [] as any[],
  getRelations: vi.fn(),
  hydrate: vi.fn(),
  send: vi.fn(),
  edit: vi.fn(),
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
      getRelations: mocks.getRelations,
      hydrateEvents: mocks.hydrate,
      getUserId: async () => "@transport:example.org",
      getEvent: async (_roomId: string, eventId: string) =>
        mocks.events.find((candidate) => candidate.event_id === eventId) ?? null,
      redactEvent: mocks.redact,
    }),
}));
vi.mock("./send.js", () => ({
  sendMessageMatrix: mocks.send,
  editMessageMatrix: mocks.edit,
}));
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
    mocks.edits.length = 0;
    mocks.realEdits = false;
    mocks.binding.mockReturnValue({
      bindingId: "binding",
      metadata: {
        environment: "test",
        projectedConversationId: "conversation",
        sourceAccountId: "source",
      },
    });
    mocks.getRelations.mockImplementation(async (_room: string, eventId: string, rel: string) => ({
      events:
        rel === "m.replace"
          ? mocks.edits
              .filter((edit) => edit.content["m.relates_to"].event_id === eventId)
              .toReversed()
          : [...mocks.events].toReversed(),
      nextBatch: null,
      prevBatch: null,
    }));
    mocks.hydrate.mockImplementation(async (_room: string, events: unknown[]) => events);
    mocks.send.mockImplementation(
      async (
        _to: string,
        body: string,
        opts: { publication: MatrixPublication; extraContent: Record<string, unknown> },
      ) => ({ messageId: insert(body, opts.publication, opts.extraContent) }),
    );
    mocks.edit.mockImplementation(
      async (
        _roomId: string,
        eventId: string,
        body: string,
        opts: { extraContent: Record<string, unknown>; publication?: MatrixPublication },
      ) => {
        // Mirror send.ts: caller-supplied projection metadata is a forgery and
        // is stripped; only the trusted publication capability is applied.
        const { [key]: _forged, ...ordinary } = opts.extraContent ?? {};
        const replacement = {
          ...ordinary,
          ...(opts.publication
            ? { [key]: matrixPublicationContent(opts.publication, "!room", 0, 1) }
            : {}),
        };
        const matchedEvent = mocks.events.find((candidate) => candidate.event_id === eventId);
        if (!matchedEvent) {
          throw new Error("missing edit target");
        }
        if (mocks.realEdits) {
          mocks.edits.push({
            event_id: `$edit${mocks.edits.length}`,
            sender: "@transport:example.org",
            type: "m.room.message",
            content: {
              body: `* ${body}`,
              "m.new_content": { body, ...replacement },
              "m.relates_to": { rel_type: "m.replace", event_id: eventId },
            },
          });
          return `$edit${mocks.edits.length}`;
        }
        matchedEvent.content = {
          ...matchedEvent.content,
          ...replacement,
          body,
        };
        return `$edit${mocks.edit.mock.calls.length}`;
      },
    );
    mocks.redact.mockImplementation(async (_room: string, id: string) => {
      const matchedEvent = mocks.events.find((candidate) => candidate.event_id === id);
      if (matchedEvent) {
        matchedEvent.unsigned = { redacted_because: {} };
      }
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
    expect(mocks.getRelations).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("updates an existing source event in place without moderator redaction power", async () => {
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
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.redact).not.toHaveBeenCalled();
    expect(mocks.events[0].content[key]).toMatchObject({
      publicationRevision: 2,
      origin: { messageId: message.messageId, publishedAtMs: 1700000000000 },
    });
    expect(mocks.events[0].content.body).toBe("**Slack · Actual Actor**\nAfter");
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
  it("repairs an incomplete publication in its original event slot", async () => {
    mocks.send.mockImplementationOnce(async (_to: string, body: string, opts: any) => {
      insert(body, opts.publication, opts.extraContent, 0, 2);
      throw new Error("ambiguous send");
    });
    const params = { ...options, snapshot: { complete: true, messages: [message] } };
    await expect(reconcileMatrixProjectionSnapshot(params)).rejects.toThrow("ambiguous");
    expect(mocks.redact).not.toHaveBeenCalled();
    await reconcileMatrixProjectionSnapshot(params);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(
      matrixPublicationContent(mocks.edit.mock.calls[0]?.[3].publication, "!room", 0, 1),
    ).toMatchObject({
      publicationRevision: 1,
      partIndex: 0,
      partCount: 1,
      complete: true,
    });
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
  it("reads only the selected projection thread", async () => {
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [] },
    });
    expect(mocks.getRelations).toHaveBeenCalledWith("!room", "$root", "m.thread", undefined, {
      dir: "b",
      limit: 100,
      from: undefined,
    });
  });
  it("hydrates old encrypted history in cooperative batches", async () => {
    mocks.events.push(
      ...Array.from({ length: 9 }, (_, index) => ({
        event_id: `$foreign-${index}`,
        sender: "@foreign:example.org",
        type: "m.room.message",
        content: {},
      })),
    );
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [] },
    });
    expect(mocks.hydrate.mock.calls.map(([, events]) => events.length)).toEqual([4, 4, 1]);
  });
  it("makes no mutations on incomplete pagination", async () => {
    mocks.getRelations.mockResolvedValue({
      events: [{ event_id: "$event", type: "m.room.message", content: {} }],
      nextBatch: "repeated",
      prevBatch: null,
    });
    await expect(
      reconcileMatrixProjectionSnapshot({ ...options, snapshot: { complete: true, messages: [] } }),
    ).rejects.toThrow("pagination");
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
  it("converges legacy v1 and repeated v2 copies into the earliest event, then stays idle", async () => {
    mocks.realEdits = true;
    const thread = { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } };
    mocks.events.push({
      event_id: "$legacy",
      sender: "@transport:example.org",
      type: "m.room.message",
      content: {
        body: "**Slack · U111**\nBefore",
        "com.openclaw.session_projection": {
          version: 1,
          sourceChannel: "slack",
          messageId: message.messageId,
          senderId: "U111",
          role: "user",
        },
        ...thread,
      },
    });
    const publication = (publicationRevision: number, displayName?: string) =>
      createMatrixSourcePublication({
        bindingId: "binding",
        roomId: "!room",
        threadId: "$root",
        provider: "slack",
        accountId: "account",
        messageId: message.messageId,
        actorId: "U111",
        publishedAtMs: 1700000000000,
        role: "user",
        displayName,
        publicationRevision,
      });
    // Three historical revisions whose superseded copies could not be retired.
    insert("**Slack · Actor**\nBefore", publication(1, "Actor")!, {});
    insert("**Slack · U111**\nBefore", publication(2)!, {});
    insert("**Slack · Actor**\nBefore", publication(3, "Actor")!, {});
    const snapshot = { complete: true, messages: [{ ...message, displayName: "Actor" }] };

    await reconcileMatrixProjectionSnapshot({ ...options, snapshot });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    expect(mocks.edit.mock.calls[0]?.[1]).toBe("$legacy");
    expect(mocks.redact.mock.calls.map((call) => call[1]).toSorted()).toEqual([
      "$event1",
      "$event2",
      "$event3",
    ]);

    vi.clearAllMocks();
    await reconcileMatrixProjectionSnapshot({ ...options, snapshot });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
  it("recognizes a source message whose earlier edit lost its projection marker", async () => {
    mocks.realEdits = true;
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [message] },
    });
    // A replacement written before edits carried the trusted publication.
    mocks.edits.push({
      event_id: "$markerless",
      sender: "@transport:example.org",
      type: "m.room.message",
      content: {
        body: "* **Slack · Actor**\nBefore",
        "m.new_content": { body: "**Slack · Actor**\nBefore" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$event0" },
      },
    });
    const snapshot = { complete: true, messages: [{ ...message, displayName: "Actor" }] };
    vi.clearAllMocks();
    await reconcileMatrixProjectionSnapshot({ ...options, snapshot });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    await reconcileMatrixProjectionSnapshot({ ...options, snapshot });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.redact).not.toHaveBeenCalled();
  });
  it("retires own binding notices from the transcript and nothing else", async () => {
    const thread = { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } };
    const own = (event_id: string, body: string, sender = "@transport:example.org") =>
      mocks.events.push({ event_id, sender, type: "m.room.message", content: { body, ...thread } });
    own("$intro", "Read-only Slack conversation history. Continue in Slack.");
    own(
      "$active",
      "⚙️ Slack channel thread session active. Messages here go directly to this session.",
    );
    own("$reply", "Here is the budget variance you asked for.");
    own(
      "$foreign",
      "⚙️ x session active. Messages here go directly to this session.",
      "@human:example.org",
    );
    await reconcileMatrixProjectionSnapshot({
      ...options,
      snapshot: { complete: true, messages: [message] },
    });
    expect(mocks.redact.mock.calls.map((call) => call[1]).toSorted()).toEqual([
      "$active",
      "$intro",
    ]);
  });
});
