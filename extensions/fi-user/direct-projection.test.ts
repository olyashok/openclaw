import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileSlackDirectProjections,
  recoverSlackDirectProjection,
} from "./direct-projection.js";
const mocks = vi.hoisted(() => ({ entry: vi.fn(), list: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: mocks.entry,
  listSessionEntries: mocks.list,
  sessionDeliveryOrigin: (entry: { origin?: unknown } | undefined) => entry?.origin,
}));
const sessionKey = "agent:cellect-fi-admin:slack:direct:u111";
describe("Fi direct projection discovery", () => {
  it("recovers only a complete native snapshot and never seeds empty history on read failure", async () => {
    const directSource = { workspaceId: "T123", channelId: "D123", peerSenderId: "U111" };
    const readDirect = vi.fn().mockResolvedValue({
      directSource,
      messages: [
        {
          messageId: "1700000000.000001",
          senderId: "U111",
          content: "Existing history",
          bot: false,
        },
      ],
    });
    const resolveSource = vi.fn().mockResolvedValue({ sourceAccountId: "configured-admin" });
    const api = {
      runtime: {
        channel: {
          runtimeContexts: {
            get: ({ channelId }: { channelId: string }) =>
              channelId === "matrix" ? { resolveSource } : { readDirect, botUserId: "U222" },
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
    const connection = { baseUrl: "https://fi.example", token: "test" };
    await expect(
      recoverSlackDirectProjection(api, connection, sessionKey, directSource),
    ).resolves.toEqual({ status: "existing" });
    const body = request.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") {
      throw new Error("Expected body");
    }
    expect(JSON.parse(body)).toMatchObject({
      directSource,
      sessionKey,
      snapshot: { complete: true, messages: [{ content: "Existing history" }] },
    });
    readDirect.mockRejectedValueOnce(new Error("partial source"));
    await expect(
      recoverSlackDirectProjection(api, connection, sessionKey, directSource),
    ).rejects.toThrow("partial source");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRestore();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.list.mockReturnValue([{ sessionKey, entry: {} }]);
    mocks.entry.mockReturnValue({
      origin: { accountId: "configured-admin", nativeChannelId: "D123" },
    });
  });
  it.each([false, true])(
    "preserves exact peer/account and revokes existing access on reader outage=%s",
    async (outage) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue({ ok: true, json: async () => ({ status: "existing" }) } as Response);
      const readDirect = vi.fn(async () => {
        if (outage) {
          throw new Error("access denied");
        }
        return {
          directSource: { workspaceId: "T123", channelId: "D123", peerSenderId: "U111" },
          messages: [
            { messageId: "1700000000.000001", senderId: "U222", content: "Reply", bot: true },
          ],
        };
      });
      const api = {
        config: {
          bindings: [
            {
              agentId: "cellect-fi-admin",
              match: { channel: "slack", accountId: "configured-admin" },
            },
          ],
        },
        logger: { warn: vi.fn() },
        runtime: {
          channel: { runtimeContexts: { get: () => ({ botUserId: "U222", readDirect }) } },
        },
      } as unknown as OpenClawPluginApi;
      const report = await reconcileSlackDirectProjections(
        api,
        { baseUrl: "https://fi.example", token: "test" },
        [{ sessionKey, roomId: "!room" }],
        new AbortController().signal,
      );
      expect(readDirect).toHaveBeenCalledWith("D123", "U111");
      const request = fetchMock.mock.calls[0]?.[1];
      if (typeof request?.body !== "string") {
        throw new Error("Expected JSON request body");
      }
      const payload = JSON.parse(request.body);
      expect(payload.sessionKey).toBe(sessionKey);
      if (outage) {
        expect(payload).toMatchObject({
          reconcile: true,
          unavailable: true,
          projectionRoomId: "!room",
        });
        expect(payload).not.toHaveProperty("snapshot");
        expect(report.error).toBe(1);
      } else {
        expect(payload.directSource).toEqual({
          workspaceId: "T123",
          channelId: "D123",
          peerSenderId: "U111",
        });
        expect(payload.snapshot.messages[0].agentId).toBe("cellect-fi-admin");
        expect(payload).not.toHaveProperty("source");
        expect(report.existing).toBe(1);
      }
      fetchMock.mockRestore();
    },
  );
});
