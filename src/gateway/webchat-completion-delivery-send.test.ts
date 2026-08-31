import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deliverInboundReplyWithMessageSendContext } = vi.hoisted(() => ({
  deliverInboundReplyWithMessageSendContext: vi.fn(),
}));
vi.mock("../channels/turn/durable-delivery.js", () => ({
  deliverInboundReplyWithMessageSendContext,
}));

import {
  deliverWebchatCompletionFallback,
  markWebchatCompletionSeen,
  scheduleWebchatCompletionFallback,
} from "./webchat-completion-delivery-send.js";
import {
  WEBCHAT_COMPLETION_DELIVERY_SLOW_MS,
  type WebchatCompletionDeliveryState,
} from "./webchat-completion-delivery.js";

function state(): WebchatCompletionDeliveryState {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers an unread quick reply once its grace period has elapsed", async () => {
    expect(await deliverWebchatCompletionFallback(baseParams())).toBe("handled");
    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
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

  it("cancels a scheduled chase when the same device sees the Fi answer", async () => {
    vi.useFakeTimers();
    const deliveryState = state();
    expect(
      scheduleWebchatCompletionFallback({
        ...baseParams({ state: deliveryState }),
        sessionKey: "agent:cellect-fi-admin:device:abc",
        ownerDeviceId: "device-abc",
        unreadGraceMs: 100,
      }),
    ).toBe("scheduled");
    expect(
      markWebchatCompletionSeen({
        runId: "run-1",
        sessionKey: "agent:cellect-fi-admin:device:abc",
        requesterDeviceId: "device-abc",
      }),
    ).toBe("seen");

    await vi.advanceTimersByTimeAsync(100);
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
    expect(deliveryState.seenAtMs).toEqual(expect.any(Number));
  });

  it("sends the scheduled chase when no read receipt arrives", async () => {
    vi.useFakeTimers();
    expect(
      scheduleWebchatCompletionFallback({
        ...baseParams({ runId: "run-unread" }),
        runId: "run-unread",
        sessionKey: "agent:cellect-fi-admin:device:abc",
        ownerDeviceId: "device-abc",
        unreadGraceMs: 100,
      }),
    ).toBe("scheduled");

    await vi.advanceTimersByTimeAsync(100);
    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("was not viewed within one minute"),
        }),
      }),
    );
  });
});
