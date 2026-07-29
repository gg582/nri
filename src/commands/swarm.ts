import { stdout } from "node:process";
import { buildGraph, resumeNri, runNri } from "../graph/builder.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { availableProviders } from "../providers/factory.js";
import { createTestRunner } from "../tools/factory.js";
import type { AgentStateType } from "../state.js";

interface SwarmResult {
  provider: string;
  path: string;
  coverage: number;
  iterations: number;
  timeComplexity: string;
  codeLines: number;
  error?: string;
}

async function runOne(provider: string, request: string, coverage: number): Promise<SwarmResult> {
  try {
    const graph = buildGraph(
      {
        resolveProvider: makeProviderResolver({ provider }),
        testRunner: createTestRunner(),
      },
      { request },
    );
    const threadId = `nri-swarm-${provider}-${Date.now()}`;
    const config = { configurable: { thread_id: threadId } };
    let run = await runNri(graph, { request, targetTestCoverage: coverage, threadId });
    for (let i = 0; i < 8 && run.awaitingApproval; i++) {
      await resumeNri(graph, null, threadId);
      const snap = await graph.getState(config);
      run = { finalState: snap.values as AgentStateType, awaitingApproval: snap.next.includes("human_approval") };
    }
    const s = run.finalState;
    return {
      provider,
      path: s.selectedPath,
      coverage: s.currentTestCoverage,
      iterations: s.iterationCount,
      timeComplexity: s.timeComplexity ?? "-",
      codeLines: (s.generatedCode ?? "").split("\n").length,
    };
  } catch (err) {
    return {
      provider,
      path: "-",
      coverage: 0,
      iterations: 0,
      timeComplexity: "-",
      codeLines: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * /swarm — fan the same request out to multiple providers in parallel and
 * compare outcomes side by side.
 * usage: nri swarm [--providers a,b,c] [--coverage N] "<request>"
 */
export async function swarmCommand(args: string[]): Promise<void> {
  let providers: string[] | undefined;
  let coverage = 80;
  const request: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--providers") providers = args[++i].split(",").map((s) => s.trim());
    else if (args[i] === "--coverage") coverage = Number(args[++i]);
    else request.push(args[i]);
  }
  if (request.length === 0) throw new Error('usage: nri swarm [--providers a,b,c] "<request>"');

  const selected = providers ?? availableProviders();
  if (selected.length === 0) throw new Error("no providers available — run `nri provider import` or set API keys.");
  stdout.write(`swarm: ${selected.join(", ")} (coverage target ${coverage}%)\n`);

  const results = await Promise.all(selected.map((p) => runOne(p, request.join(" "), coverage)));

  stdout.write("\nprovider    path        coverage  iter  time     lines  note\n");
  stdout.write("----------  ----------  --------  ----  -------  -----  ----\n");
  for (const r of results) {
    const note = r.error ? r.error.slice(0, 40) : r.coverage >= coverage ? "met" : "missed";
    stdout.write(
      `${r.provider.padEnd(10)}  ${r.path.padEnd(10)}  ${String(r.coverage + "%").padEnd(8)}  ${String(r.iterations).padEnd(4)}  ${r.timeComplexity.padEnd(7)}  ${String(r.codeLines).padEnd(5)}  ${note}\n`,
    );
  }
}
