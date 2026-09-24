import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { ChannelProjectionParams } from "./channel-projection.js";
import {
  logProjectionRefresh,
  PARENT,
  planProjectionRoom,
  resolveDetachedRoomAccount,
  type ProjectionInventory,
  type ProjectionInventoryBinding,
} from "./detached-projection.js";

// Self-healing for bound Slack projection rooms.
//
// Planning a room is a read-only dry run against Matrix, so it can cover many
// rooms per tick. Only a full refresh reads Slack, so refreshes stay at the
// configured per-tick budget and back off when a refresh does not converge
// the room.

/** Every bound room is planned at least once per this many ticks. */
export const DRIFT_ROTATION_TICKS = 30;
/** Rotation plans per tick never drop below this, whatever the room count. */
export const DRIFT_MIN_ROTATION_PLANS = 4;
/** Rotation plans per tick never exceed this, whatever the room count. */
export const DRIFT_MAX_ROTATION_PLANS = 40;
/** Rooms planned ahead of the rotation (recent activity, earlier failures). */
export const DRIFT_PRIORITY_PLANS = 4;
/** A room with fresh activity is planned once live delivery has settled. */
export const DRIFT_ACTIVITY_SETTLE_MS = 60_000;
/** A room whose last plan was not clean is planned again after this long. */
export const DRIFT_SUSPECT_REPLAN_MS = 15 * 60_000;
/** A refreshed room is planned again this soon, to confirm it converged. */
export const DRIFT_REFRESH_CONFIRM_MS = 2 * 60_000;
/** Delay before the next refresh of a room that is still drifted. */
export const DRIFT_REFRESH_BACKOFF_MS = [
  60 * 60_000,
  3 * 60 * 60_000,
  9 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;
/**
 * A room Fi declined to publish (a retired conversation, a source with no
 * eligible readers) is not refreshed again for this long unless the room has
 * new activity: a refresh would only re-read Slack for Fi to decline again.
 */
export const DRIFT_DECLINED_BACKOFF_MS = 7 * 24 * 60 * 60_000;
const ACTIVITY_RETENTION_MS = 24 * 60 * 60_000;

export type DriftPlanVerdict = { converged: boolean; invariantsOk: boolean };
type RoomState = {
  plannedAt: number;
  /** When a room that is not clean is planned again ahead of the rotation. */
  replanAt: number;
  verdict: "converged" | "drifted" | "invariant" | "failed";
  driftSince?: number;
  refreshAttempts: number;
  refreshAfter: number;
  /** When Fi last declined a refresh of this room. */
  declinedAt?: number;
};

export function createProjectionDriftScheduler(now: () => number = Date.now) {
  const rooms = new Map<string, RoomState>();
  const activity = new Map<string, number>();
  let tickStartedAt = 0;
  const activityAt = (room: { roomId: string; sessionKey: string }) =>
    Math.max(activity.get(room.roomId) ?? 0, activity.get(room.sessionKey) ?? 0);
  return {
    /** Slack or Matrix activity for a session key or Matrix room id. */
    noteActivity(key: string | undefined) {
      if (key) {
        activity.set(key, now());
      }
    },
    /** Rooms to plan this tick: active and suspect rooms first, then the rotation. */
    selectPlans(bound: ReadonlyArray<{ roomId: string; sessionKey: string }>): string[] {
      const at = now();
      tickStartedAt = at;
      const current = new Set(bound.map((room) => room.roomId));
      for (const roomId of rooms.keys()) {
        if (!current.has(roomId)) {
          rooms.delete(roomId);
        }
      }
      for (const [key, seenAt] of activity) {
        if (at - seenAt > ACTIVITY_RETENTION_MS) {
          activity.delete(key);
        }
      }
      const priority: Array<{ roomId: string; tier: number; rank: number }> = [];
      const rotation: Array<{ roomId: string; plannedAt: number }> = [];
      for (const room of bound) {
        const state = rooms.get(room.roomId);
        const plannedAt = state?.plannedAt ?? 0;
        const active = activityAt(room);
        if (active > plannedAt && at - active >= DRIFT_ACTIVITY_SETTLE_MS) {
          // Most recent activity first, ahead of every earlier failure.
          priority.push({ roomId: room.roomId, tier: 0, rank: -active });
        } else if (state && state.verdict !== "converged" && at >= state.replanAt) {
          priority.push({ roomId: room.roomId, tier: 1, rank: state.replanAt });
        } else {
          rotation.push({ roomId: room.roomId, plannedAt });
        }
      }
      priority.sort(
        (a, b) => a.tier - b.tier || a.rank - b.rank || a.roomId.localeCompare(b.roomId),
      );
      // Least recently planned first; never-planned rooms (a restart) lead.
      rotation.sort((a, b) => a.plannedAt - b.plannedAt || a.roomId.localeCompare(b.roomId));
      const rotationSlots = Math.min(
        DRIFT_MAX_ROTATION_PLANS,
        Math.max(DRIFT_MIN_ROTATION_PLANS, Math.ceil(bound.length / DRIFT_ROTATION_TICKS)),
      );
      const first = priority.slice(0, DRIFT_PRIORITY_PLANS).map((room) => room.roomId);
      const rotated = rotation.slice(0, rotationSlots).map((room) => room.roomId);
      // Unused rotation slots serve the remaining priority rooms.
      const spare = priority
        .slice(DRIFT_PRIORITY_PLANS, DRIFT_PRIORITY_PLANS + rotationSlots - rotated.length)
        .map((room) => room.roomId);
      return [...first, ...rotated, ...spare];
    },
    recordPlan(roomId: string, verdict: DriftPlanVerdict | undefined) {
      const at = now();
      const previous = rooms.get(roomId);
      if (verdict?.converged && verdict.invariantsOk) {
        rooms.set(roomId, {
          plannedAt: at,
          replanAt: Number.POSITIVE_INFINITY,
          verdict: "converged",
          refreshAttempts: 0,
          refreshAfter: 0,
        });
        return;
      }
      const drifted = verdict ? !verdict.converged : false;
      const declinedAt = drifted ? previous?.declinedAt : undefined;
      rooms.set(roomId, {
        plannedAt: at,
        // A declined room is left to the rotation; it cannot jump the queue.
        replanAt: declinedAt ? Number.POSITIVE_INFINITY : at + DRIFT_SUSPECT_REPLAN_MS,
        declinedAt,
        verdict: !verdict ? "failed" : drifted ? "drifted" : "invariant",
        driftSince: drifted ? (previous?.driftSince ?? at) : undefined,
        // A refresh cannot repair an invariant the plan does not act on, and a
        // room that stops drifting starts its backoff afresh next time.
        refreshAttempts: drifted ? (previous?.refreshAttempts ?? 0) : 0,
        refreshAfter: drifted ? (previous?.refreshAfter ?? 0) : 0,
      });
    },
    /**
     * Drifted rooms due a full refresh, recent activity first, then longest
     * drifted. Only rooms planned this tick qualify, so a room that converged
     * through live delivery since its last plan is never refreshed.
     */
    selectRefreshes(
      bound: ReadonlyArray<{ roomId: string; sessionKey: string }>,
      budget: number,
    ): string[] {
      const at = now();
      return bound
        .flatMap((room) => {
          const state = rooms.get(room.roomId);
          return state?.verdict === "drifted" &&
            state.plannedAt >= tickStartedAt &&
            (state.refreshAfter <= at ||
              (state.declinedAt !== undefined && activityAt(room) > state.declinedAt))
            ? [{ roomId: room.roomId, active: activityAt(room), since: state.driftSince ?? at }]
            : [];
        })
        .toSorted(
          (a, b) => b.active - a.active || a.since - b.since || a.roomId.localeCompare(b.roomId),
        )
        .slice(0, Math.max(0, budget))
        .map((room) => room.roomId);
    },
    /** Every attempt backs off; only a clean plan resets the room. */
    recordRefresh(roomId: string) {
      const state = rooms.get(roomId);
      if (!state) {
        return;
      }
      const delay =
        DRIFT_REFRESH_BACKOFF_MS[
          Math.min(state.refreshAttempts, DRIFT_REFRESH_BACKOFF_MS.length - 1)
        ] ?? DRIFT_REFRESH_BACKOFF_MS[0];
      state.refreshAttempts++;
      state.refreshAfter = now() + delay;
      state.replanAt = now() + DRIFT_REFRESH_CONFIRM_MS;
    },
    /** Fi accepted the refresh but declined to publish it (status `skipped`). */
    recordDeclined(roomId: string) {
      const state = rooms.get(roomId);
      if (!state) {
        return;
      }
      state.declinedAt = now();
      state.refreshAfter = now() + DRIFT_DECLINED_BACKOFF_MS;
      state.replanAt = Number.POSITIVE_INFINITY;
    },
    summary() {
      const states = [...rooms.values()];
      return {
        declined: states.filter((state) => state.declinedAt !== undefined).length,
        tracked: states.length,
        drifted: states.filter((state) => state.verdict === "drifted").length,
        invariant: states.filter((state) => state.verdict === "invariant").length,
        planFailed: states.filter((state) => state.verdict === "failed").length,
      };
    },
  };
}

export type ProjectionDriftScheduler = ReturnType<typeof createProjectionDriftScheduler>;

const CHANNEL_THREAD =
  /^agent:(cellect-fi-user|cellect-fi-admin|cellect-main):slack:channel:([cg][a-z0-9]+):thread:(\d+\.\d+)$/i;

/**
 * One drift pass: plan the selected bound rooms against Matrix, then refresh
 * the drifted ones from a full Slack snapshot within the budget. A budget of 0
 * (or a Matrix runtime without `plan`) disables the pass.
 */
export async function runProjectionDriftPass(params: {
  api: Pick<OpenClawPluginApi, "logger">;
  drift: ProjectionDriftScheduler;
  inventory: ProjectionInventory;
  bindings: readonly ProjectionInventoryBinding[];
  budget: number;
  configured: Parameters<typeof resolveDetachedRoomAccount>[0];
  active: () => boolean;
  channelAccount: (agentId: string, channelId: string, sessionKey: string) => string | undefined;
  publish: (
    params: Pick<
      ChannelProjectionParams,
      "api" | "sessionKey" | "accountId" | "reconcile" | "refresh" | "projectionRoomId" | "onResult"
    > &
      Pick<ChannelProjectionParams, "detachedSource">,
  ) => Promise<boolean>;
}) {
  const { api, drift, inventory } = params;
  if (!inventory.plan || params.budget <= 0) {
    return undefined;
  }
  const rooms = params.bindings.filter(
    (binding) =>
      CHANNEL_THREAD.test(binding.sessionKey) ||
      (binding.externalSource?.provider === "slack" && PARENT.test(binding.sessionKey)),
  );
  let planned = 0;
  for (const roomId of drift.selectPlans(rooms)) {
    if (!params.active()) {
      return undefined;
    }
    drift.recordPlan(roomId, await planProjectionRoom(inventory, roomId, api.logger));
    planned++;
  }
  let refreshed = 0;
  let refreshFailed = 0;
  let refreshDeclined = 0;
  for (const roomId of drift.selectRefreshes(rooms, params.budget)) {
    const binding = rooms.find((candidate) => candidate.roomId === roomId);
    if (!binding || !params.active()) {
      break;
    }
    drift.recordRefresh(roomId);
    const thread = CHANNEL_THREAD.exec(binding.sessionKey);
    const detachedSource = thread ? undefined : binding.externalSource;
    const lane = detachedSource ? "detached" : "channel";
    try {
      const detached = detachedSource
        ? resolveDetachedRoomAccount(params.configured, binding)
        : undefined;
      const accountId = detached
        ? detached.allowed
          ? detached.accountId
          : undefined
        : params.channelAccount(thread?.[1] ?? "", thread?.[2] ?? "", binding.sessionKey);
      if (!accountId) {
        throw new Error("Slack source account unavailable");
      }
      let status: string | undefined;
      await params.publish({
        api: api as OpenClawPluginApi,
        sessionKey: binding.sessionKey,
        accountId,
        reconcile: true,
        refresh: true,
        projectionRoomId: roomId,
        ...(detachedSource ? { detachedSource } : {}),
        onResult: (result) => {
          status = result;
        },
      });
      if (status === "skipped") {
        drift.recordDeclined(roomId);
        api.logger.info(
          `fi-user: projection refresh lane=${lane} room=${roomId} session=${binding.sessionKey} outcome=declined`,
        );
        refreshDeclined++;
        continue;
      }
      logProjectionRefresh(api.logger, lane, roomId, binding.sessionKey);
      refreshed++;
    } catch (error) {
      logProjectionRefresh(api.logger, lane, roomId, binding.sessionKey, error);
      refreshFailed++;
    }
  }
  return { rooms: rooms.length, planned, refreshed, refreshFailed, refreshDeclined };
}
