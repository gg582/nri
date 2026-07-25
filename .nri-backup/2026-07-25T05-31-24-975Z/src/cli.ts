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

rl.on("line", async (line) => {
  const text = line.trim();

  // If the queued message was cleared with backspace, pressing enter deletes it.
  if (state.queue.length > 0 && state.queue[state.queue.length - 1] === "") {
    deleteLastQueuedMessageIfEmpty();
    rl.prompt();
    return;
  }

  if (!text) {
    rl.prompt();
    return;
  }

  state.queue.push(text);
  await runPipeline();
  rl.prompt();
});

rl.prompt();
