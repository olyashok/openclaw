import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listAccountIds: vi.fn(() => ["user-prod", "admin-prod"]),
  resolveAccount: vi.fn(({ accountId }: { accountId: string }) => ({
    userId: accountId === "admin-prod" ? "@admin:matrix.test" : "@user:matrix.test",
  })),
  resolveRoute: vi.fn(async () => ({ sessionKey: "agent:admin:matrix:room:thread:root" })),
}));

vi.mock("../../extensions/matrix/src/matrix/accounts.js", () => ({
  listMatrixAccountIds: mocks.listAccountIds,
  resolveMatrixAccount: mocks.resolveAccount,
}));
vi.mock("../infra/outbound/outbound-session.js", () => ({
  resolveOutboundSessionRoute: mocks.resolveRoute,
}));

import { resolveMatrixTalkBinding } from "./talk-matrix-binding.js";

describe("resolveMatrixTalkBinding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the configured Matrix account and canonical outbound thread resolver", async () => {
    const cfg = {
      bindings: [{ agentId: "admin", match: { channel: "matrix", accountId: "admin-prod" } }],
    } as never;
    await expect(
      resolveMatrixTalkBinding({
        cfg,
        roomId: "!room:matrix.test",
        threadRootEventId: "$root",
        agentMxid: "@admin:matrix.test",
      }),
    ).resolves.toEqual({
      sessionKey: "agent:admin:matrix:room:thread:root",
      agentId: "admin",
      accountId: "admin-prod",
    });
    expect(mocks.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        agentId: "admin",
        accountId: "admin-prod",
        target: "room:!room:matrix.test",
        threadId: "$root",
      }),
    );
  });

  it("fails closed when an MXID does not identify exactly one account", async () => {
    mocks.listAccountIds.mockReturnValueOnce([]);
    await expect(
      resolveMatrixTalkBinding({
        cfg: {} as never,
        roomId: "!room:matrix.test",
        threadRootEventId: "$root",
        agentMxid: "@unknown:matrix.test",
      }),
    ).rejects.toThrow("did not resolve uniquely");
    expect(mocks.resolveRoute).not.toHaveBeenCalled();
  });
});
