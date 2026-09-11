import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  extractDocumentContent: vi.fn(),
}));

vi.mock("node:util", () => ({ promisify: () => mocks.execFile }));
vi.mock("openclaw/plugin-sdk/document-extractor", () => ({
  extractDocumentContent: mocks.extractDocumentContent,
}));

import fiUserPlugin from "./index.js";

type ToolFactory = (context: OpenClawPluginToolContext) => AnyAgentTool | AnyAgentTool[] | null;

const runtimeConfig = {
  plugins: {
    entries: {
      "fi-user": {
        config: {
          baseUrl: "https://fi.example.test",
          brokerTokenEnv: "TEST_BROKER_TOKEN",
          gamBinary: "/opt/gam",
          gamConfigDir: "/opt/gam-config",
        },
      },
    },
  },
};

function registeredTools(context: OpenClawPluginToolContext): AnyAgentTool[] {
  const registrations: Array<AnyAgentTool | ToolFactory> = [];
  fiUserPlugin.register?.(
    createTestPluginApi({
      id: "fi-user",
      name: "Fi User Delegation",
      config: runtimeConfig,
      registerTool: (tool) => registrations.push(tool as AnyAgentTool | ToolFactory),
    }),
  );
  const registered = registrations[0];
  if (!registered) {
    throw new Error("expected fi-user tool registration");
  }
  const result = typeof registered === "function" ? registered(context) : registered;
  return result ? (Array.isArray(result) ? result : [result]) : [];
}

function slackContext(overrides: Partial<OpenClawPluginToolContext> = {}) {
  return {
    agentId: "cellect-fi-user",
    messageChannel: "slack",
    requesterSenderId: "U12345678",
    getRuntimeConfig: () => runtimeConfig,
    ...overrides,
  } as OpenClawPluginToolContext;
}

function delegatedResponse() {
  return {
    ok: true,
    json: async () => ({
      user: { email: "member@example.com", orgSlug: "shape", role: "member" },
      gmail: { enabled: true, mailbox: "member@example.com" },
      fi: { token: "delegated-token", expiresAt: 1_900_000_000 },
    }),
  } as Response;
}

describe("Fi user requester-bound Google Drive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TEST_BROKER_TOKEN", "broker-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => delegatedResponse()),
    );
  });

  it("registers Drive only for a verified Fi-user Slack turn", () => {
    expect(registeredTools(slackContext()).map((tool) => tool.name)).toEqual([
      "fi_user_gmail",
      "fi_user_gdrive",
      "fi_user_dataroom",
    ]);
    expect(registeredTools(slackContext({ requesterSenderId: undefined }))).toEqual([]);
    expect(registeredTools(slackContext({ messageChannel: "matrix" }))).toEqual([]);
  });

  it("searches every file visible to the immutable requester mailbox", async () => {
    mocks.execFile.mockResolvedValue({
      stdout: "Owner,id,name\nmember@example.com,1,Contract",
      stderr: "",
    });
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    const result = await drive.execute("call-1", {
      action: "search",
      query: "name contains 'Contract'",
      maxResults: 15,
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://fi.example.test/api/openclaw-user-delegation",
      expect.objectContaining({
        body: JSON.stringify({ requesterSenderId: "U12345678", agentId: "cellect-fi-user" }),
      }),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      "/opt/gam",
      [
        "user",
        "member@example.com",
        "print",
        "filelist",
        "anyowner",
        "query",
        "name contains 'Contract'",
        "excludetrashed",
        "maxfiles",
        "15",
        "fields",
        "id,name,mimetype,size,modifiedtime,parents",
        "filepath",
      ],
      expect.objectContaining({ env: expect.objectContaining({ GAMCFGDIR: "/opt/gam-config" }) }),
    );
    expect(result.details).toEqual({
      mailbox: "member@example.com",
      output: "Owner,id,name\nmember@example.com,1,Contract",
    });
  });

  it("downloads and extracts a requester-visible PDF for the model", async () => {
    mocks.execFile.mockImplementation(async (_binary, args: string[]) => {
      if (args.includes("info")) {
        return {
          stdout: JSON.stringify({
            id: "drive-file-1",
            name: "Contract.pdf",
            mimeType: "application/pdf",
            size: "1024",
          }),
          stderr: "",
        };
      }
      const targetIndex = args.indexOf("targetfolder");
      const targetFolder = args[targetIndex + 1];
      await fs.writeFile(path.join(targetFolder, "Contract.pdf"), "%PDF-1.4 test");
      return { stdout: "downloaded", stderr: "" };
    });
    mocks.extractDocumentContent.mockResolvedValue({
      text: "Developer-favorable scope text",
      images: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
      extractor: "pdf",
    });
    const drive = registeredTools(slackContext()).find((tool) => tool.name === "fi_user_gdrive");
    if (!drive) {
      throw new Error("expected Drive tool");
    }

    const result = await drive.execute("call-2", {
      action: "read",
      fileId: "drive-file-1",
      maxPages: 12,
    });

    expect(mocks.extractDocumentContent).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "application/pdf", maxPages: 12 }),
    );
    expect(result.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Developer-favorable"),
      }),
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
    expect(result.details).toEqual(
      expect.objectContaining({
        mailbox: "member@example.com",
        extractedTextChars: 30,
        extractedImageCount: 1,
      }),
    );
  });
});
