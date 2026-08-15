import { describe, expect, it } from "vitest";
import { parseSlackThreadPermalink } from "./thread.js";

describe("parseSlackThreadPermalink", () => {
  it("uses thread_ts for a reply permalink and builds the canonical session suffix", () => {
    expect(
      parseSlackThreadPermalink(
        "https://shape-equity-partners.slack.com/archives/C0BJLAWS49H/p1785766836369329?thread_ts=1785541458.788849&cid=C0BJLAWS49H",
      ),
    ).toMatchObject({
      channelId: "C0BJLAWS49H",
      threadTs: "1785541458.788849",
      sessionSuffix: ":slack:channel:c0bjlaws49h:thread:1785541458.788849",
    });
  });

  it("converts a root permalink timestamp when thread_ts is absent", () => {
    expect(
      parseSlackThreadPermalink(
        "https://shape-equity-partners.slack.com/archives/C0BJLAWS49H/p1786731202876369",
      ).threadTs,
    ).toBe("1786731202.876369");
  });

  it("rejects non-Slack permalink paths", () => {
    expect(() => parseSlackThreadPermalink("https://example.com/not-a-thread")).toThrow(
      "Expected a Slack permalink path",
    );
  });
});
