import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";

export async function resolveMatrixTalkBinding(params: {
  cfg: OpenClawConfig;
  roomId: string;
  threadRootEventId: string;
  agentMxid: string;
}): Promise<{ sessionKey: string; agentId: string; accountId: string }> {
  const roomId = normalizeOptionalString(params.roomId);
  const threadRootEventId = normalizeOptionalString(params.threadRootEventId);
  const agentMxid = normalizeOptionalString(params.agentMxid);
  if (!roomId || !threadRootEventId || !agentMxid) {
    throw new Error("Matrix Talk binding requires roomId, threadRootEventId, and agentMxid");
  }

  // Account credentials may come from the Matrix credential store rather than
  // openclaw.json, so account identity must be resolved by the owning plugin.
  const { listMatrixAccountIds, resolveMatrixAccount } =
    await import("../../extensions/matrix/account-resolver-api.js");
  const matches = listMatrixAccountIds(params.cfg).filter(
    (accountId) => resolveMatrixAccount({ cfg: params.cfg, accountId }).userId === agentMxid,
  );
  if (matches.length !== 1) {
    throw new Error("Matrix Talk agent account did not resolve uniquely");
  }
  const accountId = matches[0]!;
  const binding = params.cfg.bindings?.find(
    (candidate) =>
      candidate.type !== "acp" &&
      candidate.match?.channel === "matrix" &&
      candidate.match?.accountId === accountId,
  );
  const agentId = normalizeOptionalString(binding?.agentId);
  if (!agentId) {
    throw new Error("Matrix Talk agent route is not configured");
  }
  const route = await resolveOutboundSessionRoute({
    cfg: params.cfg,
    channel: "matrix",
    agentId,
    accountId,
    target: `room:${roomId}`,
    threadId: threadRootEventId,
  });
  if (!route) {
    throw new Error("Matrix Talk conversation route is unavailable");
  }
  return { sessionKey: route.sessionKey, agentId, accountId };
}
