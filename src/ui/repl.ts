import { buildGraph } from "../graph/builder.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { createTestRunner } from "../tools/factory.js";
import type { AgentStateType } from "../state.js";
import { loadConfig } from "../config.js";
import { cleanupVisualTemps } from "../tools/visual.js";
import { compressConversation } from "../context/conversation.js";

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
  "  /provider list|import [kimi-code|codex|antigravity]|add [n]|remove <n>|refresh [n]",
  "  /model list|assign|set <node|default> <provider:model> [more...]|reorder [node]|candidates",
  "  /permission list|set-mode <plan|auto|yolo>|allow <re>|deny <re>|clear <allow|deny>",
  "  /yolo [off]                       toggle yolo mode (gates off, advisory only)",
  "  /thinking show|hide               toggle pipeline reasoning output",
  "  /plan <request>                 read-only plan, nothing executed",
  "  /goal set \"<obj>\" [--done-when X --budget N] | status | run | clear",
  "  /swarm [--providers a,b] [--coverage N] <request>",
  "  /compact <state.json> [--out p]  fold run context into a summary",
  "  /graph-compact <state.json>      compact, preserving graph node ids/edges",
  "  /memory list|search|ingest|stats|backend <jsonl|rag>",
  "  /help                            this text",
  "  /exit                            quit (also: /quit)",
  "keys: ↑/↓·PgUp/PgDn scroll log · ^↑/^↓ top/bottom · ←/→ browse prompt history (Enter re-submits)",
  "",
  "plain text (no slash) runs the nri pipeline on it.",
  "after a run, detected changes are offered for apply: y = apply, n = skip.",
  "permission mode yolo applies without asking (nri permission set-mode yolo).",
  "full docs: https://github.com/gg582/nri",
];

type Wizard =
  | { kind: "provider-add"; step: number; data: { name?: string; apiKey?: string; baseURL?: string; defaultModel?: string } }
  | { kind: "model-assign"; step: number; data: { picked?: string[]; nodes?: Record<string, string[]> } }
  | { kind: "model-reorder"; step: number; data: { target?: string; specs?: string[] } };

const PROVIDER_ADD_STEPS = ["provider name", "api key (empty = env)", "base url (optional)", "default model (optional)"];

/**
 * Rendering-agnostic REPL core: shared by the ink console (TTY) and the
 * readline fallback (piped stdin).
 *
 * Input model: wizard steps and slash commands run immediately, even while
 * a pipeline request is in flight; plain-text requests are queued FIFO and
 * drained by pump(). No "busy, wait" rejection — input is never refused.
 */
export class Repl {
  busy = false;
  private wizard: Wizard | null = null;
  private pendingConfirm: ((ok: boolean) => void) | null = null;
  private readonly queue: string[] = [];
  private pumping = false;
  /** Submitted pipeline prompts, newest first (for ←/→ history browsing). */
  private readonly promptHistory: string[] = [];
  /** Completed turns, kept separately from prompt history so queued future
   * requests can never leak into the model's context. */
  private readonly conversationTurns: Array<{ request: string; outcome: string }> = [];

  constructor(
    private readonly push: (...lines: string[]) => void,
    private readonly onExit: () => void,
    private readonly onBusyChange?: (busy: boolean) => void,
  ) {}

  get history(): readonly string[] {
    return this.promptHistory;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.onBusyChange?.(busy);
  }

  /** Drain queued pipeline requests one at a time. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    this.setBusy(true);
    try {
      while (this.queue.length > 0) {
        const req = this.queue.shift()!;
        try {
          await this.runRequest(req);
        } catch (err) {
          this.push(`error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.pumping = false;
      this.setBusy(false);
    }
  }

  /** y/n prompt used by the apply gate in auto permission mode. */
  private askConfirm(question: string): Promise<boolean> {
    this.push(`${question} [y/N]`);
    return new Promise((resolve) => {
      this.pendingConfirm = resolve;
    });
  }

  /**
   * Carry the immediately relevant part of this REPL conversation into a new
   * graph invocation. A graph is intentionally recreated per request for
   * independent streaming/HITL lifecycles, so its in-memory checkpointer alone
   * cannot preserve these turns.
   */
  private conversationContext(): string {
    return compressConversation(this.conversationTurns);
  }

