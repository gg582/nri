/**
 * End-to-end smoke test of the compiled LangGraph pipeline using a stub
 * provider (no API keys needed) and the MockTestRunner.
 * Run: npx tsx examples/smoke.ts
 */
import { z } from "zod";
import { buildGraph, runNri } from "../src/graph/builder.js";
import { MockTestRunner } from "../src/tools/testRunner.js";
import { extractJson, type ChatMessage, type LLMProviderStrategy } from "../src/providers/base.js";
import { TriageResultSchema } from "../src/state.js";

/** Deterministic stub: inspects the system prompt to decide which JSON to emit. */
class StubProvider implements LLMProviderStrategy {
  readonly name = "stub";
  readonly model = "stub-0";
  calls: string[] = [];

  async invoke(messages: ChatMessage[]): Promise<string> {
    const sys = String(messages[0]?.content ?? "");
    this.calls.push(sys.split("\n")[0]);
    if (sys.includes("Request Normalization Engine")) {
      return JSON.stringify({
        canonical_request: String(messages[messages.length - 1]?.content ?? "stub request"),
        source_language: "en-US",
        notes: "stub",
      });
    }
    if (sys.includes("Output Localization Engine")) {
      return "[stub localized final output]";
    }
    if (sys.includes("Triage")) {
      const userMsg = String(messages[messages.length - 1]?.content ?? "");
      const heavy = userMsg.includes("HEAVY");
      return JSON.stringify({
        is_bugfix: !heavy,
        codebase_impact_ratio: heavy ? 0.9 : 0.1,
        selected_path: heavy ? "HEAVY_PATH" : "FAST_PATH",
        reason: "stub routing",
      });
    }
    if (sys.includes("Business Logic Contextualization")) {
      return JSON.stringify({
        problem_summary: "stub problem",
        domain_constraints: ["never delete user data"],
        impacted_business_flows: ["checkout"],
      });
    }
    if (sys.includes("Fast-Path Patch") || sys.includes("Granular Implementation")) {
      return JSON.stringify({
        code: "export const fix = () => 42;",
        time_complexity: "O(1)",
        space_complexity: "O(1)",
        notes: "stub implementation",
      });
    }
    if (sys.includes("Decomposition")) {
      return JSON.stringify({
        node_id: "root",
        task_description: "stub root",
        is_atomic: false,
        children: [
          { node_id: "n1", task_description: "leaf a", is_atomic: true, children: [] },
          { node_id: "n2", task_description: "leaf b", is_atomic: true, children: [] },
        ],
      });
    }
    if (sys.includes("Graph Compression")) {
      return JSON.stringify({
        primal_nodes: [
          {
            id: "p1",
            responsibility: "all leaves",
            member_task_ids: ["n1", "n2"],
            input_contract: "req",
            output_contract: "code",
          },
        ],
        edges: [],
        cycles_detected: [],
        linearization_notes: "already linear",
      });
    }
    if (sys.includes("Proposal")) {
      return JSON.stringify({
        selected_proposals: [
          { node_id: "n1", proposal: "do a", reason_for_adoption: "fits contract" },
        ],
      });
    }
    if (sys.includes("Pre-Flight")) {
      return JSON.stringify({
        is_business_valid: true,
        checked_constraints: ["never delete user data"],
      });
    }
    if (sys.includes("Evaluation")) {
      return JSON.stringify({
        is_overengineered: false,
        selected_scenario: null,
        synthesis_question: null,
        rationale: "fine",
      });
    }
    return "// stub tests";
  }

  async invokeJson<T>(messages: ChatMessage[], schema: z.ZodType<T>): Promise<T> {
    const raw = await this.invoke(messages);
    return schema.parse(JSON.parse(extractJson(raw)));
  }
}

async function main() {
  const provider = new StubProvider();
  const graph = buildGraph({ resolveProvider: () => provider, testRunner: new MockTestRunner() });

  console.log("--- FAST_PATH run (coverage target 80, mock ramp 60->80) ---");
  const fast = await runNri(graph, { request: "fix the off-by-one bug", targetTestCoverage: 80, threadId: "smoke-fast" });
  console.log("awaitingApproval:", fast.awaitingApproval);
  console.log("path:", fast.finalState.selectedPath, "| coverage:", fast.finalState.currentTestCoverage);
  console.log(fast.finalState.trace.join("\n"));
  if (fast.finalState.selectedPath !== "FAST_PATH") throw new Error("expected FAST_PATH");
  if (fast.finalState.currentTestCoverage < 80) throw new Error("coverage target not met");

  console.log("\n--- HEAVY_PATH run (generation-first, no default pause) ---");
  const heavy = await runNri(graph, { request: "HEAVY refactor the entire codebase", targetTestCoverage: 80, threadId: "smoke-heavy" });
  if (heavy.awaitingApproval) throw new Error("HEAVY_PATH should not pause without an explicit breakpoint");
  const final = heavy.finalState;
  console.log("path:", final.selectedPath, "| coverage:", final.currentTestCoverage);
  console.log(final.trace.join("\n"));
  if (final.selectedPath !== "HEAVY_PATH") throw new Error("expected HEAVY_PATH");
  if (final.currentTestCoverage < 80) throw new Error("coverage target not met");

  // sanity: triage schema enforced through the same zod path
  TriageResultSchema.parse({ is_bugfix: true, codebase_impact_ratio: 0.1, selected_path: "FAST_PATH", reason: "x" });
  console.log("\nsmoke test OK — nodes invoked:", provider.calls.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
