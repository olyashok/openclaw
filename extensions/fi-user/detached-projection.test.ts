import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelProjectionParams } from "./channel-projection.js";
import { createDetachedProjectionReconciler } from "./detached-projection.js";
const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  listSessionKeys: (...args: unknown[]) =>
    mocks.list(...args).map(({ sessionKey }: { sessionKey: string }) => sessionKey),
  getSessionEntry: mocks.get,
  sessionDeliveryOrigin: (entry: unknown) => entry,
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("native parent-session Slack history discovery", () => {
  function fixture(agentId = "cellect-fi-admin") {
    const sessionKey = `agent:${agentId}:slack:group:c123`;
    const entry = { accountId: agentId, nativeChannelId: "C123" };
    mocks.list.mockReturnValue([{ sessionKey, entry }]);
    mocks.get.mockReturnValue(entry);
    const readHistoryPage = vi.fn().mockResolvedValue({ roots: [], nextCursor: undefined });
    const scope = {
      workspaceId: "T123",
      channelId: "C123",
      memberSenderIds: ["U111"],
      readHistoryPage,
      readThread: vi.fn(),
    };
    const readChannel = vi.fn().mockResolvedValue(scope);
    const api = {
      config: {
        bindings: [{ agentId, match: { channel: "slack", accountId: agentId } }],
      },
      runtime: {
        channel: { runtimeContexts: { get: () => ({ workspaceId: "T123", readChannel }) } },
      },
      logger: { warn: vi.fn() },
    } as unknown as OpenClawPluginApi;
    const publish = vi.fn(async (params: ChannelProjectionParams) => {
      params.onResult?.("created");
      return true;
    });
    return { api, sessionKey, readHistoryPage, readChannel, publish };
  }
  it("pages beyond one root batch without fabricating sessions or starving failed roots", async () => {
    const f = fixture();
    const roots = Array.from(
      { length: 12 },
      (_, index) => `1700000000.${String(index).padStart(6, "0")}`,
    );
    f.readHistoryPage
      .mockResolvedValueOnce({ roots, nextCursor: "older" })
      .mockResolvedValueOnce({ roots: ["1600000000.000001"], nextCursor: undefined });
    let failed = false;
    f.publish.mockImplementation(async (params) => {
      if (!failed) {
        failed = true;
        throw new Error("transient");
      }
      params.onResult?.("created");
      return true;
    });
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    const connection = { baseUrl: "https://fi.example", token: "test" };
    const signal = new AbortController().signal;
    expect(await reconcile(connection, [], signal, new Set())).toMatchObject({
      pending: 1,
      error: 1,
    });
    for (let index = 0; index < 12; index++) {
      await reconcile(connection, [], signal, new Set());
    }
    expect(await reconcile(connection, [], signal, new Set())).toMatchObject({
      pending: 0,
      error: 0,
      created: 13,
    });
    expect(f.readHistoryPage.mock.calls).toEqual([[undefined], ["older"]]);
    for (const [params] of f.publish.mock.calls) {
      expect(params).toMatchObject({
        sessionKey: f.sessionKey,
        detachedSource: { workspaceId: "T123", channelId: "C123" },
        discover: true,
      });
    }
  });
  it("discovers superadmin parent-channel history through its configured Slack account", async () => {
    const f = fixture("cellect-main");
    f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    await reconcile(
      { baseUrl: "https://fi.example", token: "test" },
      [],
      new AbortController().signal,
      new Set(),
    );
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:cellect-main:slack:group:c123",
        detachedSource: expect.objectContaining({ channelId: "C123" }),
        discover: true,
      }),
    );
  });
  it("revokes an existing detached room when its native parent disappears", async () => {
    const f = fixture();
    mocks.list.mockReturnValue([]);
    mocks.get.mockReturnValue(undefined);
    const source = {
      provider: "slack" as const,
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
    };
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    const result = await reconcile(
      { baseUrl: "https://fi.example", token: "test" },
      [{ sessionKey: f.sessionKey, roomId: "!room", externalSource: source }],
      new AbortController().signal,
      new Set(),
    );
    expect(result.unavailable).toBe(1);
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        unavailable: true,
        reconcile: true,
        projectionRoomId: "!room",
        detachedSource: source,
      }),
    );
    expect(f.readChannel).not.toHaveBeenCalled();
  });
  it("bounds existing detached-room repair and reports the remaining backlog", async () => {
    const f = fixture();
    const bindings = Array.from({ length: 12 }, (_, index) => ({
      sessionKey: f.sessionKey,
      roomId: `!room${String(index).padStart(2, "0")}`,
      sourceAccountId: "fi-admin",
      externalSource: {
        provider: "slack" as const,
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: `1700000000.${String(index).padStart(6, "0")}`,
      },
    }));
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    const first = await reconcile(
      { baseUrl: "https://fi.example", token: "test" },
      bindings,
      new AbortController().signal,
      new Set(),
    );
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(first.pending).toBe(11);
    let latest = first;
    for (let index = 1; index < 12; index++) {
      latest = await reconcile(
        { baseUrl: "https://fi.example", token: "test" },
        bindings,
        new AbortController().signal,
        new Set(),
      );
    }
    expect(f.publish).toHaveBeenCalledTimes(12);
    expect(latest.pending).toBe(0);
  });
  it("rescans completed skipped roots after opt-out restoration and live parent activity", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
    f.publish.mockImplementationOnce(async (params) => {
      params.onResult?.("skipped");
      return true;
    });
    const projection = createDetachedProjectionReconciler(f.api, f.publish);
    const run = () =>
      projection.reconcile(
        { baseUrl: "https://fi.example", token: "test" },
        [],
        new AbortController().signal,
        new Set<string>(),
      );
    expect(await run()).toMatchObject({ skipped: 1 });
    await run();
    expect(f.publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await run()).toMatchObject({ created: 1, skipped: 0 });
    expect(f.publish).toHaveBeenCalledTimes(2);
    projection.invalidate(f.sessionKey);
    await run();
    expect(f.publish).toHaveBeenCalledTimes(3);
  });
  it("finishes a many-channel initial scan before starting periodic refresh", async () => {
    vi.useFakeTimers();
    const f = fixture();
    mocks.list.mockReturnValue(
      Array.from({ length: 9 }, (_, index) => ({
        sessionKey: `agent:cellect-fi-admin:slack:channel:c${index}23`,
        entry: { accountId: "fi-admin", nativeChannelId: `C${index}23` },
      })),
    );
    f.readHistoryPage.mockResolvedValue({ roots: ["1700000000.000001"], nextCursor: undefined });
    const { reconcile } = createDetachedProjectionReconciler(f.api, f.publish);
    for (let index = 0; index < 9; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        await reconcile(
          { baseUrl: "https://fi.example", token: "test" },
          [],
          new AbortController().signal,
          new Set(),
        ),
      ).toMatchObject({ pending: 8 - index });
    }
    expect(f.publish).toHaveBeenCalledTimes(9);
  });
});
