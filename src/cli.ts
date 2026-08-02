#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { buildGraph, resumeNri, runNri } from "./graph/builder.js";
import { PROVIDER_NAMES } from "./providers/factory.js";
import { makeProviderResolver } from "./providers/resolver.js";
import { createTestRunner } from "./tools/factory.js";
import { loadConfig, resolveLocale } from "./config.js";
import { normalizeReverseMode } from "./graph/direction.js";
import type { ProposalGraph } from "./state.js";

interface CliArgs {
  provider?: string;
  model?: string;
  request?: string;
  coverage: number;
  maxIterations: number;
  autoApprove: boolean;
  ui: boolean;
  help: boolean;
  dumpState?: string;
  locale?: string;
  yolo: boolean;
  cli: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { coverage: 80, maxIterations: 5, autoApprove: false, ui: false, help: false, yolo: false, cli: false };
  const positional: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--provider":
      case "-p":
        args.provider = argv[++i];
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--request":
      case "-r":
        args.request = argv[++i];
        break;
      case "--coverage":
      case "-c":
        args.coverage = Number(argv[++i]);
        break;
      case "--max-iterations":
        args.maxIterations = Number(argv[++i]);
        break;
      case "--dump-state":
        args.dumpState = argv[++i];
        break;
      case "--locale":
        args.locale = argv[++i];
        break;
      case "--yes":
      case "-y":
        args.autoApprove = true;
        break;
      case "--yolo":
        args.yolo = true;
        args.autoApprove = true; // kept for compatibility with explicit breakpoints
        break;
      case "--ui":
        args.ui = true;
        break;
      case "--cli":
        args.cli = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        positional.push(a);
    }
  }
  if (!args.request && positional.length > 0) args.request = positional.join(" ");
  return args;
}

const HELP = `nri — adaptive agentic engineering harness

Usage:
  nri                               interactive console (default mode)
  nri "<task>"                      console, with the task pre-submitted
  nri --cli -r "<task>" [options]   one-shot CLI run (explicit opt-in)
  nri help                          this reference
  nri provider <list|import|login|add|remove|refresh>   manage providers (also: /provider)
  nri model <list|assign|set|reorder|candidates>  per-node model routing (also: /model)
  nri permission <list|set-mode|allow|deny|clear>   execution policy (also: /permission)
  nri yolo [off]                          toggle yolo permission mode (also: /yolo)
  nri thinking <show|hide>                toggle reasoning output (also: /thinking)
  nri reverse <on|off|auto>               graph reversal control (default: auto — static analysis flips only on overwhelming structural edge)
  nri plan "<request>"                    read-only planning run (also: /plan)
  nri goal <set|status|run|clear>         durable goal mode (also: /goal)
  nri swarm [--providers a,b] "<request>" parallel multi-provider comparison (also: /swarm)
  nri compact <state.json> [--out path]   compress run context (also: /compact)
  nri graph-compact <state.json>          compact while preserving graph refs (also: /graph-compact)
  nri memory <list|search|ingest|stats|backend>   persistent run memory (also: /memory)

Options (one-shot mode):
  -p, --provider <name>   ${PROVIDER_NAMES.join(" | ")}   (default: routing config, $NRI_PROVIDER, or openai)
  -m, --model <id>        model id override               (default: routing config or provider default)
  -r, --request <text>    the engineering task
      --cli               one-shot CLI output instead of the interactive console
  -c, --coverage <n>      target test coverage %          (default: 80)
      --max-iterations <n> loop guardrail                 (default: 5)
      --dump-state <path> write final run state JSON (for /compact, /graph-compact)
      --locale <code>     final output locale (us/en-US default, uk/gb, au, ie, ko, ja, ...)
      --yolo              apply detected changes without asking (yolo permission mode)
  -y, --yes               legacy compatibility flag (normal runs have no approval pause)
      --ui                run with the ink TUI (seoulism theme)
  -h, --help              show this help

Commands:
  nri provider list                       configured providers (* = credentials available)
  nri provider import [kimi-code|codex|antigravity]   auto-import credentials from existing AI clients
  nri provider login [antigravity] [consumer|gcp]     browser OAuth login, 1:1 agy CLI mimicry
  nri provider add [name]                 manual interactive entry
  nri provider remove <name>              remove stored credentials
  nri provider refresh [name]             fetch live model lists from provider APIs
  nri model list                          current per-node routing table
  nri model assign                        multi-select models, auto-assign per node capability
  nri model set <node|default> <provider:model> [more models...]   ordered trial pool
  nri model reorder [node|default]          edit fallback order interactively
  nri model candidates                    list selectable provider:model specs

Environment:
  NRI_TEST_MODE=mock      simulate coverage without a real test suite
  NRI_TEST_COMMAND=...    shell command used to measure real coverage
  NRI_WORKSPACE=...       directory for generated code (default: .nri-workspace)
  NRI_MCP_SERVER_COMMAND  MCP server command for coverage measurement
  NRI_MCP_SERVER_ARGS     MCP server arguments
  NRI_MCP_TOOL            MCP tool name override (default: first *coverage*|*test* tool)
  API keys per provider:  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
                          KIMI_API_KEY, DEEPSEEK_API_KEY, XAI_API_KEY
  Config: ~/.config/nri/config.json (global), nri.config.json (cwd)
`;

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

