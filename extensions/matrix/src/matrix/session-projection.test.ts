// Matrix tests cover canonical-session projection into Matrix threads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMatrixSessionProjection,
  handleMatrixSessionProjectionMessageReceived,
  handleMatrixSessionProjectionReplyPayloadSending,
  MATRIX_SESSION_PROJECTION_BOUND_BY,
  MATRIX_SESSION_PROJECTION_CONTENT_KEY,
} from "./session-projection.js";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  getSessionEntry: vi.fn(),
  getThreadBindingManager: vi.fn(),
  listBySession: vi.fn(),
  resolveAgentId: vi.fn(() => "cellect-fi-user"),
  sendMessageMatrix: vi.fn(async (_to: string, _message: string, _opts: unknown) => ({
    messageId: "$sent",
    roomId: "!room",
  })),
  touch: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-scope-runtime", () => ({
  resolveSessionAgentIdStrict: mocks.resolveAgentId,
}));
vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({
    bind: mocks.bind,
    listBySession: mocks.listBySession,
    touch: mocks.touch,
  }),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: mocks.getSessionEntry,
}));
vi.mock("./accounts.js", () => ({
  resolveDefaultMatrixAccountId: () => "fi-user",
}));
vi.mock("./send.js", () => ({ sendMessageMatrix: mocks.sendMessageMatrix }));
vi.mock("./thread-bindings-shared.js", () => ({
  getMatrixThreadBindingManager: mocks.getThreadBindingManager,
}));

const cfg = {} as never;
const sessionKey = "agent:cellect-fi-user:slack:channel:C1:thread:1700000000.000001";
const projectionBinding = {
  bindingId: "fi-user:!room:$root",
  targetSessionKey: sessionKey,
  targetKind: "session" as const,
  conversation: {
    channel: "matrix",
    accountId: "fi-user",
    conversationId: "$root",
    parentConversationId: "!room",
  },
  status: "active" as const,
  boundAt: 1,
  metadata: { boundBy: MATRIX_SESSION_PROJECTION_BOUND_BY },
};

