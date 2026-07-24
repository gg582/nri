import { buildGraph, resumeNri, runNri } from "../graph/builder.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { createTestRunner } from "../tools/factory.js";
import type { AgentStateType } from "../state.js";

/** Capture everything a legacy command writes to stdout into log lines. */
export async function capture(fn: () => Promise<void> | void): Promise<string[]> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as { write: unknown }).write = orig;
  }
  return chunks.join("").split("\n").filter((l) => l.length > 0);
}

export const HELP_LINES = [
  "slash commands (mirrors of the CLI subcommands):",
  "  /provider list|import [kimi-code|codex]|add [n]|remove <n>",
  "  /model list|assign|set <node|default> <provider:model>|candidates",
  "  /permission list|set-mode <plan|auto|yolo>|allow <re>|deny <re>|clear <allow|deny>",
  "  /plan <request>                 read-only plan, nothing executed",
  "  /goal set \"<obj>\" [--done-when X --budget N] | status | run | clear",
  "  /swarm [--providers a,b] [--coverage N] <request>",
  "  /compact <state.json> [--out p]  fold run context into a summary",
  "  /graph-compact <state.json>      compact, preserving graph node ids/edges",
  "  /memory list|search|ingest|stats|backend <jsonl|rag>",
  "  /help                            this text",
  "  /exit                            quit (also: /quit)",
  "",
  "plain text (no slash) runs the nri pipeline on it.",
  "after a run, detected changes are offered for apply: y = apply, n = skip.",
  "permission mode yolo applies without asking (nri permission set-mode yolo).",
  "full docs: https://github.com/gg582/nri",
];

type Wizard =
  | { kind: "provider-add"; step: number; data: { name?: string; apiKey?: string; baseURL?: string; defaultModel?: string } }
  | { kind: "model-assign"; step: number; data: { picked?: string[]; defaultSpec?: string; nodes?: Record<string, string> } };

const PROVIDER_ADD_STEPS = ["provider name", "api key (empty = env)", "base url (optional)", "default model (optional)"];

/**
 * Rendering-agnostic REPL core: shared by the ink console (TTY) and the
 * readline fallback (piped stdin). Returns false from submit() on /exit.
 */
export class Repl {
  busy = false;
  private wizard: Wizard | null = null;
  private pendingConfirm: ((ok: boolean) => void) | null = null;

  constructor(
    private readonly push: (...lines: string[]) => void,
    private readonly onExit: () => void,
  ) {}

  /** y/n prompt used by the apply gate in auto permission mode. */
  private askConfirm(question: string): Promise<boolean> {
    this.push(`${question} [y/N]`);
    return new Promise((resolve) => {
      this.pendingConfirm = resolve;
    });
  }

  private async runRequest(request: string): Promise<void> {
    const graph = buildGraph({ resolveProvider: makeProviderResolver({}), testRunner: createTestRunner() });
    const threadId = `nri-tui-${Date.now()}`;
    const config = { configurable: { thread_id: threadId } };
    let run = await runNri(graph, { request, targetTestCoverage: 80, threadId });
    for (let i = 0; i < 10 && run.awaitingApproval; i++) {
      this.push("  [hitl] proposal graph auto-approved");
      await resumeNri(graph, null, threadId);
      const snap = await graph.getState(config);
      run = { finalState: snap.values as AgentStateType, awaitingApproval: snap.next.includes("human_approval") };
    }
    const s = run.finalState;
    this.push(...s.trace.map((l) => `  ${l}`));
    if (s.finalOutput) this.push("", s.finalOutput);
    this.push(`done: coverage ${s.currentTestCoverage}%/${s.targetTestCoverage}% (${s.selectedPath})`);
    const { saveRun } = await import("../store/memory.js");
    await saveRun({
      request,
      path: s.selectedPath,
      coverage: s.currentTestCoverage,
      target: s.targetTestCoverage,
      iterations: s.iterationCount,
      summary: s.compactSummary,
    });
    if (s.generatedCode) {
      const { offerApply } = await import("../tools/apply.js");
      this.push(...(await offerApply(s.generatedCode, (q) => this.askConfirm(q), { provider: makeProviderResolver({})("evaluate") })));
    }
  }

