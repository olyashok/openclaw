import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChatSend: vi.fn(),
  handleChatSendWithRuntimeTools: vi.fn(),
  handleTrustedInternalChatSend: vi.fn(),
  handleTrustedInternalChatSendWithRuntimeTools: vi.fn(),
  registerRelayRun: vi.fn<(runId: string) => "registered" | "detached">(() => "registered"),
  prepareRelayRun: vi.fn(),
  abortChatRunById: vi.fn(),
  resolveAuthority: vi.fn<() => { senderIsOwner: boolean; toolsAllow?: string[] }>(() => ({
    senderIsOwner: false,
    toolsAllow: ["read"],
  })),
  relayAdmission: { assertCurrent: vi.fn() },
}));

vi.mock("./talk-relay-consult-admission.js", () => ({
  prepareTalkRelayConsultAdmission: () => mocks.relayAdmission,
}));

vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleChatSend: mocks.handleChatSend,
  handleChatSendWithRuntimeTools: mocks.handleChatSendWithRuntimeTools,
  handleTrustedInternalChatSend: mocks.handleTrustedInternalChatSend,
  handleTrustedInternalChatSendWithRuntimeTools:
    mocks.handleTrustedInternalChatSendWithRuntimeTools,
}));
vi.mock("./talk-client-gateway-control.js", () => ({
  resolveTalkAgentConsultAuthority: mocks.resolveAuthority,
}));
vi.mock("./talk-realtime-relay.js", () => ({
  prepareTalkRealtimeRelayAgentRunRegistration: mocks.prepareRelayRun,
}));
vi.mock("./chat-abort.js", () => ({
  abortChatRunById: mocks.abortChatRunById,
}));

import { startTalkRealtimeAgentConsult } from "./talk-agent-consult.js";

function createParams() {
  return {
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { info: vi.fn(), warn: vi.fn() },
    } as never,
    client: { connect: { scopes: ["operator.write"] } } as never,
    isWebchatConnect: () => true,
    requestId: "request-1",
    sessionKey: "agent:fi-admin:matrix:room:thread",
    callId: "call-1",
    args: { question: "What changed?" },
    relaySessionId: "voice-1",
    connId: "browser-1",
    matrixRoute: {
      channel: "matrix" as const,
      roomId: "!private:example.test",
      threadRootEventId: "$root",
      accountId: "fi-admin",
    },
  };
}

describe("Talk Matrix consult delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerRelayRun.mockReturnValue("registered");
    mocks.prepareRelayRun.mockReturnValue(mocks.registerRelayRun);
    mocks.handleTrustedInternalChatSendWithRuntimeTools.mockImplementation(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        options.respond(true, { status: "started", runId: options.params.idempotencyKey });
      },
    );
  });

  it("keeps an accepted Matrix consult alive when its delayed ACK follows relay detach", async () => {
    let acknowledge!: () => void;
    mocks.handleTrustedInternalChatSendWithRuntimeTools.mockImplementationOnce(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        await new Promise<void>((resolve) => {
          acknowledge = () => {
            options.respond(true, { status: "started", runId: options.params.idempotencyKey });
            resolve();
          };
        });
      },
    );
    mocks.registerRelayRun.mockReturnValueOnce("detached");

    const pending = startTalkRealtimeAgentConsult(createParams());
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
    acknowledge();

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(mocks.abortChatRunById).not.toHaveBeenCalled();
  });

  it("pins the authorized Matrix thread on the canonical durable chat final path", async () => {
    const result = await startTalkRealtimeAgentConsult(createParams());

    expect(result.ok).toBe(true);
    expect(mocks.handleTrustedInternalChatSendWithRuntimeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: true,
          originatingChannel: "matrix",
          originatingTo: "room:!private:example.test",
          originatingAccountId: "fi-admin",
          originatingThreadId: "$root",
        }),
      }),
      ["read"],
      mocks.relayAdmission,
      {
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode: "automatic",
      },
    );
    expect(mocks.handleChatSendWithRuntimeTools).not.toHaveBeenCalled();
  });

  it("uses the same directed turn policy when the owner keeps the full tool profile", async () => {
    mocks.resolveAuthority.mockReturnValueOnce({ senderIsOwner: true, toolsAllow: undefined });
    mocks.handleTrustedInternalChatSend.mockImplementationOnce(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        options.respond(true, { status: "started", runId: options.params.idempotencyKey });
      },
    );

    await expect(startTalkRealtimeAgentConsult(createParams())).resolves.toMatchObject({
      ok: true,
    });
    expect(mocks.handleTrustedInternalChatSend).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      mocks.relayAdmission,
      {
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode: "automatic",
      },
    );
  });

  it("reuses one run idempotency key for the same delayed provider call retry", async () => {
    const first = await startTalkRealtimeAgentConsult(createParams());
    const second = await startTalkRealtimeAgentConsult(createParams());

    expect(first).toEqual(second);
    const calls = mocks.handleTrustedInternalChatSendWithRuntimeTools.mock.calls;
    expect(calls[0]?.[0].params.idempotencyKey).toBe(calls[1]?.[0].params.idempotencyKey);
  });
});
