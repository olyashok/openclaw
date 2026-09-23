import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectSlackChannelThread,
  registerSlackProjectionReconciler,
} from "./channel-projection.js";

const discovery = vi.hoisted(() => ({
  entry: vi.fn(),
  list: vi.fn<
    (params: {
      agentId: string;
      readOnly?: boolean;
    }) => Array<{ sessionKey: string; entry: Record<string, unknown> }>
  >(() => []),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: discovery.entry,
  listSessionKeys: (params: { agentId: string; readOnly?: boolean }) =>
    discovery.list(params).map(({ sessionKey }) => sessionKey),
  sessionDeliveryOrigin: (entry: Record<string, unknown> | undefined) => ({
    accountId: "fi-admin",
    ...entry,
  }),
}));

describe("Fi Slack channel publisher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    discovery.list.mockReset().mockReturnValue([]);
    discovery.entry.mockReset();
  });
  it.each([false, true, "mention" as const])(
    "requires native parent identity and actual bot participation for detached roots (%s)",
    async (participates) => {
      discovery.entry.mockReturnValue({ nativeChannelId: "C123" });
      const source = {
        provider: "slack" as const,
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
      };
      const readThread = vi.fn().mockResolvedValue({
        ...source,
        memberSenderIds: ["U111"],
        messages: [
          {
            messageId: source.rootMessageId,
            senderId: participates === true ? "U222" : "U111",
            content: participates === "mention" ? "<@U222> hi" : "hello",
            bot: participates === true,
          },
        ],
      });
      const api = {
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "slack"
                  ? { workspaceId: "T123", botUserId: "U222", readThread }
                  : undefined,
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "created" }) });
      vi.stubGlobal("fetch", fetchMock);
      const onResult = vi.fn();
      const params = {
        api,
        sessionKey: "agent:cellect-fi-admin:slack:group:c123",
        accountId: "fi-admin",
        detachedSource: source,
        baseUrl: "https://fi.example",
        token: "test",
        discover: true,
        onResult,
      };
      await projectSlackChannelThread(params);
      expect(fetchMock).toHaveBeenCalledTimes(participates ? 1 : 0);
      expect(onResult).toHaveBeenCalledWith(participates ? "created" : "skipped");
      discovery.entry.mockReturnValue({ nativeChannelId: "C999" });
      await expect(projectSlackChannelThread(params)).rejects.toThrow("native parent origin");
    },
  );
  it.each(["cellect-fi-admin", "cellect-main"])(
    "projects a %s channel thread with membership evidence and actual source authors",
    async (agentId) => {
      const readThread = vi.fn().mockResolvedValue({
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId: "1700000000.000001",
        memberSenderIds: ["U111"],
        messages: [
          { messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false },
          { messageId: "1700000000.000002", senderId: "U222", content: "hello", bot: true },
          { messageId: "1700000000.000003", senderId: "U333", content: "another bot", bot: true },
        ],
      });
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const api = {
        runtime: {
          channel: { runtimeContexts: { get: () => ({ readThread, botUserId: "U222" }) } },
        },
      } as unknown as OpenClawPluginApi;
      await projectSlackChannelThread({
        api,
        sessionKey: `agent:${agentId}:slack:channel:c123:thread:1700000000.000001`,
        accountId: "fi-admin",
        requesterSenderId: "U111",
        baseUrl: "https://fi.example",
        token: "test-token",
      });
      expect(readThread).toHaveBeenCalledWith("C123", "1700000000.000001");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const payload = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))[0];
      expect(payload.source).toMatchObject({ memberSenderIds: ["U111"] });
      expect(payload.snapshot.messages[1]).toMatchObject({
        agentId,
        role: "assistant",
        senderId: "U222",
      });
      expect(payload.snapshot.messages[2]).not.toHaveProperty("agentId");
    },
  );
  it("revokes existing readers on source failure without treating it as message deletion", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const api = {
      runtime: {
        channel: {
          runtimeContexts: {
            get: () => ({
              workspaceId: "T123",
              readThread: async () => {
                throw new Error("not_in_channel");
              },
            }),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    await expect(
      projectSlackChannelThread({
        api,
        sessionKey: "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001",
        accountId: "fi-admin",
        baseUrl: "https://fi.example",
        token: "test-token",
        reconcile: true,
      }),
    ).rejects.toThrow("not_in_channel");
    const payload = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))[0];
    expect(payload.source.memberSenderIds).toEqual([]);
    expect(payload.reconcile).toBe(true);
    expect(payload).not.toHaveProperty("snapshot");
  });
  it("keeps both bot authors identical when the same thread is read through different accounts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const readThread = async () => ({
      workspaceId: "T123",
      channelId: "C123",
      rootMessageId: "1700000000.000001",
      memberSenderIds: ["U111"],
      messages: [
        { messageId: "1700000000.000001", senderId: "U111", content: "hi", bot: false },
        { messageId: "1700000000.000002", senderId: "U222", content: "admin", bot: true },
        { messageId: "1700000000.000003", senderId: "U333", content: "user", bot: true },
      ],
    });
    const api = {
      config: {
        bindings: [
          { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          { agentId: "cellect-fi-user", match: { channel: "slack", accountId: "fi-user" } },
        ],
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ accountId }: { accountId: string }) => ({
              workspaceId: "T123",
              botUserId: accountId === "fi-admin" ? "U222" : "U333",
              readThread,
            }),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    for (const accountId of ["fi-admin", "fi-user"]) {
      await projectSlackChannelThread({
        api,
        sessionKey: `agent:cellect-${accountId}:slack:channel:c123:thread:1700000000.000001`,
        accountId,
        requesterSenderId: "U111",
        baseUrl: "https://fi.example",
        token: "test-token",
      });
    }
    const snapshots = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).snapshot);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(snapshots[0].messages.map((message: { agentId?: string }) => message.agentId)).toEqual([
      undefined,
      "cellect-fi-admin",
      "cellect-fi-user",
    ]);
  });
  it.each([false, true])(
    "rediscovers durable projections after restart, revoking orphaned=%s without an agent turn",
    async (orphaned) => {
      vi.useFakeTimers();
      const sessionKey = "agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.000001";
      discovery.entry.mockReturnValue(orphaned ? undefined : {});
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) });
      vi.stubGlobal("fetch", fetchMock);
      let service: { start: () => void; stop: () => void } | undefined;
      const api = {
        config: {
          bindings: [
            { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          ],
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerGatewayMethod: vi.fn(),
        registerService: (value: typeof service) => {
          service = value;
        },
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "matrix"
                  ? { list: async () => [{ sessionKey, roomId: "!room" }] }
                  : {
                      workspaceId: "T123",
                      botUserId: "U222",
                      readChannel: async () => ({
                        workspaceId: "T123",
                        channelId: "C123",
                        memberSenderIds: [],
                        readThread: async () => ({
                          workspaceId: "T123",
                          channelId: "C123",
                          rootMessageId: "1700000000.000001",
                          memberSenderIds: [],
                          messages: [],
                        }),
                      }),
                    },
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      registerSlackProjectionReconciler(api, () => ({
        baseUrl: "https://fi.example",
        token: "test-token",
      }));
      if (!service) {
        throw new Error("Missing registered reconciler");
      }
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      service.stop();
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      service.stop();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const payload = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))[1];
      expect(payload).toMatchObject(
        orphaned
          ? { reconcile: true, unavailable: true, projectionRoomId: "!room" }
          : {
              reconcile: true,
              source: { memberSenderIds: [] },
            },
      );
      expect(payload).not.toHaveProperty("snapshot");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it("discovers unbound historical roots in bounded batches and deduplicates cross-agent roots", async () => {
    vi.useFakeTimers();
    const agents = ["cellect-fi-user", "cellect-fi-admin", "cellect-main"];
    discovery.entry.mockReturnValue({});
    discovery.list.mockImplementation(({ agentId }: { agentId: string }) =>
      Array.from({ length: 12 }, (_, index) => ({
        sessionKey: `agent:${agentId}:slack:channel:c123:thread:1700000000.${String(index).padStart(6, "0")}`,
        entry: {},
      })),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ status: "skipped" }) });
    vi.stubGlobal("fetch", fetchMock);
    let service: { start: () => void; stop: () => void } | undefined;
    const api = {
      config: {
        bindings: agents.map((agentId, index) => ({
          agentId,
          match: { channel: "slack", accountId: `configured-${index}` },
        })),
      },
      logger: { warn: vi.fn(), info: vi.fn() },
      registerGatewayMethod: vi.fn(),
      registerService: (value: typeof service) => {
        service = value;
      },
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "matrix"
                ? { list: async () => [] }
                : {
                    workspaceId: "T123",
                    botUserId: "U222",
                    readChannel: async () => ({
                      workspaceId: "T123",
                      channelId: "C123",
                      memberSenderIds: ["U333"],
                      readThread: async (rootMessageId: string) => ({
                        workspaceId: "T123",
                        channelId: "C123",
                        rootMessageId,
                        memberSenderIds: ["U333"],
                        messages: [
                          {
                            messageId: rootMessageId,
                            senderId: "U111",
                            content: "Historical user left",
                            bot: false,
                          },
                        ],
                      }),
                    }),
                  },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    registerSlackProjectionReconciler(api, () => ({
      baseUrl: "https://fi.example",
      token: "test-token",
    }));
    if (!service) {
      throw new Error("Missing registered reconciler");
    }
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Channel maintenance receives one slot every three reconciler turns:
    // channel, detached, direct. Historical roots remain fair, but cannot
    // monopolize the gateway shared by live conversations.
    for (let index = 1; index < 36; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    service.stop();
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(new Set(payloads.map((payload) => payload.source.rootMessageId)).size).toBe(12);
    expect(payloads.every((payload) => payload.discover === true && !payload.reconcile)).toBe(true);
    expect(payloads.every((payload) => payload.source.memberSenderIds.includes("U333"))).toBe(true);
    expect(discovery.list).toHaveBeenCalledWith({ agentId: "cellect-fi-user" });
    expect(discovery.list).toHaveBeenCalledWith({ agentId: "cellect-main" });
  });
  it.each([false, true])(
    "refreshes every room ACL with bounded history, source outage=%s",
    async (outage) => {
      vi.useFakeTimers();
      discovery.entry.mockReturnValue({});
      const bindings = Array.from({ length: 12 }, (_, index) => ({
        sessionKey: `agent:cellect-fi-admin:slack:channel:c123:thread:1700000000.${String(index).padStart(6, "0")}`,
        roomId: `!room${index}`,
      }));
      const readThread = vi.fn(async (rootMessageId: string) => ({
        workspaceId: "T123",
        channelId: "C123",
        rootMessageId,
        memberSenderIds: ["U111"],
        messages: [],
      }));
      const readChannel = vi.fn(async () => {
        if (outage) {
          throw new Error("source denied");
        }
        return { workspaceId: "T123", channelId: "C123", memberSenderIds: ["U111"], readThread };
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) });
      vi.stubGlobal("fetch", fetchMock);
      let service: { start: () => void; stop: () => void } | undefined;
      const api = {
        config: {
          bindings: [
            { agentId: "cellect-fi-admin", match: { channel: "slack", accountId: "fi-admin" } },
          ],
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerGatewayMethod: vi.fn(),
        registerService: (value: typeof service) => {
          service = value;
        },
        runtime: {
          channel: {
            runtimeContexts: {
              get: ({ channelId }: { channelId: string }) =>
                channelId === "matrix"
                  ? { list: async () => bindings }
                  : { workspaceId: "T123", botUserId: "U222", readChannel },
            },
          },
        },
      } as unknown as OpenClawPluginApi;
      registerSlackProjectionReconciler(api, () => ({
        baseUrl: "https://fi.example",
        token: "test-token",
      }));
      if (!service) {
        throw new Error("Missing registered reconciler");
      }
      service.start();
      await vi.advanceTimersByTimeAsync(5000);
      expect(readChannel).toHaveBeenCalledTimes(1);
      expect(readThread).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 33; index++) {
        await vi.advanceTimersByTimeAsync(60_000);
      }
      service.stop();
      const payloads = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
      expect(payloads).toHaveLength(12);
      expect(payloads.every((payload) => payload.reconcile === true)).toBe(true);
      if (outage) {
        expect(payloads.every((payload) => payload.unavailable === true && !payload.snapshot)).toBe(
          true,
        );
      } else {
        expect(payloads.every((payload) => !payload.snapshot)).toBe(true);
        expect(payloads.every((payload) => payload.source.memberSenderIds.includes("U111"))).toBe(
          true,
        );
      }
    },
  );
});
