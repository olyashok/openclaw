// Matrix session projection public registration surface.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { CoreConfig } from "./src/types.js";

const loadSessionProjectionModule = createLazyRuntimeModule(
  () => import("./src/matrix/session-projection.js"),
);

export function registerMatrixSessionProjection(api: OpenClawPluginApi): void {
  api.runtime.channel.runtimeContexts.register({
    channelId: "matrix",
    capability: "session-read-projections",
    context: {
      list: async () => {
        const { listReadOnlyMatrixSessionProjections } = await loadSessionProjectionModule();
        return listReadOnlyMatrixSessionProjections();
      },
    },
  });
  const runInBackground = (operation: string, task: Promise<void>) => {
    // Mirroring is secondary delivery. A slow or unavailable Matrix server
    // must never delay the originating channel's message or assistant answer.
    void task.catch((error: unknown) => {
      api.logger.warn(
        `matrix: session projection ${operation} failed: ${formatErrorMessage(error)}`,
      );
    });
  };

  api.registerGatewayMethod(
    "matrix.sessionProjection.inspect",
    async (options) => {
      const { handleMatrixSessionProjectionInspect } = await loadSessionProjectionModule();
      handleMatrixSessionProjectionInspect(options);
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "matrix.sessionProjection.rebaseHistory",
    async (options) => {
      const { handleMatrixSessionProjectionRebase } = await loadSessionProjectionModule();
      await handleMatrixSessionProjectionRebase(options);
    },
    { scope: "operator.admin" },
  );
  api.registerGatewayMethod(
    "matrix.sessionProjection.create",
    async (options) => {
      const { handleMatrixSessionProjectionCreate } = await loadSessionProjectionModule();
      await handleMatrixSessionProjectionCreate(options);
    },
    { scope: "operator.admin" },
  );

  api.on("message_received", async (event, context) => {
    const { handleMatrixSessionProjectionMessageReceived } = await loadSessionProjectionModule();
    runInBackground(
      "user-message",
      handleMatrixSessionProjectionMessageReceived(
        event,
        context,
        (api.runtime.config?.current?.() ?? api.config) as CoreConfig,
      ),
    );
  });

  api.on("reply_payload_sending", async (event, context) => {
    const { handleMatrixSessionProjectionReplyPayloadSending } =
      await loadSessionProjectionModule();
    runInBackground(
      "assistant-reply",
      handleMatrixSessionProjectionReplyPayloadSending(
        event,
        context,
        (api.runtime.config?.current?.() ?? api.config) as CoreConfig,
      ),
    );
  });
}
