import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import {
  projectSlackChannelThread,
  registerSlackProjectionReconciler,
} from "./channel-projection.js";
import { recoverSlackDirectProjection } from "./direct-projection.js";

export { projectSlackChannelThread };

export type SlackProjectionMessage = {
  content: string;
  sessionKey?: string;
  messageId?: string;
  runId?: string;
  senderId?: string;
};

export type SlackProjectionContext = {
  channelId: string;
  sessionKey?: string;
  messageId?: string;
  runId?: string;
  senderId?: string;
  accountId?: string;
};

export function registerSlackChannelProjection(
  api: OpenClawPluginApi,
  connection: () => { baseUrl: string; token?: string },
) {
  const reconciler = registerSlackProjectionReconciler(api, connection);
  api.registerGatewayMethod(
    "fi.slackProjection.sync",
    async ({ params, respond }) => {
      const { baseUrl, token } = connection();
      try {
        if (token && typeof params?.sessionKey === "string" && params.directSource) {
          respond(
            true,
            await recoverSlackDirectProjection(
              api,
              { baseUrl, token },
              params.sessionKey,
              params.directSource,
            ),
          );
          return;
        }
        if (
          !token ||
          typeof params?.sessionKey !== "string" ||
          typeof params.accountId !== "string" ||
          typeof params.requesterSenderId !== "string"
        ) {
          throw new Error("Missing Slack projection parameters");
        }
        const projected = await projectSlackChannelThread({
          api,
          token,
          baseUrl,
          sessionKey: params.sessionKey,
          accountId: params.accountId,
          requesterSenderId: params.requesterSenderId,
        });
        if (!projected) {
          throw new Error("Unsupported Slack channel session");
        }
        respond(true, { projected: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Slack projection failed";
        respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
      }
    },
    { scope: "operator.admin" },
  );
  api.on("message_sent", async (event, context) => {
    if (!event.success || context.channelId !== "slack" || !context.accountId) {
      return;
    }
    const sessionKey = event.sessionKey ?? context.sessionKey;
    const { baseUrl, token } = connection();
    if (!sessionKey || !token) {
      return;
    }
    if (/^agent:[^:]+:slack:(channel|group):[cg][a-z0-9]+$/i.test(sessionKey)) {
      reconciler.wake(sessionKey);
      return;
    }
    void projectSlackChannelThread({
      api,
      token,
      baseUrl,
      sessionKey,
      accountId: context.accountId,
      discover: true,
    }).catch(() => {
      api.logger.warn("fi-user: channel projection failed after Slack delivery");
    });
  });
}
