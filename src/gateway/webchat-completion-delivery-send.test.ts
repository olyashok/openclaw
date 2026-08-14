import { beforeEach, describe, expect, it, vi } from "vitest";

const { deliverInboundReplyWithMessageSendContext } = vi.hoisted(() => ({
  deliverInboundReplyWithMessageSendContext: vi.fn(),
}));
vi.mock("../channels/turn/durable-delivery.js", () => ({
  deliverInboundReplyWithMessageSendContext,
}));

import { deliverWebchatCompletionFallback } from "./webchat-completion-delivery-send.js";
import { WEBCHAT_COMPLETION_DELIVERY_SLOW_MS } from "./webchat-completion-delivery.js";

function state() {
  return {
    route: { channel: "slack", to: "user:U123", accountId: "fi-admin" },
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    cfg: {},
    state: state(),
    startedAtMs: 1_000,
    runId: "run-1",
    sessionId: "session-1",
    agentId: "cellect-fi-admin",
    ctx: { Body: "question", SessionKey: "agent:cellect-fi-admin:device:abc" },
    replies: [{ kind: "final" as const, payload: { text: "The answer" } }],
    nowMs: 2_000,
    log: { warn: vi.fn() },
    ...overrides,
  };
}

describe("deliverWebchatCompletionFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: { visibleReplySent: true },
    });
  });

  it("does not deliver a quick reply while WebChat remains present", async () => {
    expect(await deliverWebchatCompletionFallback(baseParams())).toBe("skipped");
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it.each([
    ["client-left", { armedAtMs: 1_500 }, 2_000],
    ["slow", {}, 1_000 + WEBCHAT_COMPLETION_DELIVERY_SLOW_MS],
  ] as const)("delivers exactly once for %s", async (_reason, stateExtra, nowMs) => {
    const deliveryState = { ...state(), ...stateExtra };
    const params = baseParams({ state: deliveryState, nowMs });

    expect(await deliverWebchatCompletionFallback(params)).toBe("handled");
    expect(await deliverWebchatCompletionFallback(params)).toBe("skipped");

    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "fi-admin",
        to: "user:U123",
        threadId: null,
        replyToId: null,
        requiredCapabilities: expect.objectContaining({ reconcileUnknownSend: true }),
        payload: expect.objectContaining({ text: expect.stringContaining("The answer") }),
      }),
    );
  });

  it("sends a terminal error when the hidden run fails", async () => {
    const deliveryState = { ...state(), armedAtMs: 1_500 };

    expect(
      await deliverWebchatCompletionFallback(
        baseParams({ state: deliveryState, fallbackError: "agent failed" }),
      ),
    ).toBe("handled");

    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          isError: true,
          text: expect.stringContaining("agent failed"),
        }),
      }),
    );
  });
});
