// Matrix session projection public registration surface.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { CoreConfig } from "./src/types.js";

const loadSessionProjectionModule = createLazyRuntimeModule(
  () => import("./src/matrix/session-projection.js"),
);

export function registerMatrixSessionProjection(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "matrix.sessionProjection.replay",
    async ({ params, respond }) => {
      try {
        const { replayMatrixProjectionPublication } = await import("./src/matrix/delivery-plan.js");
        respond(
          true,
          await replayMatrixProjectionPublication(
            (api.runtime.config?.current?.() ?? api.config) as CoreConfig,
            params ?? {},
          ),
        );
      } catch (error) {
        respond(false, { error: formatErrorMessage(error) });
      }
    },
    { scope: "operator.admin" },
  );
  api.registerGatewayMethod(
    "matrix.sessionProjection.bootstrap",
    async ({ params, respond }) => {
      try {
        const { bootstrapMatrixSessionProjection } =
          await import("./src/matrix/projection-bootstrap.js");
        respond(
          true,
          await bootstrapMatrixSessionProjection(
            (api.runtime.config?.current?.() ?? api.config) as CoreConfig,
            params ?? {},
          ),
        );
      } catch (error) {
        respond(false, { error: formatErrorMessage(error) });
      }
    },
    { scope: "operator.admin" },
  );
  let lifecycle: { stop: () => void } | undefined;
  let stopSourceReceipts: (() => void) | undefined;
  api.registerService({
    id: "matrix-projection-lifecycle",
    async start() {
      const { startMatrixProjectionLifecycle } =
        await import("./src/matrix/projection-lifecycle.js");
      lifecycle?.stop();
      lifecycle = startMatrixProjectionLifecycle(api);
      stopSourceReceipts?.();
      const { startMatrixSourceResultReceipts } =
        await import("./src/matrix/projection-source-result.js");
      stopSourceReceipts = startMatrixSourceResultReceipts();
    },
    stop() {
      lifecycle?.stop();
      lifecycle = undefined;
      stopSourceReceipts?.();
      stopSourceReceipts = undefined;
    },
  });
  api.registerGatewayMethod(
    "matrix.sessionProjection.status",
    async ({ params, respond }) => {
      try {
        const { getMatrixProjectionStatus } = await import("./src/matrix/projection-source.js");
        const roomId = typeof params?.roomId === "string" ? params.roomId.trim() : "";
        const accountId =
          typeof params?.accountId === "string" ? params.accountId.trim() : undefined;
        respond(true, getMatrixProjectionStatus(roomId, accountId));
      } catch (error) {
        respond(false, { error: formatErrorMessage(error) });
      }
    },
    { scope: "operator.admin" },
  );
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
    const { prepareMatrixSourceResult } = await import("./src/matrix/projection-source-result.js");
    await prepareMatrixSourceResult(event);
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
