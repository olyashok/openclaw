import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 512 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

type PluginConfig = {
  baseUrl?: string;
  brokerTokenEnv?: string;
  gamBinary?: string;
  gamConfigDir?: string;
};

type Delegation = {
  user: { email: string; orgSlug: string; role: string };
  gmail: { enabled: boolean; mailbox: string | null };
  fi: { token: string; expiresAt: number };
};

function pluginConfig(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): Required<PluginConfig> {
  const cfg = context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config ?? api.config;
  const raw = cfg.plugins?.entries?.["fi-user"]?.config as PluginConfig | undefined;
  return {
    baseUrl: raw?.baseUrl?.replace(/\/+$/, "") || "https://app.cellect.ai/fi",
    brokerTokenEnv: raw?.brokerTokenEnv || "OPENCLAW_FI_USER_BROKER_TOKEN",
    gamBinary: raw?.gamBinary || "/home/node/.openclaw/bin/gam7/gam",
    gamConfigDir: raw?.gamConfigDir || "/home/claude/GAMConfig",
  };
}

async function exchange(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): Promise<{ delegation: Delegation; config: Required<PluginConfig> }> {
  const config = pluginConfig(api, context);
  const requesterSenderId = context.requesterSenderId?.trim();
  if (
    context.agentId !== "cellect-fi-user" ||
    context.messageChannel !== "slack" ||
    !requesterSenderId
  ) {
    throw new Error("This operation requires a verified Slack requester on Cellect Fi");
  }
  const brokerToken = process.env[config.brokerTokenEnv]?.trim();
  if (!brokerToken) throw new Error("Fi user delegation broker is not configured");

  const response = await fetch(`${config.baseUrl}/api/openclaw-user-delegation`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${brokerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requesterSenderId, agentId: context.agentId }),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "The current Slack requester is not linked to an active Fi member"
        : `Fi user delegation failed (${response.status})`,
    );
  }
  return { delegation: (await response.json()) as Delegation, config };
}

