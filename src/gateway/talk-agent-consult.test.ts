import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChatSend: vi.fn(),
  handleChatSendWithRuntimeTools: vi.fn(),
  handleTrustedInternalChatSend: vi.fn(),
  handleTrustedInternalChatSendWithRuntimeTools: vi.fn(),
  resolveAuthority: vi.fn(() => ({ senderIsOwner: false, toolsAllow: ["read"] })),
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
  registerTalkRealtimeRelayAgentRun: vi.fn(),
}));

import { startTalkRealtimeAgentConsult } from "./talk-agent-consult.js";

function createParams() {
  return {
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
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
    mocks.handleTrustedInternalChatSendWithRuntimeTools.mockImplementation(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        options.respond(true, { status: "started", runId: options.params.idempotencyKey });
      },
    );
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
    );
    expect(mocks.handleChatSendWithRuntimeTools).not.toHaveBeenCalled();
  });

  it("reuses one run idempotency key for the same delayed provider call retry", async () => {
    const first = await startTalkRealtimeAgentConsult(createParams());
    const second = await startTalkRealtimeAgentConsult(createParams());

    expect(first).toEqual(second);
    const calls = mocks.handleTrustedInternalChatSendWithRuntimeTools.mock.calls;
    expect(calls[0]?.[0].params.idempotencyKey).toBe(calls[1]?.[0].params.idempotencyKey);
  });
});
