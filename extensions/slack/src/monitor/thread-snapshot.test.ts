import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import { readSlackThreadSnapshot } from "./thread-snapshot.js";

describe("Slack projection source snapshot", () => {
  function client() {
    return {
      auth: { test: vi.fn().mockResolvedValue({ ok: true, team_id: "T123" }) },
      conversations: {
        members: vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            members: ["U111"],
            response_metadata: { next_cursor: "more" },
          })
          .mockResolvedValueOnce({
            ok: true,
            members: ["U222"],
            response_metadata: { next_cursor: "" },
          }),
        replies: vi.fn().mockResolvedValue({
          ok: true,
          messages: [
            { ts: "1700000000.000001", user: "U111", text: "Question" },
            { ts: "1700000000.000002", user: "U333", text: "Answer", bot_id: "B333" },
          ],
        }),
      },
    };
  }
  it("collects all members and preserves string message identities and bot attribution", async () => {
    const slack = client();
    const result = await readSlackThreadSnapshot(
      slack as unknown as WebClient,
      "T123",
      "C123",
      "1700000000.000001",
    );
    expect(result.memberSenderIds).toEqual(["U111", "U222"]);
    expect(result.messages[1]).toEqual({
      messageId: "1700000000.000002",
      senderId: "U333",
      content: "Answer",
      bot: true,
    });
    expect(slack.conversations.members).toHaveBeenLastCalledWith({
      channel: "C123",
      limit: 200,
      cursor: "more",
    });
  });
  it("rejects a mismatched workspace before reading private channel data", async () => {
    const slack = client();
    slack.auth.test.mockResolvedValue({ ok: true, team_id: "T999" });
    await expect(
      readSlackThreadSnapshot(slack as unknown as WebClient, "T123", "C123", "1700000000.000001"),
    ).rejects.toThrow("workspace mismatch");
    expect(slack.conversations.members).not.toHaveBeenCalled();
  });
  it("never returns a partial membership snapshot when pagination fails", async () => {
    const slack = client();
    slack.conversations.members
      .mockReset()
      .mockResolvedValueOnce({
        ok: true,
        members: ["U111"],
        response_metadata: { next_cursor: "more" },
      })
      .mockRejectedValueOnce(new Error("rate_limited"));
    await expect(
      readSlackThreadSnapshot(slack as unknown as WebClient, "T123", "C123", "1700000000.000001"),
    ).rejects.toThrow("rate_limited");
    expect(slack.conversations.replies).not.toHaveBeenCalled();
  });
});
