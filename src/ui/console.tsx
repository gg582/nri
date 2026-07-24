import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
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

/** Terminal-cell width of a char (CJK/wide = 2, else 1) — enough for wrapping. */
function cellWidth(ch: string): number {
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch)
    ? 2
    : 1;
}

/** Wrap a log line into terminal-width rows (plain text; color applied at render). */
function wrapLine(line: string, width: number): string[] {
  if (line === "") return [""];
  const rows: string[] = [];
  let row = "";
  let w = 0;
  for (const ch of line) {
    const cw = cellWidth(ch);
    if (w + cw > width) {
      rows.push(row);
      row = "";
      w = 0;
    }
    row += ch;
    w += cw;
  }
  rows.push(row);
  return rows;
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

function StatusLine({ busy, below }: { busy: boolean; below: number }) {
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
        {below > 0 ? <Text color={theme.value}> │ ↑ {below} below — PgDn follow · ^↓ bottom</Text> : null}
      </Text>
    </Box>
  );
}

export function Console({ initialRequest }: { initialRequest?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const header = useMemo(() => {
    const head = makeProviderResolver({})("triage");
    return { provider: head.name, model: head.model };
  }, []);
  const [lines, setLines] = useState<string[]>([
    "nri interactive console — /help for commands, /exit to quit.",
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** First visible row index; null = pinned to the bottom (follow new output). */
  const [anchor, setAnchor] = useState<number | null>(null);

  const width = Math.min(stdout?.columns ?? 80, 100);
  // chrome: header 3 + status 2 + input 3 + slack 1
  const viewRows = Math.max(3, (stdout?.rows ?? 24) - 9);

  // Flatten to terminal-width rows, keeping the source line for coloring.
  const rows = useMemo(
    () => lines.flatMap((line) => wrapLine(line, width).map((text) => ({ text, line }))),
    [lines, width],
  );
  const maxAnchor = Math.max(0, rows.length - viewRows);
  const first = anchor === null ? maxAnchor : Math.min(anchor, maxAnchor);
  const visible = rows.slice(first, first + viewRows);
  const below = Math.max(0, rows.length - (first + viewRows));

  // In-app scrolling: ↑/↓ line-wise, PgUp/PgDn page-wise, ^↑ top, ^↓ bottom.
  // Scrolling all the way back down re-pins the view to the bottom.
  useInput((_input, key) => {
    if (key.ctrl && key.upArrow) {
      setAnchor(0);
    } else if (key.ctrl && key.downArrow) {
      setAnchor(null);
    } else if (key.pageUp || key.upArrow) {
      const delta = key.pageUp ? viewRows : 1;
      setAnchor((a) => Math.max(0, (a ?? maxAnchor) - delta));
    } else if (key.pageDown || key.downArrow) {
      const delta = key.pageDown ? viewRows : 1;
      setAnchor((a) => {
        const next = (a ?? maxAnchor) + delta;
        return next >= maxAnchor ? null : next;
      });
    }
  });

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
    // A new submission re-pins the view so its output is always visible.
    setAnchor(null);
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
      {/* scrollback viewport: fixed-height window over wrapped rows */}
      <Box flexDirection="column" height={viewRows}>
        {visible.map((row, i) => (
          <Text key={first + i} color={lineColor(row.line)} wrap="truncate">
            {row.text}
          </Text>
        ))}
      </Box>
      <StatusLine busy={busy} below={below} />
      {/* input: kimi-code style rounded card */}
      <Box borderStyle="round" borderColor={busy ? theme.dim : theme.control} paddingX={1}>
        <Text color={theme.prompt}>{busy ? "… " : "❯ "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={(v) => void onSubmit(v)} />
      </Box>
    </Box>
  );
}
