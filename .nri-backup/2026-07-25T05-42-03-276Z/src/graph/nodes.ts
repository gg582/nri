import { state, isMeaninglessResponse } from "../state";

export async function runPipeline(): Promise<void> {
  const userText = state.queue.shift();
  if (!userText) return;

  state.messages.push({ role: "user", content: userText });

  const response = await fetchAssistantResponse(state.messages);

  // Short-circuit the full pipeline for meaningless responses.
  if (isMeaninglessResponse(response)) {
    console.log("[skipping meaningless response]");
    return;
  }

  state.messages.push({ role: "assistant", content: response });
}

async function fetchAssistantResponse(_messages: unknown[]): Promise<string> {
  // Existing provider call goes here.
  return "";
}