  private async runRequest(request: string): Promise<void> {
    const resolver = makeProviderResolver(
      {},
      { onFallback: (m) => this.push(`  [warn] ${m}`) },
    );
    // /thinking hide: suppress reasoning lines; results/warnings still show.
    const thinking = loadConfig().ui?.thinking ?? true;
    // Liveness: node-start lines + a heartbeat while a node runs long, so a
    // slow LLM call never looks like a hang.
    let runningNode: string | null = null;
    let runningSince = 0;
    const graph = buildGraph(
      { resolveProvider: resolver, testRunner: createTestRunner() },
      {
        hooks: {
          onNodeStart: (node) => {
            runningNode = node;
            runningSince = Date.now();
            if (!thinking) return;
            const p = resolver(node);
            this.push(`▶ ${node} (${p.name}/${p.model})`);
          },
          onNodeEnd: (node) => {
            if (runningNode === node) runningNode = null;
          },
          // Live apply lines from streamed file writes — shown even with
          // /thinking hide since they are results, not reasoning.
          onTrace: (_node, line) => this.push(line),
        },
      },
    );
    const heartbeat = setInterval(() => {
      if (thinking && runningNode) {
        this.push(`  …${runningNode} running ${Math.round((Date.now() - runningSince) / 1000)}s`);
      }
    }, 15_000);
    const threadId = `nri-tui-${Date.now()}`;
    const config = { configurable: { thread_id: threadId } };

    try {
      // Stream node-level updates so the pipeline's reasoning is visible live
      // as it scrolls by, instead of one black-box dump when the run ends.
      const drive = async (input: Record<string, unknown> | null): Promise<void> => {
        const stream = await graph.stream(input as never, { ...config, streamMode: "updates" });
        for await (const chunk of stream) {
          for (const [node, update] of Object.entries(chunk)) {
            if (!thinking) continue;
            const u = update as Partial<AgentStateType> | undefined;
            const lines = Array.isArray(u?.trace) ? u.trace : [];
            if (lines.length > 0) this.push(...lines.map((l) => `  ${l}`));
            else this.push(`  [${node}]`);
          }
        }
      };

      await drive({
        rawRequest: request,
        conversationContext: this.conversationContext(),
        outputLocale: "en-US",
        targetTestCoverage: 80,
        maxIterations: 5,
      });

      // HITL loop: the heavy path pauses at human_approval; auto-approve here.
      for (let i = 0; i < 10; i++) {
        const snap = await graph.getState(config);
        if (!snap.next.includes("human_approval")) break;
        if (thinking) this.push("  [hitl] proposal graph auto-approved");
        await drive(null);
      }
    } finally {
      clearInterval(heartbeat);
    }

    const s = (await graph.getState(config)).values as AgentStateType;
    if (s.finalOutput) {
      this.push("", s.finalOutput);
    } else {
      // The graph can end before finalize (pre-flight attempts exhausted) —
      // say so plainly instead of printing a bare "done" line.
      const reason =
        s.preFlight && !s.preFlight.is_business_valid
          ? `pre-flight rejected the plan after ${s.preFlightAttempts} attempt(s) — ` +
            (s.preFlight.violation_reason ?? "no reason given")
          : s.iterationCount >= s.maxIterations
            ? `iteration limit reached (${s.iterationCount}/${s.maxIterations})`
            : "pipeline ended before finalize";
      this.push(`run ended without completing: ${reason}`);
    }
    this.push(
      "",
      `✔ pipeline finished (${s.selectedPath}): coverage ${s.currentTestCoverage}%/${s.targetTestCoverage}%`,
    );
    const { saveRun } = await import("../store/memory.js");
    await saveRun({
      request,
      path: s.selectedPath,
      coverage: s.currentTestCoverage,
      target: s.targetTestCoverage,
      iterations: s.iterationCount,
      summary: s.compactSummary,
    });
    this.conversationTurns.push({
      request,
      outcome: s.finalOutput ?? s.compactSummary ?? `path=${s.selectedPath}; coverage=${s.currentTestCoverage}%`,
    });
    if (s.generatedCode) {
      const { offerApply, planApply } = await import("../tools/apply.js");
      const plan = planApply(s.generatedCode);
      const already = new Set(s.appliedFiles ?? []);
      const pending = plan.changes.filter((c) => !already.has(c.path));
      if (plan.changes.length > 0 && pending.length === 0) {
        const fileList = plan.changes.map((c) => `  - ${c.path}`).join("\n");
        this.push(`files written to workspace (${plan.changes.length}):\n${fileList}`);
      } else {
        this.push(...(await offerApply(s.generatedCode, (q) => this.askConfirm(q), { provider: makeProviderResolver({})("evaluate") })));
      }
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
        if (rest[0] === "reorder" || rest[0] === "order") {
          const { modelOrder } = await import("../commands/model.js");
          const target = rest[1] ?? "default";
          const specs = modelOrder(target);
          if (specs.length === 0) {
            this.push(`no pool configured for "${target}" — use /model set or /model assign first.`);
            return;
          }
          this.push(
            `current fallback order for ${target}:`,
            ...specs.map((s, i) => `  ${i + 1}. ${s}`),
            "new order (e.g. 2 1 3):",
          );
          this.wizard = { kind: "model-reorder", step: 0, data: { target, specs } };
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
      case "yolo": {
        const off = rest[0] === "off";
        const { permissionCommand } = await import("../commands/permission.js");
        this.push(...(await capture(() => permissionCommand(["set-mode", off ? "auto" : "yolo"]))));
        if (!off)
          this.push("yolo: permission gates off — deny-listed/destructive commands run with advisory only. `/yolo off` reverts.");
        return;
      }
      case "thinking": {
        const { thinkingCommand } = await import("../commands/thinking.js");
        this.push(...(await capture(() => thinkingCommand(rest))));
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
    // model-reorder
    if (w.kind === "model-reorder") {
      const { parsePermutation, modelReorderSave } = await import("../commands/model.js");
      const next = parsePermutation(text, w.data.specs!);
      if (!next) {
        this.push("invalid permutation — cancelled.");
      } else {
        this.push(...(await capture(() => Promise.resolve(modelReorderSave(w.data.target ?? "default", next)))));
      }
      this.wizard = null;
      return;
    }
    // model-assign
    if (w.step === 0) {
      const { getCandidates, assignByCapability, formatSpec } = await import("../commands/model.js");
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
      this.push(
        "proposed routing (→ = trial order, fallback on failure):",
        ...Object.entries(nodes).map(([n, s]) => `  ${n} -> ${formatSpec(s)}`),
        "apply? [y/N]",
      );
      this.wizard = { kind: "model-assign", step: 1, data: { picked, nodes } };
      return;
    }
    if (text.trim().toLowerCase() === "y") {
      const { applyAssignment, formatSpec } = await import("../commands/model.js");
      const { defaultSpec, nodes } = applyAssignment(w.data.picked!);
      this.push("saved.", `  default -> ${formatSpec(defaultSpec)}`, ...Object.entries(nodes).map(([n, s]) => `  ${n} -> ${formatSpec(s)}`));
    } else {
      this.push("aborted.");
    }
    this.wizard = null;
  }

  async submit(text: string): Promise<void> {
    const trimmed = text.trim();
    // A pending apply confirm takes priority (a run waits on it).
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
    // Wizard steps and slash commands run immediately, even mid-run.
    if (this.wizard) {
      try {
        await this.handleWizard(trimmed, this.wizard);
      } catch (err) {
        this.push(`error: ${err instanceof Error ? err.message : String(err)}`);
        this.wizard = null;
      }
      return;
    }
    if (trimmed.startsWith("/")) {
      try {
        await this.dispatchSlash(trimmed);
      } catch (err) {
        this.push(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    // Pipeline requests queue up and run one after another.
    if (this.promptHistory[0] !== trimmed) this.promptHistory.unshift(trimmed);
    this.queue.push(trimmed);
    if (this.pumping) this.push(`queued (#${this.queue.length})`);
    void this.pump();
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
    if (repl.busy === false && line.trim().match(/^\/(exit|quit)$/)) {
      await cleanupVisualTemps();
      break;
    }
  }
}
