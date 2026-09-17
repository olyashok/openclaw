import { listAllBindings } from "./thread-bindings-shared.js";

/** Native inventory remains available after its source session is pruned. */
export function listReadOnlyMatrixSessionProjections() {
  const rooms = new Set<string>();
  return listAllBindings()
    .toSorted((left, right) => right.boundAt - left.boundAt)
    .flatMap((binding) => {
      const roomId = binding.parentConversationId;
      if (
        !["session-projection-read-only", "session-projection-slack-direct"].includes(
          binding.boundBy ?? "",
        ) ||
        !roomId ||
        rooms.has(roomId)
      ) {
        return [];
      }
      rooms.add(roomId);
      return [
        { sessionKey: binding.targetSessionKey, roomId, externalSource: binding.externalSource },
      ];
    });
}

export type ProjectionExternalSource = {
  provider: string;
  workspaceId: string;
  channelId: string;
  rootMessageId: string;
};

export function resolveDetachedProjectionSource(params: {
  sourceDetached?: boolean;
  sourceDirect?: boolean;
  readOnly?: boolean;
  externalSource?: unknown;
  targetSessionKey: string;
}) {
  const source = parseProjectionExternalSource(params.externalSource);
  if (params.sourceDetached) {
    const parent = /^agent:[^:]+:slack:(?:channel|group):([cg][a-z0-9]+)$/i.exec(
      params.targetSessionKey,
    );
    if (
      !params.readOnly ||
      params.sourceDirect ||
      !source ||
      source.provider !== "slack" ||
      parent?.[1]?.toUpperCase() !== source.channelId ||
      !/^T[A-Z0-9]+$/.test(source.workspaceId) ||
      !/^\d+\.\d+$/.test(source.rootMessageId)
    ) {
      throw new Error("Detached source requires a matching read-only parent session");
    }
  }
  return source;
}

export function parseProjectionExternalSource(
  value: unknown,
): ProjectionExternalSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const field = (key: string) =>
    typeof source[key] === "string" && source[key].length <= 255 ? source[key] : undefined;
  const provider = field("provider");
  const workspaceId = field("workspaceId");
  const channelId = field("channelId");
  const rootMessageId = field("rootMessageId");
  if (!provider || !workspaceId || !channelId || !rootMessageId) {
    return undefined;
  }
  return {
    provider,
    workspaceId,
    channelId,
    rootMessageId,
  };
}