describe("Matrix session projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionEntry.mockReturnValue({ sessionId: "session-1" });
    mocks.getThreadBindingManager.mockReturnValue({});
    mocks.listBySession.mockReturnValue([]);
    mocks.bind.mockResolvedValue(projectionBinding);
  });

  it("creates one durable child-thread binding for an existing canonical session", async () => {
    await expect(
      createMatrixSessionProjection({
        cfg,
        targetSessionKey: sessionKey,
        roomId: "!room",
        label: "Slack invoice thread",
      }),
    ).resolves.toEqual({
      status: "created",
      accountId: "fi-user",
      agentId: "cellect-fi-user",
      roomId: "!room",
      threadRootEventId: "$root",
    });

    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: sessionKey,
        targetKind: "session",
        placement: "child",
        conversation: {
          channel: "matrix",
          accountId: "fi-user",
          conversationId: "!room",
        },
        metadata: expect.objectContaining({
          boundBy: MATRIX_SESSION_PROJECTION_BOUND_BY,
          label: "Slack invoice thread",
          idleTimeoutMs: 0,
          maxAgeMs: 0,
        }),
      }),
    );
  });

  it("returns the existing projection instead of creating a duplicate Matrix thread", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await expect(
      createMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).resolves.toMatchObject({ status: "existing", threadRootEventId: "$root" });
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("projects the triggering source message as part of binding creation", async () => {
    await createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      initialMessage: {
        sourceChannel: "slack",
        content: "Please check this invoice",
        messageId: "initial-1",
      },
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · User**\nPlease check this invoice",
      expect.objectContaining({
        deliveryQueueId:
          "matrix-session-projection:fi-user:!room:$root:user:initial-1:b8a13c395457031b",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    );
  });

  it("does not double-post the triggering message when the ordinary hook follows creation", async () => {
    await createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
      initialMessage: { sourceChannel: "slack", content: "One message", messageId: "initial-2" },
    });
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      { content: "One message", messageId: "initial-2", sessionKey },
      { channelId: "slack", sessionKey },
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent creates so only one Matrix root is posted", async () => {
    let releaseBind: (() => void) | undefined;
    mocks.bind.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBind = () => {
            mocks.listBySession.mockReturnValue([projectionBinding]);
            resolve(projectionBinding);
          };
        }),
    );

    const first = createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
    });
    const second = createMatrixSessionProjection({
      cfg,
      targetSessionKey: sessionKey,
      roomId: "!room",
    });
    await vi.waitFor(() => expect(mocks.bind).toHaveBeenCalledTimes(1));
    releaseBind?.();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: "created" },
      { status: "existing" },
    ]);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });

  it("fails closed before creating a thread for an unknown session", async () => {
    mocks.getSessionEntry.mockReturnValue(undefined);

    await expect(
      createMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).rejects.toThrow("target OpenClaw session does not exist");
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("fails with recovery guidance when the selected Matrix account is not running", async () => {
    mocks.getThreadBindingManager.mockReturnValue(null);

    await expect(
      createMatrixSessionProjection({ cfg, targetSessionKey: sessionKey, roomId: "!room" }),
    ).rejects.toThrow("Matrix account fi-user is not running");
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("projects Slack user messages with a stable delivery identity and semantic metadata", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      {
        content: "Please check this invoice",
        messageId: "1700000000.000001",
        runId: "run-1",
        sessionKey,
      },
      { channelId: "slack", sessionKey },
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · User**\nPlease check this invoice",
      expect.objectContaining({
        accountId: "fi-user",
        threadId: "$root",
        deliveryQueueId:
          "matrix-session-projection:fi-user:!room:$root:user:1700000000.000001:b8a13c395457031b",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
        extraContent: {
          [MATRIX_SESSION_PROJECTION_CONTENT_KEY]: {
            version: 1,
            role: "user",
            sourceChannel: "slack",
            messageId: "1700000000.000001",
            runId: "run-1",
          },
        },
      }),
    );
    expect(mocks.touch).toHaveBeenCalledWith(projectionBinding.bindingId);
  });

  it("projects only final visible assistant answers", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "slack", sessionKey, runId: "run-1" };

    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "progress", payload: { text: "Working…" }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      {
        kind: "final",
        payload: { text: "internal", isReasoning: true },
        sessionKey,
        runId: "run-1",
      },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "Invoice is approved." }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**Slack · Assistant**\nInvoice is approved.",
      expect.objectContaining({
        deliveryQueueId:
          "matrix-session-projection:fi-user:!room:$root:assistant:run-1:1b9108e6266ad652",
        deliveryPartIndex: 0,
        deliveryPartCount: 1,
      }),
    );
  });

  it("projects completed answer blocks without exposing technical or commentary lanes", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "webchat", sessionKey, runId: "run-block" };
    for (const payload of [
      { text: "reasoning", isReasoning: true },
      { text: "commentary", isCommentary: true },
      { text: "status", isStatusNotice: true },
      { text: "compaction", isCompactionNotice: true },
      { text: "fallback", isFallbackNotice: true },
    ]) {
      await handleMatrixSessionProjectionReplyPayloadSending(
        { kind: "block", payload, sessionKey, runId: "run-block" },
        context,
        cfg,
      );
    }
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "tool", payload: { text: "tool output" }, sessionKey, runId: "run-block" },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "block", payload: { text: "The completed answer." }, sessionKey, runId: "run-block" },
      context,
      cfg,
    );
    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    // A repeated final payload is the same answer, not a second Matrix event.
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "The completed answer." }, sessionKey, runId: "run-block" },
      context,
      cfg,
    );
    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageMatrix).toHaveBeenCalledWith(
      "room:!room",
      "**OpenClaw · Assistant**\nThe completed answer.",
      expect.objectContaining({ deliveryPartIndex: 0, deliveryPartCount: 1 }),
    );
  });

  it("gives separate final payload chunks stable, distinct delivery identities", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);
    const context = { channelId: "slack", sessionKey, runId: "run-1" };

    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "First chunk" }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );
    await handleMatrixSessionProjectionReplyPayloadSending(
      { kind: "final", payload: { text: "Second chunk" }, sessionKey, runId: "run-1" },
      context,
      cfg,
    );

    const deliveryIds = mocks.sendMessageMatrix.mock.calls.map(
      (call) => (call[2] as { deliveryQueueId: string }).deliveryQueueId,
    );
    expect(deliveryIds).toHaveLength(2);
    expect(new Set(deliveryIds).size).toBe(2);
    expect(deliveryIds.every((id) => id.includes(":assistant:run-1:"))).toBe(true);
  });

  it("never re-projects Matrix-origin messages", async () => {
    mocks.listBySession.mockReturnValue([projectionBinding]);

    await handleMatrixSessionProjectionMessageReceived(
      { content: "matrix reply", messageId: "$event", sessionKey },
      { channelId: "matrix", sessionKey },
      cfg,
    );

    expect(mocks.sendMessageMatrix).not.toHaveBeenCalled();
  });
});
