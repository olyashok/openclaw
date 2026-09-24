// Slack tests cover unanswered-mention notices and the no-reply watchdog.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const logger = { warn, info: () => {}, child: () => logger };
  return { ...actual, createSubsystemLogger: () => logger };
});

const {
  clearSlackPendingMentionsForTest,
  noticeSlackUnansweredMention,
  resolveSlackPrincipalMention,
  trackSlackPrincipalMention,
} = await import("./unanswered-mentions.js");

function createCtx(unansweredMentions?: Record<string, unknown>) {
  const postEphemeral = vi.fn(async () => ({ ok: true }));
  const ctx = {
    accountId: "fi-admin",
    teamId: "T1",
    botToken: "xoxb-test",
    botUserId: "B1",
    cfg: {
      channels: { slack: unansweredMentions ? { unansweredMentions } : {} },
    } as OpenClawConfig,
    app: { client: { chat: { postEphemeral } } },
    runtime: { error: vi.fn() },
    resolveUserName: async () => ({ name: "cellect-fi-admin" }),
  } as unknown as SlackMonitorContext;
  return { ctx, postEphemeral };
}

describe("noticeSlackUnansweredMention", () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it("rate-limits per user and channel, and logs every unanswered mention", async () => {
    const { ctx, postEphemeral } = createCtx();
    const notice = (userId: string, channelId = "C1") =>
      noticeSlackUnansweredMention({
        ctx,
        channelId,
        userId,
        messageTs: "1.0",
        reason: "sender-not-allowed",
      });

    await expect(notice("U1")).resolves.toBe(true);
    await expect(notice("U1")).resolves.toBe(false);
    await expect(notice("U2")).resolves.toBe(true);
    await expect(notice("U1", "C2")).resolves.toBe(true);

    expect(postEphemeral).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "Unanswered mention account=fi-admin channel=C1 user=U1 ts=1.0 reason=sender-not-allowed",
    );
  });

  it("can be turned off while still logging", async () => {
    const { ctx, postEphemeral } = createCtx({ notice: false });

    await noticeSlackUnansweredMention({
      ctx,
      channelId: "C1",
      userId: "U1",
      reason: "channel-not-allowed",
    });

    expect(postEphemeral).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("retries on the next mention when Slack rejects the ephemeral message", async () => {
    const { ctx, postEphemeral } = createCtx();
    postEphemeral.mockRejectedValueOnce(new Error("channel_not_found"));
    const notice = () =>
      noticeSlackUnansweredMention({
        ctx,
        channelId: "C1",
        userId: "U1",
        reason: "not-a-request-user",
      });

    await expect(notice()).resolves.toBe(false);
    await expect(notice()).resolves.toBe(true);
    expect(postEphemeral).toHaveBeenCalledTimes(2);
  });
});

describe("unanswered principal mention watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warn.mockClear();
  });

  afterEach(() => {
    clearSlackPendingMentionsForTest();
    vi.useRealTimers();
  });

  it("logs an admitted mention with no reply after the configured minutes", () => {
    const { ctx } = createCtx({ alertAfterMinutes: 5 });
    trackSlackPrincipalMention({ ctx, channelId: "C1", messageTs: "1.0", userId: "U_LORENZO" });

    vi.advanceTimersByTime(4 * 60_000);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Unanswered mention account=fi-admin channel=C1 user=U_LORENZO ts=1.0 reason=no-reply-after-5m",
    );
  });

  it("stays quiet once a reply is delivered, or when disabled", () => {
    const answered = createCtx();
    trackSlackPrincipalMention({ ctx: answered.ctx, channelId: "C1", messageTs: "1.0" });
    resolveSlackPrincipalMention({ accountId: "fi-admin", channelId: "C1", messageTs: "1.0" });
    const disabled = createCtx({ alertAfterMinutes: 0 });
    trackSlackPrincipalMention({ ctx: disabled.ctx, channelId: "C1", messageTs: "2.0" });

    vi.advanceTimersByTime(60 * 60_000);

    expect(warn).not.toHaveBeenCalled();
  });
});
