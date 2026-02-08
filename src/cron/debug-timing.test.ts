import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { CronService } from "./service.js";

const noopLogger = {
  debug: (..._args: unknown[]) => {
    /* console.log('DEBUG:', ..._args); */
  },
  info: (...args: unknown[]) => {
    console.log("INFO:", ...args);
  },
  warn: (...args: unknown[]) => {
    console.log("WARN:", ...args);
  },
  error: (...args: unknown[]) => {
    console.log("ERROR:", ...args);
  },
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForJob(
  cron: CronService,
  id: string,
  predicate: (job: CronJob | undefined) => boolean,
) {
  let latest: CronJob | undefined;
  for (let i = 0; i < 30; i++) {
    const jobs = await cron.list({ includeDisabled: true });
    latest = jobs.find((job) => job.id === id);
    console.log(
      `  waitForJob iter ${i}: lastStatus=${latest?.state.lastStatus}, nextRunAtMs=${latest?.state.nextRunAtMs}, enabled=${latest?.enabled}, Date.now()=${Date.now()}`,
    );
    if (predicate(latest)) {
      return latest;
    }
    await vi.runOnlyPendingTimersAsync();
  }
  return latest;
}

describe("debug", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cron expr timing", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    vi.setSystemTime(new Date("2025-12-13T00:00:59.000Z"));
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger as Parameters<typeof CronService.prototype.constructor>[0]["log"],
      enqueueSystemEvent,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "every minute",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron-tick" },
    });
    const firstDueAt = job.state.nextRunAtMs!;
    console.log("firstDueAt:", firstDueAt, new Date(firstDueAt).toISOString());

    vi.setSystemTime(new Date(firstDueAt + 5));
    console.log("After setSystemTime, Date.now():", Date.now(), new Date(Date.now()).toISOString());
    await vi.runOnlyPendingTimersAsync();
    console.log(
      "After runOnlyPendingTimersAsync, Date.now():",
      Date.now(),
      new Date(Date.now()).toISOString(),
    );

    const updated = await waitForJob(cron, job.id, (c) => c?.state.lastStatus === "ok");
    console.log(
      "Final nextRunAtMs:",
      updated?.state.nextRunAtMs,
      updated?.state.nextRunAtMs ? new Date(updated.state.nextRunAtMs).toISOString() : "undefined",
    );
    console.log("Expected:", firstDueAt + 60_000, new Date(firstDueAt + 60_000).toISOString());

    expect(updated?.state.nextRunAtMs).toBe(firstDueAt + 60_000);
    cron.stop();
    await store.cleanup();
  });
});
