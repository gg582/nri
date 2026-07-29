import { stdout } from "node:process";
import { buildGraph, resumeNri, runNri } from "../graph/builder.js";
import { makeProviderResolver } from "../providers/resolver.js";
import { createTestRunner } from "../tools/factory.js";
import type { AgentStateType } from "../state.js";

/**
 * /plan — read-only planning run.
 * Runs the pipeline up to (but never past) code implementation/test
 * execution: interrupts before "implement" and "test_runner", auto-approves
 * the HITL breakpoint, then prints the plan and stops. Nothing is executed.
 */
export async function planCommand(args: string[]): Promise<void> {
  const request = args.join(" ").trim();
  if (!request) throw new Error('usage: nri plan "<request>"');

  const graph = buildGraph(
    { resolveProvider: makeProviderResolver({}), testRunner: createTestRunner() },
    { interruptBefore: ["implement", "test_runner"], request },
  );
  const threadId = `nri-plan-${Date.now()}`;
  const config = { configurable: { thread_id: threadId } };

  let run = await runNri(graph, { request, targetTestCoverage: 100, threadId });
  // Auto-approve the heavy-path HITL breakpoint so the plan completes.
  for (let i = 0; i < 4 && run.awaitingApproval; i++) {
    await resumeNri(graph, null, threadId);
    const snap = await graph.getState(config);
    run = { finalState: snap.values as AgentStateType, awaitingApproval: snap.next.includes("human_approval") };
  }

  const s = (await graph.getState(config)).values as AgentStateType;
  stdout.write(`\n=== plan (${s.selectedPath || "unknown path"}) ===\n`);
  if (s.businessContext) {
    stdout.write(`problem: ${s.businessContext.problem_summary}\n`);
    stdout.write(`constraints: ${s.businessContext.domain_constraints.join("; ")}\n`);
  }
  if (s.abstractGraph) {
    stdout.write(`\nabstract graph: ${s.abstractGraph.primal_nodes.length} primal nodes\n`);
    for (const n of s.abstractGraph.primal_nodes) {
      stdout.write(`  - ${n.id}: ${n.responsibility} (${n.input_contract} -> ${n.output_contract})\n`);
    }
  }
  if (s.proposalGraph) {
    stdout.write(`\nproposals: ${s.proposalGraph.selected_proposals.length}\n`);
    for (const p of s.proposalGraph.selected_proposals) {
      stdout.write(`  - [${p.node_id}] ${p.proposal}\n`);
    }
  }
  if (s.generatedCode) stdout.write(`\nplanned patch:\n${s.generatedCode}\n`);
  if (s.preFlight) stdout.write(`\npre-flight: valid=${s.preFlight.is_business_valid}\n`);
  stdout.write("\n(plan mode: nothing was implemented or executed)\n");
}
