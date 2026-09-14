import { createHash } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateConversationContinueParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveOutboundSessionRoute } from "../../infra/outbound/outbound-session.js";
import { deliverWebchatCompletionFallback } from "../webchat-completion-delivery-send.js";
import {
  verifyWebchatCompletionDeliveryClaim,
  WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV,
} from "../webchat-completion-delivery.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

function agentIdFromMxid(mxid: string): string | undefined {
  const match = /^@([^:]+):.+$/.exec(mxid.trim());
  return match?.[1]?.trim().toLowerCase() || undefined;
}

export async function handleConversationContinue({
  params,
  respond,
  context,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (
    !assertValidParams(params, validateConversationContinueParams, "conversation.continue", respond)
  ) {
    return;
  }
  const source = params.source as {
    channel: "matrix";
    roomId: string;
    threadRootEventId: string;
    agentMxid: string;
  };
  const agentId = agentIdFromMxid(source.agentMxid);
  if (!agentId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid Matrix agent"));
    return;
  }
  const route = verifyWebchatCompletionDeliveryClaim({
    claim: params.destinationClaim as string,
    secret: process.env[WEBCHAT_COMPLETION_DELIVERY_SECRET_ENV],
    expectedAgentId: agentId,
  });
  if (!route || route.channel !== "slack" || !/^user:[^:]+$/i.test(route.to.trim())) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid private Slack destination"),
    );
    return;
  }
  const cfg = context.getRuntimeConfig();
  const sourceRoute = await resolveOutboundSessionRoute({
    cfg,
    channel: "matrix",
    agentId,
    target: source.roomId,
    threadId: source.threadRootEventId,
  });
  if (!sourceRoute?.recipientSessionExact || sourceRoute.peer.kind === "direct") {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Matrix conversation is not bound to this agent"),
    );
    return;
  }
  const intent = createHash("sha256")
    .update(sourceRoute.sessionKey)
    .update("\0")
    .update(route.channel)
    .update("\0")
    .update(route.accountId ?? "default")
    .update("\0")
    .update(route.to)
    .digest("hex");
  const result = await deliverWebchatCompletionFallback({
    cfg,
    state: { route, armedAtMs: 0 },
    startedAtMs: 0,
    nowMs: Date.now(),
    runId: `conversation-continue:${intent}`,
    sessionId: source.threadRootEventId,
    sessionKey: sourceRoute.sessionKey,
    agentId,
    ctx: { SessionKey: sourceRoute.sessionKey },
    replies: [{ kind: "final", payload: { text: "This conversation is ready in Slack." } }],
    deliveryIntentId: `conversation-continue:${intent}`,
    continuationMarker: true,
    log: { warn: (message) => context.logGateway.warn(message) },
  });
  if (result !== "handled") {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "continuation delivery failed"));
    return;
  }
  respond(true, { status: "continued" });
}
