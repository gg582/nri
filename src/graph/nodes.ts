import type { LLMProviderStrategy } from "../providers/base.js";
import type { TestRunner } from "../tools/testRunner.js";
import {
  AbstractGraphSchema,
  BusinessContextSchema,
  EvaluationResultSchema,
  ImplementationResultSchema,
  NormalizedRequestSchema,
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
  FINALIZE_SYSTEM,
  IMPLEMENT_SYSTEM,
  NORMALIZE_SYSTEM,
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

/* ---------------- Ingress: normalize raw request into controlled English ---------------- */

export function makeNormalizeNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const raw = state.rawRequest ?? state.currentRequest;
    const result = await provider.invokeJson(
      [
        { role: "system", content: NORMALIZE_SYSTEM },
        { role: "user", content: `Raw request:\n${raw}` },
      ],
      NormalizedRequestSchema,
    );
    return {
      rawRequest: raw,
      originalRequest: result.canonical_request,
      currentRequest: result.canonical_request,
      trace: [
        `[normalize] ${result.source_language} -> controlled English (${result.notes || "ok"})`,
      ],
    };
  };
}

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

    let nextRequest: string;
    if (evaluation.is_overengineered && evaluation.synthesis_question) {
      // When over-engineering is detected and a synthesis question is provided,
      // augment the original request with the synthesis question as a refinement constraint.
      nextRequest =
        `${state.originalRequest}\n\n` +
        `Refinement constraint (iteration ${state.iterationCount + 1}):\n` +
        `${evaluation.synthesis_question}`;
    } else {
      // Otherwise, keep the current request unchanged.
      nextRequest = state.currentRequest;
    }

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

/* ---------------- Egress: localize final output ---------------- */

/** Normalize a user-supplied locale/country code into a concrete target. */
export function resolveLocaleLabel(locale: string): string {
  const l = locale.trim().toLowerCase();
  const map: Record<string, string> = {
    us: "en-US (American English)",
    "en-us": "en-US (American English)",
    uk: "en-GB (British English)",
    gb: "en-GB (British English)",
    "en-gb": "en-GB (British English)",
    au: "en-AU (Australian English)",
    "en-au": "en-AU (Australian English)",
    ie: "en-IE (Irish English)",
    "en-ie": "en-IE (Irish English)",
  };
  return map[l] ?? locale;
}

export function makeFinalizeNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const summary = [
      `Path: ${state.selectedPath}`,
      `Coverage: ${state.currentTestCoverage}% (target ${state.targetTestCoverage}%)`,
      `Iterations: ${state.iterationCount}`,
      `Complexity: time=${state.timeComplexity ?? "-"} space=${state.spaceComplexity ?? "-"}`,
      state.compactSummary ? `Compact summary: ${state.compactSummary}` : "",
      `Generated code:\n${state.generatedCode ?? "(none)"}`,
    ]
      .filter(Boolean)
      .join("\n");
    const finalOutput = await provider.invoke([
      { role: "system", content: FINALIZE_SYSTEM },
      {
        role: "user",
        content: `Target locale: ${resolveLocaleLabel(state.outputLocale)}\n\nRun summary:\n${summary}`,
      },
    ]);
    return {
      finalOutput,
      trace: [`[finalize] localized -> ${state.outputLocale}`],
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

export function routeAfterTests(state: State): "fast_patch" | "decompose" | "finalize" {
  if (state.currentTestCoverage >= state.targetTestCoverage) return "finalize";
  if (state.iterationCount >= state.maxIterations) return "finalize";
  return state.selectedPath === "FAST_PATH" ? "fast_patch" : "decompose";
}

