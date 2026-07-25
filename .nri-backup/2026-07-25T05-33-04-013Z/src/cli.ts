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

  // If the last queued message was cleared with backspace, pressing Enter
  // deletes it when no replacement text is provided. If the user typed a
  // replacement, submit that text instead of discarding it.
  if (state.queue.length > 0 && state.queue[state.queue.length - 1] === "") {
    if (text) {
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

  state.queue.push(text);
  await runPipeline();
  rl.prompt();
});

rl.prompt();

// deploy.sh
#!/usr/bin/env bash
set -euo pipefail

# Stage, commit, and push all implemented changes to the remote repository.
git add -A
if ! git diff --cached --quiet; then
  git commit -m 'feat: queued message deletion and meaningless response short-circuit'
  git push
fi
