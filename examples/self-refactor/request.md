Refactor this TypeScript file (`src/graph/nodes.ts` from the nri agent harness, ~15 files total in the repo, so this is a localized single-file change).

Problem being fixed: in `makeEvaluationNode`, when over-engineering is detected, `currentRequest` is REPLACED by the synthesis question. On the next loop iteration the pipeline decomposes the meta-question and discards the original objective — a real run that was asked for a Qt calculator ended up emitting a "complexity objectives" document instead of refined calculator code.

Required fix (keep it minimal, single file):
1. In `makeEvaluationNode`, when `synthesis_question` exists, set `currentRequest` to the ORIGINAL request (`state.originalRequest`) plus the synthesis question appended as an explicit refinement constraint (e.g. a "Refinement constraint (iteration N)" section). Never drop the original objective.
2. When there is no synthesis question, keep `currentRequest` unchanged.
3. Keep every other node, schema, and signature unchanged.

Return the complete refactored file, nothing else.

File content:

```typescript
import type { LLMProviderStrategy } from "../providers/base.js";
import type { TestRunner } from "../tools/testRunner.js";
import {
  AbstractGraphSchema,
  BusinessContextSchema,
  EvaluationResultSchema,
  ImplementationResultSchema,
  PreFlightResultSchema,
  ProposalGraphSchema,
  TaskNodeSchema,
  TriageResultSchema,
  type AgentStateType,
} from "../state.js";
import {
  ABSTRACT_GRAPH_SYSTEM,
  BUSINESS_CONTEXT_SYSTEM,
  DECOMPOSE_SYSTEM,
  EVALUATION_SYSTEM,
  FAST_PATCH_SYSTEM,
  IMPLEMENT_SYSTEM,
  PRE_FLIGHT_SYSTEM,
  PROPOSAL_SYSTEM,
  TEST_WRITER_SYSTEM,
  TRIAGE_SYSTEM,
} from "../prompts.js";

export interface NodeDeps {
  provider: LLMProviderStrategy;
  testRunner: TestRunner;
}

type State = AgentStateType;
type Update = Partial<State>;

const businessContextBlock = (s: State) =>
  s.businessContext
    ? `\n\nDeclared business context:\n${JSON.stringify(s.businessContext, null, 2)}`
    : "";

/* ---------------- Step 0: Triage ---------------- */

export function makeTriageNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const result = await provider.invokeJson(
      [
        { role: "system", content: TRIAGE_SYSTEM },
        { role: "user", content: `Request:\n${state.currentRequest}` },
      ],
      TriageResultSchema,
    );
    return {
      selectedPath: result.selected_path,
      triageReason: result.reason,
      trace: [
        `[triage] path=${result.selected_path} impact=${result.codebase_impact_ratio} bugfix=${result.is_bugfix} — ${result.reason}`,
      ],
    };
  };
}

/* ---------------- Step 0.5: Business logic contextualization ---------------- */

export function makeBusinessContextNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const ctx = await provider.invokeJson(
      [
        { role: "system", content: BUSINESS_CONTEXT_SYSTEM },
        { role: "user", content: `Request:\n${state.currentRequest}` },
      ],
      BusinessContextSchema,
    );
    return {
      businessContext: ctx,
      trace: [
        `[business-context] constraints=${ctx.domain_constraints.length} flows=${ctx.impacted_business_flows.length}`,
      ],
    };
  };
}

/* ---------------- FAST_PATH: direct patch ---------------- */

export function makeFastPatchNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const feedback = state.preFlight?.violation_reason
      ? `\n\nPrevious attempt was rejected by pre-flight audit: ${state.preFlight.violation_reason}\nFix this.`
      : "";
    const impl = await provider.invokeJson(
      [
        { role: "system", content: FAST_PATCH_SYSTEM },
        {
          role: "user",
          content:
            `Request:\n${state.currentRequest}${businessContextBlock(state)}${feedback}` +
            (state.generatedCode ? `\n\nCurrent code:\n${state.generatedCode}` : ""),
        },
      ],
      ImplementationResultSchema,
    );
    return {
      generatedCode: impl.code,
      timeComplexity: impl.time_complexity,
      spaceComplexity: impl.space_complexity,
      preFlight: null,
      trace: [`[fast-patch] applied (${impl.notes})`],
    };
  };
}

/* ---------------- HEAVY_PATH: decomposition (steps 1-4) ---------------- */

export function makeDecomposeNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const tree = await provider.invokeJson(
      [
        { role: "system", content: DECOMPOSE_SYSTEM },
        { role: "user", content: `Request:\n${state.currentRequest}${businessContextBlock(state)}` },
      ],
      TaskNodeSchema,
    );
    return { taskTree: tree, trace: [`[decompose] root="${tree.task_description}"`] };
  };
}

/* ---------------- Abstract graph: compression + linearization ---------------- */

export function makeAbstractGraphNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const graph = await provider.invokeJson(
      [
        { role: "system", content: ABSTRACT_GRAPH_SYSTEM },
        {
          role: "user",
          content:
            `Task tree:\n${JSON.stringify(state.taskTree, null, 2)}` + businessContextBlock(state),
        },
      ],
      AbstractGraphSchema,
    );
    return {
      abstractGraph: graph,
      trace: [
        `[abstract-graph] primal_nodes=${graph.primal_nodes.length} edges=${graph.edges.length} cycles=${graph.cycles_detected.length}`,
      ],
    };
  };
}

/* ---------------- Proposals: bottom-up + top-down (steps 5-6) ---------------- */

export function makeProposalNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const proposals = await provider.invokeJson(
      [
        { role: "system", content: PROPOSAL_SYSTEM },
        {
          role: "user",
          content:
            `Abstract graph:\n${JSON.stringify(state.abstractGraph, null, 2)}` +
            `\n\nTask tree:\n${JSON.stringify(state.taskTree, null, 2)}` +
            businessContextBlock(state),
        },
      ],
      ProposalGraphSchema,
    );
    return {
      proposalGraph: proposals,
      trace: [`[proposal] adopted=${proposals.selected_proposals.length}`],
    };
  };
}

/* ---------------- Pre-flight business audit ---------------- */

export function makePreFlightNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const plan =
      state.selectedPath === "HEAVY_PATH"
        ? JSON.stringify(
            { abstract_graph: state.abstractGraph, proposals: state.proposalGraph },
            null,
            2,
          )
        : `Patch:\n${state.generatedCode}`;
    const result = await provider.invokeJson(
      [
        { role: "system", content: PRE_FLIGHT_SYSTEM },
        {
          role: "user",
          content: `Plan under review:\n${plan}${businessContextBlock(state)}`,
        },
      ],
      PreFlightResultSchema,
    );
    return {
      preFlight: result,
      preFlightAttempts: state.preFlightAttempts + 1,
      trace: [
        `[pre-flight] valid=${result.is_business_valid}` +
          (result.violation_reason ? ` — ${result.violation_reason}` : ""),
      ],
    };
  };
}

/* ---------------- HEAVY_PATH implementation (steps 8-9) ---------------- */

export function makeImplementNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const impl = await provider.invokeJson(
      [
        { role: "system", content: IMPLEMENT_SYSTEM },
        {
          role: "user",
          content:
            `Abstract graph:\n${JSON.stringify(state.abstractGraph, null, 2)}` +
            `\n\nAdopted proposals:\n${JSON.stringify(state.proposalGraph, null, 2)}` +
            businessContextBlock(state),
        },
      ],
      ImplementationResultSchema,
    );
    return {
      generatedCode: impl.code,
      timeComplexity: impl.time_complexity,
      spaceComplexity: impl.space_complexity,
      trace: [`[implement] time=${impl.time_complexity} space=${impl.space_complexity}`],
    };
  };
}

/* ---------------- Evaluation (steps 10-13) ---------------- */

export function makeEvaluationNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const evaluation = await provider.invokeJson(
      [
        { role: "system", content: EVALUATION_SYSTEM },
        {
          role: "user",
          content:
            `Objective:\n${state.currentRequest}\n\n` +
            `Declared complexity: time=${state.timeComplexity} space=${state.spaceComplexity}\n\n` +
            `Implementation:\n${state.generatedCode}`,
        },
      ],
      EvaluationResultSchema,
    );
    const nextRequest =
      evaluation.is_overengineered && evaluation.synthesis_question
        ? evaluation.synthesis_question
        : state.currentRequest;
    return {
      synthesisQuestion: evaluation.synthesis_question,
      currentRequest: nextRequest,
      trace: [
        `[evaluate] overengineered=${evaluation.is_overengineered} scenario=${evaluation.selected_scenario ?? "-"}` +
          (evaluation.synthesis_question ? ` q="${evaluation.synthesis_question}"` : ""),
      ],
    };
  };
}

/* ---------------- Test runner & coverage ---------------- */

export function makeTestRunnerNode({ provider, testRunner }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const tests = await provider.invoke([
      { role: "system", content: TEST_WRITER_SYSTEM },
      {
        role: "user",
        content: `Implementation:\n${state.generatedCode}${businessContextBlock(state)}`,
      },
    ]);
    const result = await testRunner.run(state.generatedCode ?? "", tests, state.iterationCount + 1);
    return {
      currentTestCoverage: result.coverage,
      iterationCount: state.iterationCount + 1,
      trace: [
        `[test-runner] coverage=${result.coverage}% target=${state.targetTestCoverage}% passed=${result.passed}`,
      ],
    };
  };
}

/* ---------------- Conditional edges ---------------- */

export function routeAfterTriage(state: State): "fast_patch" | "decompose" {
  return state.selectedPath === "FAST_PATH" ? "fast_patch" : "decompose";
}

/**
 * Pre-flight runs BEFORE code is committed/executed.
 * - valid   -> FAST: straight to the test runner; HEAVY: granular implementation.
 * - invalid -> re-plan on the active path, up to 3 attempts (loop guardrail).
 */
export function routeAfterPreFlight(
  state: State,
): "fast_patch" | "test_runner" | "implement" | "proposal" | "__end__" {
  if (state.preFlight?.is_business_valid) {
    return state.selectedPath === "FAST_PATH" ? "test_runner" : "implement";
  }
  if (state.preFlightAttempts >= 3) return "__end__";
  return state.selectedPath === "FAST_PATH" ? "fast_patch" : "proposal";
}

export function routeAfterTests(state: State): "fast_patch" | "decompose" | "__end__" {
  if (state.currentTestCoverage >= state.targetTestCoverage) return "__end__";
  if (state.iterationCount >= state.maxIterations) return "__end__";
  return state.selectedPath === "FAST_PATH" ? "fast_patch" : "decompose";
}
```