  private async dispatchSlash(text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case "help":
        this.push(...HELP_LINES);
        return;
      case "exit":
      case "quit":
        this.onExit();
        return;
      case "provider": {
        if (rest[0] === "add") {
          this.wizard = { kind: "provider-add", step: rest[1] ? 1 : 0, data: { name: rest[1] } };
          this.push(`provider add — ${PROVIDER_ADD_STEPS[rest[1] ? 1 : 0]}:`);
          return;
        }
        const { providerCommand } = await import("../commands/provider.js");
        this.push(...(await capture(() => providerCommand(rest))));
        return;
      }
      case "model": {
        if (rest[0] === "assign") {
          const { getCandidates } = await import("../commands/model.js");
          const all = getCandidates();
          this.push("available models:", ...all.map((c, i) => `  ${i + 1}. ${c.spec}  [${c.tier}]`), "selection (e.g. 1,3,4):");
          this.wizard = { kind: "model-assign", step: 0, data: {} };
          return;
        }
        const { modelCommand } = await import("../commands/model.js");
        this.push(...(await capture(() => modelCommand(rest))));
        return;
      }
      case "permission": {
        const { permissionCommand } = await import("../commands/permission.js");
        this.push(...(await capture(() => permissionCommand(rest))));
        return;
      }
      case "plan": {
        const { planCommand } = await import("../commands/plan.js");
        this.push(...(await capture(() => planCommand(rest))));
        return;
      }
      case "goal": {
        const { goalCommand } = await import("../commands/goal.js");
        this.push(...(await capture(() => goalCommand(rest))));
        return;
      }
      case "swarm": {
        const { swarmCommand } = await import("../commands/swarm.js");
        this.push(...(await capture(() => swarmCommand(rest))));
        return;
      }
      case "compact":
      case "graph-compact": {
        const { compactCommand } = await import("../commands/compact.js");
        this.push(...(await capture(() => compactCommand(rest, cmd === "graph-compact"))));
        return;
      }
      case "memory": {
        const { memoryCommand } = await import("../commands/memory.js");
        this.push(...(await capture(() => memoryCommand(rest))));
        return;
      }
      default:
        this.push(`unknown command /${cmd} — /help`);
    }
  }

  private async handleWizard(text: string, w: Wizard): Promise<void> {
    if (w.kind === "provider-add") {
      const data = { ...w.data };
      const value = text.trim();
      if (w.step === 0) data.name = value;
      else if (w.step === 1) data.apiKey = value || undefined;
      else if (w.step === 2) data.baseURL = value || undefined;
      else if (w.step === 3) data.defaultModel = value || undefined;
      if (w.step < 3) {
        this.wizard = { kind: "provider-add", step: w.step + 1, data };
        this.push(`${PROVIDER_ADD_STEPS[w.step + 1]}:`);
        return;
      }
      const { providerAdd } = await import("../commands/provider.js");
      this.push(...(await capture(() => providerAdd(data.name, data))));
      this.wizard = null;
      return;
    }
    // model-assign
    if (w.step === 0) {
      const { getCandidates, assignByCapability } = await import("../commands/model.js");
      const all = getCandidates();
      const picked = [...new Set(text.split(/[\s,]+/).filter(Boolean).map((s) => Number(s) - 1))]
        .map((i) => all[i]?.spec)
        .filter(Boolean) as string[];
      if (picked.length === 0) {
        this.push("nothing selected — cancelled.");
        this.wizard = null;
        return;
      }
      const candidates = picked.map((spec) => all.find((c) => c.spec === spec)!);
      const nodes = assignByCapability(candidates);
      const defaultSpec = candidates.find((c) => c.tier === "strong")?.spec ?? picked[0];
      this.push(
        "proposed routing:",
        `  default -> ${defaultSpec}`,
        ...Object.entries(nodes).map(([n, s]) => `  ${n} -> ${s}`),
        "apply? [y/N]",
      );
      this.wizard = { kind: "model-assign", step: 1, data: { picked, defaultSpec, nodes } };
      return;
    }
    if (text.trim().toLowerCase() === "y") {
      const { applyAssignment } = await import("../commands/model.js");
      const { defaultSpec, nodes } = applyAssignment(w.data.picked!);
      this.push("saved.", `  default -> ${defaultSpec}`, ...Object.entries(nodes).map(([n, s]) => `  ${n} -> ${s}`));
    } else {
      this.push("aborted.");
    }
    this.wizard = null;
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    // A pending apply confirm takes priority (busy is true while it waits).
    if (this.pendingConfirm) {
      const resolve = this.pendingConfirm;
      this.pendingConfirm = null;
      this.push(`❯ ${trimmed}`);
      resolve(trimmed.toLowerCase() === "y");
      return;
    }
    // Empty input is meaningful while a wizard runs (it means "skip this field").
    if (!trimmed && !this.wizard) return;
    this.push(`❯ ${trimmed}`);
    if (this.busy) {
      this.push("…busy, wait for the current task.");
      return;
    }
    this.busy = true;
    try {
      if (this.wizard) await this.handleWizard(trimmed, this.wizard);
      else if (trimmed.startsWith("/")) await this.dispatchSlash(trimmed);
      else await this.runRequest(trimmed);
    } catch (err) {
      this.push(`error: ${err instanceof Error ? err.message : String(err)}`);
      this.wizard = null;
    } finally {
      this.busy = false;
    }
  }
}

/** Readline fallback for non-TTY stdin (pipes, CI): same REPL, no ink. */
export async function runReadlineRepl(initialRequest?: string): Promise<void> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const repl = new Repl(
    (...lines) => {
      for (const l of lines) process.stdout.write(`${l}\n`);
    },
    () => rl.close(),
  );
  process.stdout.write("nri interactive console (readline mode) — /help, /exit.\n");
  if (initialRequest) await repl.submit(initialRequest);
  for await (const line of rl) {
    await repl.submit(line);
    if (repl.busy === false && line.trim().match(/^\/(exit|quit)$/)) break;
  }
}
