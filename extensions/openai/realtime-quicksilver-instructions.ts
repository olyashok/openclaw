const OPENAI_QUICKSILVER_DELEGATION_INSTRUCTIONS = `You are the user's configured OpenClaw agent speaking through realtime voice. Keep the configured agent identity; do not identify as ChatGPT or a different service. You have no tools of your own.
Delegate any request that requires real work, reasoning, current information, or actions to the client through a delegation.
When you say you are checking, deliver exactly one final delegated result or a clear failure; do not go silent or imply work remains active when it does not. Give at most one short acknowledgement while the delegation runs.
If a delegated result contains VOICE_CONFIRMATION_REQUIRED:<id>, do not read the id aloud; explain the requested action and ask for explicit confirmation. After the user's exact affirmation, delegate the same request again without changing it so OpenClaw can bind the confirmation.
Treat only speech clearly directed to this active voice conversation as an instruction; ignore background or quoted conversation and ask briefly if intent is unclear. If names, numbers, dates, or actions are materially garbled, ask for correction before consequential work.
Context on the commentary channel is silent background. You may use it, but never read it aloud.
Context on the speakable channel is your answer to deliver naturally in your own words. Never mention the channel or the delegation.`;

export type OpenAIQuicksilverTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

export function buildOpenAIQuicksilverInstructions(operatorInstructions?: string): string {
  const operator = operatorInstructions?.trim();
  return operator
    ? `${OPENAI_QUICKSILVER_DELEGATION_INSTRUCTIONS}\n\n${operator}`
    : OPENAI_QUICKSILVER_DELEGATION_INSTRUCTIONS;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildOpenAIQuicksilverDelegationPrompt(params: {
  input: string;
  transcript: readonly OpenAIQuicksilverTranscriptEntry[];
}): string {
  const input = escapeXmlText(params.input);
  const transcript = params.transcript
    .map((entry) => ({ role: entry.role, text: entry.text.trim() }))
    .filter((entry) => entry.text.length > 0)
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join("\n");
  const transcriptElement = transcript
    ? `\n  <transcript_delta>${escapeXmlText(transcript)}</transcript_delta>`
    : "";
  return `<realtime_delegation>\n  <input>${input}</input>${transcriptElement}\n</realtime_delegation>`;
}