async function runGam(
  config: Required<PluginConfig>,
  mailbox: string,
  args: string[],
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(config.gamBinary, ["user", mailbox, ...args], {
    env: { ...process.env, GAMCFGDIR: config.gamConfigDir },
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

function requireMailbox(delegation: Delegation): string {
  if (!delegation.gmail.enabled || !delegation.gmail.mailbox) {
    throw new Error(`Gmail is not available for ${delegation.user.email}`);
  }
  return delegation.gmail.mailbox;
}

function mailArgs(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
}): string[] {
  const args = ["to", input.to.join(","), "subject", input.subject, "textmessage", input.body];
  if (input.cc?.length) args.push("cc", input.cc.join(","));
  if (input.bcc?.length) args.push("bcc", input.bcc.join(","));
  return args;
}

const GmailSchema = Type.Object(
  {
    action: stringEnum(["search", "read", "draft", "send"] as const),
    query: Type.Optional(Type.String({ maxLength: 1_000 })),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    messageId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    to: Type.Optional(Type.Array(Type.String({ format: "email" }), { minItems: 1, maxItems: 25 })),
    cc: Type.Optional(Type.Array(Type.String({ format: "email" }), { maxItems: 25 })),
    bcc: Type.Optional(Type.Array(Type.String({ format: "email" }), { maxItems: 25 })),
    subject: Type.Optional(Type.String({ maxLength: 500 })),
    body: Type.Optional(Type.String({ maxLength: 100_000 })),
    confirmSend: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function createGmailTool(api: OpenClawPluginApi, context: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: "fi_user_gmail",
    label: "My Gmail",
    description:
      "Search, read, draft, or send Gmail only as the current verified Cellect Fi requester. The mailbox is fixed by Fi membership and cannot be selected by the model.",
    parameters: GmailSchema,
    async execute(_toolCallId, raw) {
      const input = raw as {
        action: "search" | "read" | "draft" | "send";
        query?: string;
        maxResults?: number;
        messageId?: string;
        to?: string[];
        cc?: string[];
        bcc?: string[];
        subject?: string;
        body?: string;
        confirmSend?: boolean;
      };
      const { delegation, config } = await exchange(api, context);
      const mailbox = requireMailbox(delegation);

      if (input.action === "search") {
        if (!input.query?.trim()) throw new Error("query is required for search");
        const output = await runGam(config, mailbox, [
          "print",
          "messages",
          "query",
          input.query.trim(),
          "maxtoshow",
          String(input.maxResults ?? 10),
        ]);
        return jsonResult({ mailbox, output });
      }
      if (input.action === "read") {
        if (!input.messageId) throw new Error("messageId is required for read");
        const output = await runGam(config, mailbox, [
          "show",
          "messages",
          "ids",
          input.messageId,
          "showbody",
          "showattachments",
        ]);
        return jsonResult({ mailbox, output });
      }
      if (!input.to?.length || !input.subject || input.body === undefined) {
        throw new Error("to, subject, and body are required for draft/send");
      }
      if (input.action === "send" && input.confirmSend !== true) {
        throw new Error(
          "confirmSend=true is required after the requester explicitly approves sending",
        );
      }
      const args = mailArgs(
        input as Required<Pick<typeof input, "to" | "subject" | "body">> & typeof input,
      );
      const output =
        input.action === "draft"
          ? await runGam(config, mailbox, [
              "draft",
              "message",
              "textmessage",
              input.body,
              "to",
              input.to.join(","),
              "subject",
              input.subject,
              ...(input.cc?.length ? ["cc", input.cc.join(",")] : []),
              ...(input.bcc?.length ? ["bcc", input.bcc.join(",")] : []),
            ])
          : await runGam(config, mailbox, ["sendemail", ...args]);
      return jsonResult({ mailbox, action: input.action, output });
    },
  };
}

const DataRoomSchema = Type.Object(
  {
    action: stringEnum(["request", "upload_gmail_attachment"] as const),
    method: Type.Optional(stringEnum(["GET", "POST", "PATCH", "DELETE"] as const)),
    path: Type.Optional(Type.String({ maxLength: 2_000 })),
    jsonBody: Type.Optional(Type.Unknown()),
    roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    messageId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_-]+$" })),
    attachmentName: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    acknowledgeRestricted: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

function safeDataRoomPath(orgSlug: string, requested: string | undefined): string {
  const suffix = (requested ?? "").trim();
  if (!suffix || /(?:\.\.|%2e)/i.test(suffix) || !suffix.startsWith("/")) {
    throw new Error("path must be a data-room path beginning with /");
  }
  const prefix = `/api/${orgSlug}/datarooms`;
  const full = suffix.startsWith(prefix) ? suffix : `${prefix}${suffix}`;
  if (full !== prefix && !full.startsWith(`${prefix}/`) && !full.startsWith(`${prefix}?`)) {
    throw new Error("Only Fi data-room APIs are available");
  }
  return full;
}

async function delegatedFetch(
  config: Required<PluginConfig>,
  delegation: Delegation,
  pathname: string,
  init: RequestInit = {},
) {
  return fetch(`${config.baseUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${delegation.fi.token}`, ...init.headers },
  });
}

async function downloadedFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function createDataRoomTool(
  api: OpenClawPluginApi,
  context: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "fi_user_dataroom",
    label: "My Fi Data Rooms",
    description:
      "Operate only Fi data rooms the current verified requester may access. Existing Fi app and room grants authorize every request. Can upload an attachment directly from the requester's own Gmail without exposing another mailbox.",
    parameters: DataRoomSchema,
    async execute(_toolCallId, raw) {
      const input = raw as {
        action: "request" | "upload_gmail_attachment";
        method?: "GET" | "POST" | "PATCH" | "DELETE";
        path?: string;
        jsonBody?: unknown;
        roomId?: string;
        messageId?: string;
        attachmentName?: string;
        displayName?: string;
        acknowledgeRestricted?: boolean;
      };
      const { delegation, config } = await exchange(api, context);

      if (input.action === "request") {
        const method = input.method ?? "GET";
        const pathname = safeDataRoomPath(delegation.user.orgSlug, input.path);
        const response = await delegatedFetch(config, delegation, pathname, {
          method,
          ...(input.jsonBody === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input.jsonBody),
              }),
        });
        const contentType = response.headers.get("content-type") ?? "";
        const result = contentType.includes("application/json")
          ? await response.json()
          : await response.text();
        if (!response.ok)
          throw new Error(`Fi data-room request failed (${response.status}): ${String(result)}`);
        return jsonResult({ status: response.status, result });
      }

      if (!input.roomId || !input.messageId) {
        throw new Error("roomId and messageId are required for attachment upload");
      }
      const mailbox = requireMailbox(delegation);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fi-user-mail-"));
      try {
        await runGam(config, mailbox, [
          "show",
          "messages",
          "ids",
          input.messageId,
          "saveattachments",
          "targetfolder",
          tempDir,
        ]);
        const files = await downloadedFiles(tempDir);
        const selected = input.attachmentName
          ? files.find(
              (file) => path.basename(file).toLowerCase() === input.attachmentName?.toLowerCase(),
            )
          : files.length === 1
            ? files[0]
            : undefined;
        if (!selected) {
          throw new Error(
            input.attachmentName
              ? `Attachment not found: ${input.attachmentName}`
              : `Expected one attachment but found ${files.length}; provide attachmentName`,
          );
        }
        const bytes = await fs.readFile(selected);
        const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const form = new FormData();
        form.set("file", new Blob([body]), path.basename(selected));
        if (input.displayName) form.set("displayName", input.displayName);
        if (input.acknowledgeRestricted) form.set("acknowledgeRestricted", "true");
        const pathname = `/api/${delegation.user.orgSlug}/datarooms/${encodeURIComponent(input.roomId)}/documents/upload`;
        const response = await delegatedFetch(config, delegation, pathname, {
          method: "POST",
          body: form,
        });
        const responseText = await response.text();
        let result: unknown;
        try {
          result = JSON.parse(responseText);
        } catch {
          result = { error: responseText };
        }
        if (!response.ok)
          throw new Error(
            `Fi data-room upload failed (${response.status}): ${JSON.stringify(result)}`,
          );
        return jsonResult({ mailbox, attachment: path.basename(selected), result });
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export default definePluginEntry({
  id: "fi-user",
  name: "Fi User Delegation",
  description: "Requester-bound Gmail and Fi data-room operations",
  register(api) {
    api.registerTool((context: OpenClawPluginToolContext) => {
      if (
        context.agentId !== "cellect-fi-user" ||
        context.messageChannel !== "slack" ||
        !context.requesterSenderId?.trim()
      ) {
        return null;
      }
      return [createGmailTool(api, context), createDataRoomTool(api, context)];
    });
  },
});
