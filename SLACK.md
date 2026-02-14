# Slack Large-File Incident Notes

## Problem

OpenClaw could stop responding to Slack messages that included large uploaded files.

Observed behavior:

- Plain text messages responded normally.
- Large-file messages often arrived through `file_shared` and/or `app_mention`.
- Message handling could stall before any reply was sent.

## What We Found

1. Event-path asymmetry:
   - Large uploads can rely on `file_shared` fallback events.
   - Some mention flows arrived as `app_mention` and needed hydration to recover the full message with file metadata.

2. Dedup interactions:
   - Early "seen/handled" marking could prevent `file_shared` fallback from re-processing messages that first arrived as lightweight events.

3. Main bottleneck:
   - The pipeline could hang during media resolution for large Slack files (`resolveSlackMedia` path).
   - When that happened, `prepare` never completed, so dispatch never happened.

## Fixes Applied

- Added explicit `file_shared` event registration and forwarding into normal message handling.
- Hydrated `app_mention` events from Slack history so file metadata is available in mention flows.
- Adjusted dedup flow so `file_shared` fallback can still process when appropriate.
- Added targeted diagnostics (`src/slack/monitor/diag.ts`) and instrumentation across Slack monitor/handler stages.
- Added a large-file fallback in message preparation:
  - If a file is larger than `mediaMaxBytes`, skip media download.
  - Build message body with a file reference placeholder.
  - Include Slack permalink when available.
  - Continue normal dispatch so the bot always replies.

## Current Behavior (Expected)

- Large-file messages should no longer block reply generation.
- OpenClaw may not ingest large file contents, but it responds using the text plus file reference/link.
- Standard-size files continue through normal media handling.

## Operational Notes

- Diagnostics currently write to `/tmp/diag.log` in the gateway container.
- Useful checkpoints:
  - `diag prepare media resolved`
  - `diag prepare success`
  - `diag dispatch reply delivered`
