// Slack tests cover configured reaction triggers.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "../context.js";
import { clearSlackReactionTriggerRunsForTest } from "./reaction-triggers.js";
import { registerSlackReactionEvents } from "./reactions.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventHandler,
} from "./system-event-test-harness.js";

const runChannelAnnouncedAgentTurn = vi.hoisted(() => vi.fn());
const enqueueRoutedSystemEvent = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  runChannelAnnouncedAgentTurn,
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({ enqueueRoutedSystemEvent }));

const PROMPT = "File this message's attachments into the project's data room.";

type TriggerCase = {
  requestUsers?: string[];
  channelRequestUsers?: string[];
  channelType?: "channel" | "im";
  history?: Array<Record<string, unknown>>;
  replies?: Array<Record<string, unknown>>;
};

function createTriggerHarness(options: TriggerCase = {}) {
  const harness = createSlackSystemEventTestHarness({
    channelType: options.channelType ?? "channel",
    reactionMode: "own",
  });
  const history = vi.fn(async () => ({
    messages: options.history ?? [
      {
        ts: "1789000000.000100",
        user: "U_VENDOR",
        text: "invoice attached",
        files: [{ id: "F1" }, { id: "F2" }],
      },
    ],
  }));
  const replies = vi.fn(async () => ({ messages: options.replies ?? [] }));
  const getPermalink = vi.fn(async () => ({
    permalink: "https://example.slack.com/archives/C1/p1789000000000100",
  }));
  const ctx = harness.ctx as SlackMonitorContext & Record<string, unknown>;
  ctx.accountId = "fi-admin";
  ctx.cfg = {
    channels: {
      slack: {
        reactionTriggers: {
          inbox_tray: {
            prompt: PROMPT,
            ...(options.requestUsers ? { requestUsers: options.requestUsers } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
  ctx.channelsConfig = options.channelRequestUsers
    ? { C1: { enabled: true, requestUsers: options.channelRequestUsers } }
    : undefined;
  ctx.channelsConfigKeys = options.channelRequestUsers ? ["C1"] : [];
  ctx.app = {
    ...ctx.app,
    client: { conversations: { history, replies }, chat: { getPermalink } },
  } as unknown as SlackMonitorContext["app"];
  const resolveSlackSystemEventRoute = vi.fn(() => ({
    agentId: "fi-admin",
    sessionKey: "agent:fi-admin:slack:channel:c1:thread:1789000000.000100",
  }));
  ctx.resolveSlackSystemEventRoute = resolveSlackSystemEventRoute;
  registerSlackReactionEvents({ ctx });
  const added = harness.getHandler("reaction_added") as SlackSystemEventHandler;
  const removed = harness.getHandler("reaction_removed") as SlackSystemEventHandler;
  return { added, removed, history, replies, resolveSlackSystemEventRoute };
}

function reactionEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "reaction_added",
    user: "U_ALEX",
    reaction: "inbox_tray",
    item: { type: "message", channel: "C1", ts: "1789000000.000100" },
    item_user: "U_VENDOR",
    ...overrides,
  };
}

describe("Slack reaction triggers", () => {
  beforeEach(() => {
    clearSlackReactionTriggerRunsForTest();
    runChannelAnnouncedAgentTurn.mockReset();
    runChannelAnnouncedAgentTurn.mockResolvedValue({ delivered: true });
    enqueueRoutedSystemEvent.mockReset();
  });

  it("starts an isolated turn in the reacted human message's thread", async () => {
    const { added, resolveSlackSystemEventRoute } = createTriggerHarness({
      requestUsers: ["U_ALEX"],
    });

    await added({ event: reactionEvent(), body: { event_id: "Ev1" } });

    expect(runChannelAnnouncedAgentTurn).toHaveBeenCalledTimes(1);
    const [turn] = runChannelAnnouncedAgentTurn.mock.calls[0];
    expect(turn).toMatchObject({
      channel: "slack",
      accountId: "fi-admin",
      deliverTo: "channel:C1",
      threadId: "1789000000.000100",
      route: { agentId: "fi-admin" },
    });
    expect(turn.toolsAllow).toBeUndefined();
    expect(turn.message.startsWith(PROMPT)).toBe(true);
    expect(turn.message).toContain("- channel: C1 (#general)");
    expect(turn.message).toContain("- message ts: 1789000000.000100");
    expect(turn.message).toContain("- file ids: F1, F2");
    expect(turn.message).toContain(
      "- permalink: https://example.slack.com/archives/C1/p1789000000000100",
    );
    // The reacted message's own text never reaches the trusted prompt.
    expect(turn.message).not.toContain("invoice attached");
    expect(resolveSlackSystemEventRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "C1", threadTs: "1789000000.000100" }),
    );
    // reactionNotifications stays "own": the human message only fires the trigger.
    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
  });

  it("finds a reacted thread reply and answers in its thread", async () => {
    const { added, replies } = createTriggerHarness({
      channelRequestUsers: ["U_ALEX"],
      history: [],
      replies: [
        { ts: "1788990000.000001", text: "root" },
        { ts: "1789000000.000100", thread_ts: "1788990000.000001", files: [{ id: "F9" }] },
      ],
    });

    await added({ event: reactionEvent(), body: { event_id: "Ev1" } });

    expect(replies).toHaveBeenCalledWith(expect.objectContaining({ ts: "1789000000.000100" }));
    const [turn] = runChannelAnnouncedAgentTurn.mock.calls[0];
    expect(turn.threadId).toBe("1788990000.000001");
    expect(turn.message).toContain("- file ids: F9");
  });

  it.each([
    { name: "a reactor outside requestUsers", options: { requestUsers: ["U_OTHER"] } },
    { name: "no requester list at all", options: {} },
    {
      name: "a direct message",
      options: { requestUsers: ["U_ALEX"], channelType: "im" as const },
    },
  ])("ignores $name", async ({ options }) => {
    const { added } = createTriggerHarness(options);

    await added({ event: reactionEvent(), body: { event_id: "Ev1" } });

    expect(runChannelAnnouncedAgentTurn).not.toHaveBeenCalled();
  });

  it("ignores other emojis, removals and the bot's own reactions", async () => {
    const { added, removed } = createTriggerHarness({ requestUsers: ["U_ALEX", "U_BOT"] });

    await added({ event: reactionEvent({ reaction: "thumbsup" }), body: { event_id: "Ev1" } });
    await removed({
      event: reactionEvent({ type: "reaction_removed" }),
      body: { event_id: "Ev2" },
    });
    await added({ event: reactionEvent({ user: "U_BOT" }), body: { event_id: "Ev3" } });

    expect(runChannelAnnouncedAgentTurn).not.toHaveBeenCalled();
  });

  it("runs once per message and emoji, including skin-tone variants and replays", async () => {
    const { added } = createTriggerHarness({ requestUsers: ["U_ALEX", "U_NICK"] });

    await added({ event: reactionEvent(), body: { event_id: "Ev1" } });
    await added({ event: reactionEvent(), body: { event_id: "Ev1" } });
    await added({
      event: reactionEvent({ user: "U_NICK", reaction: "inbox_tray::skin-tone-2" }),
      body: { event_id: "Ev2" },
    });

    expect(runChannelAnnouncedAgentTurn).toHaveBeenCalledTimes(1);
  });
});
