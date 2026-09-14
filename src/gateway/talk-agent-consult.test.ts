import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleTrustedInternalChatSend: vi.fn(),
  resolveAuthority: vi.fn(() => ({ senderIsOwner: false, toolsAllow: ["read"] })),
}));

vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleTrustedInternalChatSend: mocks.handleTrustedInternalChatSend,
}));
vi.mock("./talk/client-gateway-control.js", () => ({
  resolveTalkAgentConsultAuthority: mocks.resolveAuthority,
}));
vi.mock("./talk/relay/index.js", () => ({
  registerTalkRealtimeRelayAgentRun: vi.fn(),
}));

import { startTalkRealtimeAgentConsult } from "./talk/agent-consult.js";

function createParams() {
  return {
    request: {
      context: {
        getRuntimeConfig: () => ({}),
        logGateway: { warn: vi.fn() },
      },
      client: { connect: { scopes: ["operator.write"] } },
      req: { id: "request-1" },
    } as never,
    params: {
      sessionTarget: {
        canonicalKey: "agent:fi-admin:matrix:room:thread",
        agentId: "fi-admin",
      },
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
    },
  };
}

describe("Talk Matrix consult delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleTrustedInternalChatSend.mockImplementation(
      async (options: { params: { idempotencyKey: string }; respond: Function }) => {
        options.respond(true, { status: "started", runId: options.params.idempotencyKey });
      },
    );
  });

  it("pins the authorized Matrix thread on the canonical durable chat final path", async () => {
    const { request, params } = createParams();
    const result = await startTalkRealtimeAgentConsult(request, params);

    expect(result.ok).toBe(true);
    expect(mocks.handleTrustedInternalChatSend).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          deliver: true,
          originatingChannel: "matrix",
          originatingTo: "room:!private:example.test",
          originatingAccountId: "fi-admin",
          originatingThreadId: "$root",
        }),
      }),
      undefined,
      expect.objectContaining({ toolsAllow: ["read"] }),
    );
  });

  it("reuses one run idempotency key for the same delayed provider call retry", async () => {
    const firstParams = createParams();
    const secondParams = createParams();
    const first = await startTalkRealtimeAgentConsult(firstParams.request, firstParams.params);
    const second = await startTalkRealtimeAgentConsult(secondParams.request, secondParams.params);

    expect(first).toEqual(second);
    const calls = mocks.handleTrustedInternalChatSend.mock.calls;
    expect(calls[0]?.[0].params.idempotencyKey).toBe(calls[1]?.[0].params.idempotencyKey);
  });
});
