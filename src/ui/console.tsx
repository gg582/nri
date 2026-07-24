import React, { useMemo, useState } from "react";
import { Box, Static, Text, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Repl } from "./repl.js";
import { theme } from "./theme.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { loadConfig } from "../config.js";

/**
 * Console design language:
 * - kimi-code: rounded panels (input box, wizard/help cards).
 * - claude-code: clean straight chrome — one hairline divider, no boxes
 *   around the scrollback, left-aligned minimal status line.
 * - every color comes from nri's semantic theme mapping (seoulism).
 */

/** Classify a log line onto the semantic color mapping — strictly. */
export function lineColor(line: string): string {
  if (line.startsWith("❯")) return theme.prompt; // user input echo — Question
  if (line.startsWith("error") || line.includes("[warn]")) return theme.error; // Error
  if (/^\s*\[[a-z-]+\]/.test(line)) return theme.trace; // pipeline trace — Comment (receded)
  if (/done|saved|imported|met\b|✔/.test(line)) return theme.success; // GitAdd
  if (/coverage|->|→|default:/.test(line)) return theme.value; // String/Number
  if (/primal|proposal|node|abstract/.test(line)) return theme.structure; // Type
  if (line.startsWith("nri interactive")) return theme.info; // Constant
  return theme.text;
}

function Header({ provider, model }: { provider: string; model: string }) {
  return (
    <Box borderStyle="round" borderColor={theme.control} paddingX={1} gap={1}>
      <Text bold color={theme.control}>
        nri
      </Text>
      <Text color={theme.dim}>│</Text>
      <Text color={theme.info}>
        {provider}/{model}
      </Text>
    </Box>
  );
}

function StatusLine({ busy }: { busy: boolean }) {
  const { stdout } = useStdout();
  const width = Math.min(stdout?.columns ?? 80, 100);
  const mode = loadConfig().permissions?.mode ?? "auto";
  return (
    <Box flexDirection="column">
      <Text color={theme.dim} wrap="truncate">
        {"─".repeat(width)}
      </Text>
      <Text>
        <Text color={busy ? theme.value : theme.accent}>{busy ? "● running" : "○ ready"}</Text>
        <Text color={theme.dim}> │ mode </Text>
        <Text color={theme.value}>{mode}</Text>
        <Text color={theme.dim}> │ /help · /exit</Text>
      </Text>
    </Box>
  );
}

export function Console({ initialRequest }: { initialRequest?: string }) {
  const { exit } = useApp();
  const header = useMemo(() => {
    const head = makeProviderResolver({})("triage");
    return { provider: head.name, model: head.model };
  }, []);
  const [lines, setLines] = useState<string[]>([
    "nri interactive console — /help for commands, /exit to quit.",
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const repl = useMemo(
    () =>
      new Repl(
        (...newLines) => setLines((prev) => [...prev, ...newLines]),
        () => exit(),
      ),
    [exit],
  );

  async function onSubmit(text: string): Promise<void> {
    setInput("");
    setBusy(true);
    try {
      await repl.submit(text);
    } finally {
      setBusy(false);
    }
  }

  // An initial request (e.g. `nri "fix the bug"` without --cli) is submitted
  // once on mount, as if the user typed it.
  const submittedInitial = useMemo(() => ({ done: false }), []);
  if (initialRequest && !submittedInitial.done) {
    submittedInitial.done = true;
    setTimeout(() => void onSubmit(initialRequest), 50);
  }

  return (
    <Box flexDirection="column">
      <Header provider={header.provider} model={header.model} />
      {/* scrollback: no box — claude-code style clean flow, colored by mapping */}
      <Static items={lines}>
        {(line, i) => (
          <Text key={i} color={lineColor(line)} wrap="wrap">
            {line}
          </Text>
        )}
      </Static>
      <StatusLine busy={busy} />
      {/* input: kimi-code style rounded card */}
      <Box borderStyle="round" borderColor={busy ? theme.dim : theme.control} paddingX={1}>
        <Text color={theme.prompt}>{busy ? "… " : "❯ "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={(v) => void onSubmit(v)} />
      </Box>
    </Box>
  );
}
