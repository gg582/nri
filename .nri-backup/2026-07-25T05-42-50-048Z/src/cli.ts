import * as readline from "node:readline";
import {
  state,
  clearLastQueuedMessage,
  deleteLastQueuedMessageIfEmpty,
} from "./state";
import { runPipeline } from "./graph/nodes";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on("keypress", (_str, key: any) => {
  if (key.ctrl && key.name === "c") {
    process.exit(0);
  }
  if (key.name === "backspace") {
    clearLastQueuedMessage();
  }
});

function isMeaninglessResponse(text: string): boolean {
  // Responses composed only of backslashes and/or question marks are
  // considered meaningless and should bypass the full pipeline.
  return /^[\\?]+$/.test(text);
}

rl.on("line", async (line) => {
  const text = line.trim();

  // If the last queued message was cleared with backspace, pressing Enter
  // deletes it when no replacement text is provided. If the user typed a
  // replacement, submit that text instead of discarding it.
  if (state.queue.length > 0 && state.queue[state.queue.length - 1] === "") {
    if (text) {
      if (isMeaninglessResponse(text)) {
        rl.prompt();
        return;
      }
      state.queue[state.queue.length - 1] = text;
      await runPipeline();
    } else {
      deleteLastQueuedMessageIfEmpty();
    }
    rl.prompt();
    return;
  }

  if (!text) {
    rl.prompt();
    return;
  }

  if (isMeaninglessResponse(text)) {
    rl.prompt();
    return;
  }

  state.queue.push(text);
  await runPipeline();
  rl.prompt();
});

rl.prompt();
