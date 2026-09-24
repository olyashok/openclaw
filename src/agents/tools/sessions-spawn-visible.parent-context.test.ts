/**
 * Visible sessions_spawn children receive the requester turn's attachments and
 * honor the resolved run timeout (0 = no timeout) on their initial turn.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { maybeSpawnVisibleSession } from "./sessions-spawn-visible.js";

function createVisibleSpawnDeps(workspace: string) {
  const callGateway = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({
    key: "agent:main:dashboard:child",
    runStarted: true,
    runId: "run-visible",
  }));
  return {
    callGateway,
    options: {
      agentSessionKey: "agent:main:main",
      config: {
        session: { store: path.join(workspace, "sessions.json") },
        agents: { list: [{ id: "main", workspace }] },
      },
      callGateway: callGateway as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    },
  };
}

function readCreateParams(
  callGateway: ReturnType<typeof createVisibleSpawnDeps>["callGateway"],
): Record<string, unknown> {
  return callGateway.mock.calls.find(([method]) => method === "sessions.create")?.[1] ?? {};
}

describe("visible sessions_spawn parent context", () => {
  it("copies the requester turn's PDFs into the child workspace and lists them in the task", async () => {
    await withTestDir({ prefix: "openclaw-visible-parent-media-" }, async (dir) => {
      const workspace = path.join(dir, "workspace");
      const inbound = path.join(dir, "inbound");
      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(inbound, { recursive: true });
      const pdfs = ["Scope A.pdf", "Scope B.pdf", "Scope C.pdf"];
      for (const name of pdfs) {
        await fs.writeFile(path.join(inbound, name), `%PDF-1.7 ${name}`);
      }
      const { callGateway, options } = createVisibleSpawnDeps(workspace);
      const task = "Compare plumbing scope across the three attached PDFs.";

      const result = await maybeSpawnVisibleSession({
        raw: { visible: true },
        task,
        label: "",
        runtime: "subagent",
        runTimeoutSeconds: 0,
        sandbox: "inherit",
        options: {
          ...options,
          parentTurnMedia: pdfs.map((name) => ({
            path: path.join(inbound, name),
            contentType: "application/pdf",
            fileName: name,
          })),
        },
      });

      expect(result).toMatchObject({ status: "accepted", runId: "run-visible" });
      const sent = readCreateParams(callGateway);
      const childTask = String(sent.task);
      expect(childTask.startsWith(task)).toBe(true);
      expect(childTask).toContain("3 file(s) copied into your workspace");
      const listed = [
        ...childTask.matchAll(/\.openclaw\/attachments\/[^/\s]+\/(Scope [ABC]\.pdf)/g),
      ];
      expect(listed.map((match) => match[1])).toEqual(pdfs);
      for (const match of listed) {
        const copied = path.join(workspace, match[0]);
        await expect(fs.readFile(copied, "utf8")).resolves.toBe(`%PDF-1.7 ${match[1]}`);
      }
    });
  });

  it("forwards runTimeoutSeconds to the child's initial turn, with 0 meaning no timeout", async () => {
    await withTestDir({ prefix: "openclaw-visible-timeout-" }, async (workspace) => {
      for (const [runTimeoutSeconds, timeoutMs] of [
        [0, 0],
        [120, 120_000],
      ] as const) {
        const { callGateway, options } = createVisibleSpawnDeps(workspace);
        await maybeSpawnVisibleSession({
          raw: { visible: true },
          task: "monitor the fix",
          label: "",
          runtime: "subagent",
          runTimeoutSeconds,
          sandbox: "inherit",
          options,
        });
        expect(readCreateParams(callGateway)).toMatchObject({
          task: "monitor the fix",
          timeoutMs,
        });
      }
    });
  });

  it("removes forwarded copies when the visible session does not start", async () => {
    await withTestDir({ prefix: "openclaw-visible-parent-media-fail-" }, async (dir) => {
      const workspace = path.join(dir, "workspace");
      await fs.mkdir(workspace, { recursive: true });
      const pdf = path.join(dir, "Scope A.pdf");
      await fs.writeFile(pdf, "%PDF-1.7");
      const { callGateway, options } = createVisibleSpawnDeps(workspace);
      callGateway.mockImplementation(async (method: string) =>
        method === "sessions.create"
          ? { key: "agent:main:dashboard:child", runStarted: false, runId: "" }
          : ({} as never),
      );

      const result = await maybeSpawnVisibleSession({
        raw: { visible: true },
        task: "compare",
        label: "",
        runtime: "subagent",
        runTimeoutSeconds: 0,
        sandbox: "inherit",
        options: { ...options, parentTurnMedia: [{ path: pdf, fileName: "Scope A.pdf" }] },
      });

      expect(result).toMatchObject({ status: "error" });
      await expect(fs.readdir(path.join(workspace, ".openclaw", "attachments"))).resolves.toEqual(
        [],
      );
    });
  });
});