/** Launch the interactive console: ink on a TTY, readline REPL when piped. */
async function launchConsole(initialRequest?: string): Promise<void> {
  if (stdin.isTTY) {
    const [{ render }, { Console }] = await Promise.all([import("ink"), import("./ui/console.js")]);
    const React = await import("react");
    render(React.createElement(Console, { initialRequest }));
  } else {
    const { runReadlineRepl } = await import("./ui/repl.js");
    await runReadlineRepl(initialRequest);
  }
}

async function main(): Promise<void> {
  // Piping into `head` etc. closes stdout early — exit quietly instead of crashing on EPIPE.
  stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  // Subcommands: accept both "provider" and "/provider" spellings.
  const command = argv[2]?.replace(/^\//, "");
  if (command === "help") {
    stdout.write(HELP);
    return;
  }
  if (command === "provider") {
    const { providerCommand } = await import("./commands/provider.js");
    await providerCommand(argv.slice(3));
    return;
  }
  if (command === "model") {
    const { modelCommand } = await import("./commands/model.js");
    await modelCommand(argv.slice(3));
    return;
  }
  if (command === "permission") {
    const { permissionCommand } = await import("./commands/permission.js");
    await permissionCommand(argv.slice(3));
    return;
  }
  if (command === "yolo") {
    const { permissionCommand } = await import("./commands/permission.js");
    await permissionCommand(["set-mode", argv[3] === "off" ? "auto" : "yolo"]);
    return;
  }
  if (command === "thinking") {
    const { thinkingCommand } = await import("./commands/thinking.js");
    thinkingCommand(argv.slice(3));
    return;
  }
  if (command === "reverse") {
    const { reverseCommand } = await import("./commands/reverse.js");
    reverseCommand(argv.slice(3));
    return;
  }
  if (command === "plan") {
    const { planCommand } = await import("./commands/plan.js");
    await planCommand(argv.slice(3));
    return;
  }
  if (command === "goal") {
    const { goalCommand } = await import("./commands/goal.js");
    await goalCommand(argv.slice(3));
    return;
  }
  if (command === "swarm") {
    const { swarmCommand } = await import("./commands/swarm.js");
    await swarmCommand(argv.slice(3));
    return;
  }
  if (command === "compact" || command === "graph-compact") {
    const { compactCommand } = await import("./commands/compact.js");
    await compactCommand(argv.slice(3), command === "graph-compact");
    return;
  }
  if (command === "memory") {
    const { memoryCommand } = await import("./commands/memory.js");
    await memoryCommand(argv.slice(3));
    return;
  }
  if (command === "tui") {
    await launchConsole(argv.slice(3).join(" ") || undefined);
    return;
  }

  const args = parseArgs();
  if (args.help) {
    stdout.write(HELP);
    exit(0);
  }

  if (args.ui) {
    if (!args.request) {
      stdout.write("--ui requires a request (-r \"<task>\")\n");
      exit(1);
    }
    const { runWithUi } = await import("./ui/run.js");
    const code = await runWithUi({
      provider: args.provider,
      model: args.model,
      request: args.request,
      coverage: args.coverage,
      maxIterations: args.maxIterations,
    });
    exit(code);
  }

  // DEFAULT MODE: interactive console. One-shot output requires --cli.
  if (!args.cli) {
    await launchConsole(args.request);
    return;
  }

  if (!args.request) {
    stdout.write(HELP);
    exit(1);
  }

  const routing = loadConfig().routing;
  const resolver = makeProviderResolver({ provider: args.provider, model: args.model });
  if (normalizeReverseMode(loadConfig().reverse) === "on") stdout.write("nri: graph reversal ON — nodes run in reverse order (/reverse off to disable)\n");
  if (routing?.default || Object.keys(routing?.nodes ?? {}).length > 0) {
    const { formatSpec } = await import("./commands/model.js");
    stdout.write(`nri: routing from config (default=${formatSpec(routing?.default) ?? "cli"})\n`);
  } else {
    const head = resolver("triage");
    stdout.write(`nri: provider=${head.name} model=${head.model}\n`);
  }

  const graph = buildGraph({ resolveProvider: resolver, testRunner: createTestRunner() }, { request: args.request });
  const threadId = `nri-${Date.now()}`;

  let run = await runNri(graph, {
    request: args.request,
    targetTestCoverage: args.coverage,
    maxIterations: args.maxIterations,
    threadId,
    locale: resolveLocale(args.locale),
  });

  let final = run.finalState;

  // Continue only when the caller explicitly configured an approval breakpoint.
  for (let guard = 0; guard < 10 && run.awaitingApproval; guard++) {
    stdout.write("\n=== HITL: proposal graph review (HEAVY_PATH) ===\n");
    stdout.write(JSON.stringify(final.proposalGraph, null, 2) + "\n");
    const approved =
      args.autoApprove || (await confirm("Approve this proposal graph and continue?"));
    if (!approved) {
      stdout.write("Aborted by user at HITL breakpoint.\n");
      exit(2);
    }
    const edited: ProposalGraph | null = null; // approve as-is; edit via library API
    final = await resumeNri(graph, edited, threadId);
    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    run = { finalState: final, awaitingApproval: snap.next.includes("human_approval") };
  }

  stdout.write("\n=== trace ===\n");
  for (const line of final.trace) stdout.write(`  ${line}\n`);
  stdout.write("\n=== result ===\n");
  stdout.write(`path:            ${final.selectedPath}\n`);
  stdout.write(`coverage:        ${final.currentTestCoverage}% (target ${final.targetTestCoverage}%)\n`);
  stdout.write(`iterations:      ${final.iterationCount}\n`);
  stdout.write(`complexity:      time=${final.timeComplexity ?? "-"} space=${final.spaceComplexity ?? "-"}\n`);
  if (final.finalOutput) {
    stdout.write(`\n=== final output (${final.outputLocale}) ===\n`);
    stdout.write(final.finalOutput + "\n");
  }
  stdout.write("\n=== generated code ===\n");
  stdout.write((final.generatedCode ?? "(none)") + "\n");

  const goalMet = final.currentTestCoverage >= final.targetTestCoverage;
  if (!goalMet) {
    stdout.write(
      `\ngoal not met: coverage ${final.currentTestCoverage}% < target ${final.targetTestCoverage}%.` +
        (final.generatedCode ? " Best-effort changes can still be applied below.\n" : "\n"),
    );
  }

  if (final.generatedCode) {
    const { offerApply, planApply } = await import("./tools/apply.js");
    // Nodes already write file blocks as they are produced; only run the
    // end-of-run gate for content that never hit disk (e.g. diffs).
    const plan = planApply(final.generatedCode);
    const already = new Set(final.appliedFiles ?? []);
    const pending = plan.changes.filter((c) => !already.has(c.path));
    if (plan.changes.length > 0 && pending.length === 0) {
      stdout.write(`all ${plan.changes.length} file(s) already written during the run.\n`);
    } else {
      const lines = await offerApply(final.generatedCode, confirm, { yolo: args.yolo, provider: resolver("evaluate") });
      for (const line of lines) stdout.write(`${line}\n`);
    }
  }

  if (args.dumpState) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.dumpState, JSON.stringify(final, null, 2) + "\n");
    stdout.write(`\nstate dumped -> ${args.dumpState}\n`);
  }

  const { saveRun } = await import("./store/memory.js");
  await saveRun({
    request: args.request,
    path: final.selectedPath,
    coverage: final.currentTestCoverage,
    target: final.targetTestCoverage,
    iterations: final.iterationCount,
    summary: final.compactSummary,
  });

  exit(goalMet ? 0 : 3);
}

main().catch((err) => {
  console.error("nri failed:", err instanceof Error ? err.message : err);
  exit(1);
});
