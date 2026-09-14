import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyClaim: vi.fn(),
  resolveRoute: vi.fn(),
  deliver: vi.fn(),
}));
vi.mock("../webchat-completion-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../webchat-completion-delivery.js")>()),
  verifyWebchatCompletionDeliveryClaim: mocks.verifyClaim,
}));
vi.mock("../../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveRoute,
}));
vi.mock("../webchat-completion-delivery-send.js", () => ({
  deliverWebchatCompletionFallback: mocks.deliver,
}));

import { handleConversationContinue } from "./conversation-continue-handler.js";

describe("conversation.continue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENCLAW_WEBCHAT_COMPLETION_DELIVERY_SECRET = "test-secret";
    mocks.verifyClaim.mockReturnValue({ channel: "slack", to: "user:U3", accountId: "fi-admin" });
    mocks.resolveRoute.mockResolvedValue({
      recipientSessionExact: true,
      sessionKey: "agent:cellect-fi-admin:matrix:room:thread",
      peer: { kind: "group", id: "!room:example" },
    });
    mocks.deliver.mockResolvedValue("handled");
  });

  it("resolves a Matrix thread and continues its exact session in a verified Slack DM", async () => {
    const respond = vi.fn();
    await handleConversationContinue({
      params: {
        source: {
          channel: "matrix",
          roomId: "!room:example",
          threadRootEventId: "$root",
          agentMxid: "@cellect-fi-admin:example.org",
        },
        destinationClaim: "signed-claim",
      },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as never);

    expect(mocks.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        agentId: "cellect-fi-admin",
        target: "!room:example",
        threadId: "$root",
      }),
    );
    expect(mocks.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:cellect-fi-admin:matrix:room:thread",
        continuationMarker: true,
        deliveryIntentId: expect.stringMatching(/^conversation-continue:/),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, { status: "continued" });
  });

  it("rejects a signed shared-channel destination before Matrix resolution", async () => {
    mocks.verifyClaim.mockReturnValue({ channel: "slack", to: "channel:C1" });
    const respond = vi.fn();
    await handleConversationContinue({
      params: {
        source: { channel: "matrix", roomId: "!r:e", threadRootEventId: "$t", agentMxid: "@a:e" },
        destinationClaim: "signed-claim",
      },
      respond,
      context: { getRuntimeConfig: () => ({}), logGateway: { warn: vi.fn() } },
    } as never);
    expect(mocks.resolveRoute).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });
});
