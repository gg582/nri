
=== RETRY WITH REFINEMENT (previous attempt FAILED evaluation) ===
Synthesis question from the pipeline's own evaluation of the previous attempt:
"The implementation significantly alters or removes existing core components (AgentState schema, NodeDeps interface, buildGraph structure, runNri signature, loadConfig logic, cli.ts features) instead of extending them. How can the new features be integrated while preserving all existing functionality and adhering strictly to the constraint 'Keep every existing node, exported name, and schema otherwise unchanged'?"

Hard requirements for this attempt:
1. Output a UNIFIED DIFF (---/+++ headers, @@ hunks with real context lines copied from the embedded files). NO annotated full files, NO pseudo-code, NO prose outside the diff.
2. AgentState is an Annotation.Root(...) — extend it, never redefine it as an interface. `replace` is a local helper in state.ts, not an import.
3. src/config.ts already exports NriConfig { locale?, providers?, routing?, permissions? }, loadConfig(), saveGlobalConfig() — only ADD resolveLocale().
4. buildGraph already takes (deps: GraphDeps, opts?: BuildGraphOptions) with GraphDeps { resolveProvider, testRunner }. Node factories receive NodeDeps { provider, testRunner } via forNode() — follow that exact pattern for normalize/finalize.
5. Every import path must match the embedded files exactly.
Implement a new feature in the nri agent harness (TypeScript, LangGraph, ESM). Output a UNIFIED DIFF covering every changed or new file: paths relative to repo root, ---/+++ headers, @@ hunks. No full files, no prose outside the diff.

NOTE: src/config.ts already exists (providers/routing config, loadConfig/saveGlobalConfig). EXTEND it for locale — do not recreate it.

FEATURE: Controlled-English ingress + localized egress.

1. Ingress node "normalize" (new), wired START -> normalize -> triage:
   - Translate the raw incoming request (any language) into common English, then rewrite it in controlled, machine-friendly English (ACE-style): one requirement per sentence, explicit actor/action/condition, no idioms, no unresolved pronouns, defined terms only.
   - New zod schema NormalizedRequestSchema { canonical_request: string, source_language: string, notes: string } in src/state.ts.
   - New prompt NORMALIZE_SYSTEM in src/prompts.ts, including one line stating that all intermediate reasoning and artifacts stay in machine-friendly English.
   - Node sets: rawRequest = untouched input, originalRequest = canonical_request, currentRequest = canonical_request.
   - builder.ts runNri passes input { rawRequest: input.request, outputLocale: <resolved>, targetTestCoverage, maxIterations } (no originalRequest/currentRequest — normalize sets them).

2. Egress node "finalize" (new), wired between test_runner and END:
   - routeAfterTests returns "finalize" instead of "__end__" in BOTH exit branches; add edge finalize -> END.
   - Builds a final summary (selected path, coverage vs target, iterations, time/space complexity, generated code) and translates it into state.outputLocale.
   - Locale mapping: "us"/"en-US" -> American English (default); "uk"/"gb"/"en-GB" -> British English; "au"/"en-AU" -> Australian English; "ie"/"en-IE" -> Irish English; any other ISO code -> that language. English variants constrain spelling/idiom only.
   - New prompt FINALIZE_SYSTEM in src/prompts.ts. Result stored in state.finalOutput.

3. Locale resolution (extend src/config.ts):
   - export function resolveLocale(cliLocale?: string): string
   - Precedence: cliLocale > NRI_LOCALE env > config.locale > "en-US".
   - cli.ts: add "--locale <code>" flag; resolve and pass outputLocale in runNri input; print finalOutput in the result section.

4. src/state.ts additions: rawRequest: string, outputLocale: string (default "en-US"), finalOutput: string. Register "normalize" and "finalize" nodes in src/graph/builder.ts: START -> "normalize" -> "triage"; implement makeNormalizeNode and makeFinalizeNode in src/graph/nodes.ts (LLM node names for routing: "normalize", "finalize" — they receive NodeDeps like the others).

Constraints:
- Keep every existing node, exported name, and schema otherwise unchanged.
- Unified diff only.

=== FILE: src/state.ts ===
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Zod schemas for structured LLM outputs                              */
/* ------------------------------------------------------------------ */

export const TriageResultSchema = z.object({
  is_bugfix: z.boolean(),
  codebase_impact_ratio: z.number().min(0).max(1),
  selected_path: z.enum(["FAST_PATH", "HEAVY_PATH"]),
  reason: z.string(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

export const BusinessContextSchema = z.object({
  problem_summary: z.string(),
  domain_constraints: z.array(z.string()),
  impacted_business_flows: z.array(z.string()),
});
export type BusinessContext = z.infer<typeof BusinessContextSchema>;

export const TaskNodeSchema: z.ZodType<TaskNode> = z.lazy(() =>
  z.object({
    node_id: z.string(),
    task_description: z.string(),
    is_atomic: z.boolean(),
    children: z.array(TaskNodeSchema),
  }),
);
export interface TaskNode {
  node_id: string;
  task_description: string;
  is_atomic: boolean;
  children: TaskNode[];
}

export const AbstractGraphSchema = z.object({
  primal_nodes: z.array(
    z.object({
      id: z.string(),
      responsibility: z.string(),
      member_task_ids: z.array(z.string()),
      input_contract: z.string(),
      output_contract: z.string(),
    }),
  ),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  cycles_detected: z.array(z.string()),
  linearization_notes: z.string(),
});
export type AbstractGraph = z.infer<typeof AbstractGraphSchema>;

export const ProposalGraphSchema = z.object({
  selected_proposals: z.array(
    z.object({
      node_id: z.string(),
      proposal: z.string(),
      reason_for_adoption: z.string(),
    }),
  ),
});
export type ProposalGraph = z.infer<typeof ProposalGraphSchema>;

export const PreFlightResultSchema = z.object({
  is_business_valid: z.boolean(),
  violation_reason: z.string().optional(),
  checked_constraints: z.array(z.string()),
});
export type PreFlightResult = z.infer<typeof PreFlightResultSchema>;

export const ImplementationResultSchema = z.object({
  code: z.string(),
  time_complexity: z.string(),
  space_complexity: z.string(),
  notes: z.string(),
});
export type ImplementationResult = z.infer<typeof ImplementationResultSchema>;

export const EvaluationResultSchema = z.object({
  is_overengineered: z.boolean(),
  selected_scenario: z.enum(["A", "B", "C"]).nullable(),
  synthesis_question: z.string().nullable(),
  rationale: z.string(),
});
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;

/* ------------------------------------------------------------------ */
/* LangGraph state                                                     */
/* ------------------------------------------------------------------ */

const replace = <T>() => Annotation<T>({ reducer: (_a, b) => b, default: undefined as never });

export const AgentState = Annotation.Root({
  originalRequest: replace<string>(),
  currentRequest: replace<string>(),
  targetTestCoverage: replace<number>(),
  currentTestCoverage: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),

  selectedPath: replace<"FAST_PATH" | "HEAVY_PATH" | "">(),
  triageReason: replace<string>(),

  businessContext: replace<BusinessContext | null>(),
  taskTree: replace<TaskNode | null>(),
  abstractGraph: replace<AbstractGraph | null>(),
  proposalGraph: replace<ProposalGraph | null>(),

  generatedCode: replace<string>(),
  timeComplexity: replace<string>(),
  spaceComplexity: replace<string>(),

  preFlight: replace<PreFlightResult | null>(),
  synthesisQuestion: replace<string | null>(),

  iterationCount: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  maxIterations: Annotation<number>({ reducer: (_a, b) => b, default: () => 5 }),
  preFlightAttempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),

  /** Execution trace for observability. */
  trace: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentState.State;

=== FILE: src/prompts.ts ===
/**
 * System/user prompts for every pipeline node.
 * Prompts are kept in English: they are LLM-facing artifacts, and the
 * schemas they enforce use the same JSON keys the zod schemas expect.
 */

export const TRIAGE_SYSTEM = `You are the Triage & Routing Engine of an adaptive agent harness.
Analyze the user request and decide the execution path.

Routing rules:
- Select FAST_PATH if the request is a localized bugfix or affects a small portion of the codebase.
- Select HEAVY_PATH only when the request is an architectural change/refactor affecting >= 80% of the codebase AND is not a simple bugfix.

Respond with ONLY valid JSON:
{
  "is_bugfix": boolean,
  "codebase_impact_ratio": number,   // 0.0 .. 1.0
  "selected_path": "FAST_PATH" | "HEAVY_PATH",
  "reason": string
}`;

export const BUSINESS_CONTEXT_SYSTEM = `You are the Business Logic Contextualization Engine.
Before any code is written, make the business reality of this task explicit.

Analyze the request and any provided codebase context, then respond with ONLY valid JSON:
{
  "problem_summary": string,              // restate the problem at the domain level
  "domain_constraints": string[],         // invariants that must NOT break
  "impacted_business_flows": string[]     // features exposed to side-effects
}`;

export const FAST_PATCH_SYSTEM = `You are the Fast-Path Patch Engine.
Apply a minimal, targeted fix. Do NOT restructure. Do NOT add speculative features.
Also remove any unexplained or redundant code introduced by the patch.

Respond with ONLY valid JSON:
{
  "code": string,            // the complete patched code
  "time_complexity": string, // e.g. "O(n)"
  "space_complexity": string,
  "notes": string            // what changed and why
}`;

export const DECOMPOSE_SYSTEM = `You are the Decomposition Engine of an autonomous software architect system.

Deconstruct the request into a decision tree:
1. Break the request into sequential procedural steps.
2. Subdivide each step into explicit sub-tasks.
3. Recursively expand until every leaf node is an ATOMIC task:
   one input, one clear output, a single responsibility, indivisible.

Respond with ONLY valid JSON matching:
{
  "node_id": "root",
  "task_description": string,
  "is_atomic": boolean,
  "children": [ { "node_id": string, "task_description": string, "is_atomic": boolean, "children": [] } ]
}`;

export const ABSTRACT_GRAPH_SYSTEM = `You are the Graph Compression & Linearization Engine.

Given a fully decomposed task tree, produce an ABSTRACT GRAPH before any detailed planning:
1. Cluster related task nodes into a small set of PRIMAL NODES (node groups) with clear responsibilities.
2. Define input/output interface contracts for each primal node.
3. Detect any cycles in the dependency flow and linearize them (flatten the flow, remove loop risks).
4. Keep the graph as shallow as possible: compress depth aggressively.

Respond with ONLY valid JSON:
{
  "primal_nodes": [
    {
      "id": string,
      "responsibility": string,
      "member_task_ids": string[],
      "input_contract": string,
      "output_contract": string
    }
  ],
  "edges": [ { "from": string, "to": string } ],
  "cycles_detected": string[],
  "linearization_notes": string
}`;

export const PROPOSAL_SYSTEM = `You are the Proposal & Decision Engine.

Using the abstract graph and its primal nodes:
1. BOTTOM-UP: write concrete technical proposals for the leaf/atomic tasks inside each primal node.
2. TOP-DOWN: traverse the abstract graph from the top, compare proposals, and adopt only those
   consistent with the primal node's interface contract and the overall objective.

Respond with ONLY valid JSON:
{
  "selected_proposals": [
    { "node_id": string, "proposal": string, "reason_for_adoption": string }
  ]
}`;

export const PRE_FLIGHT_SYSTEM = `You are the Pre-Flight Business Logic Auditor.

Perform a simulated top-to-bottom traversal of the proposed plan/patch BEFORE any code is committed.
Check it against the declared business context:
- Every domain constraint must remain intact.
- No impacted business flow may silently break.
- Reject plans that merely chase test-coverage numbers while violating domain rules.

Respond with ONLY valid JSON:
{
  "is_business_valid": boolean,
  "violation_reason": string,        // required when invalid
  "checked_constraints": string[]
}`;

export const IMPLEMENT_SYSTEM = `You are the Granular Implementation Engine.

Fill in the detailed implementation by traversing the abstract graph's primal nodes:
1. TOP-DOWN first pass: high-level structure (interfaces, module skeletons) down to atomic logic.
2. BOTTOM-UP second pass: let low-level constraints refine the higher-level interfaces.
3. Respect each primal node's input/output contract exactly.

Respond with ONLY valid JSON:
{
  "code": string,
  "time_complexity": string,
  "space_complexity": string,
  "notes": string
}`;

export const EVALUATION_SYSTEM = `You are the Execution & Evaluation Engine.

Evaluate the implementation:
1. Judge time/space complexity against the stated objective.
2. Detect over-engineering: excessive resource use, unexplained boilerplate, dead code.
3. If over-engineered, select exactly ONE scenario:
   [A] Structural Simplification
   [B] Micro-optimization
   [C] Module Replacement
4. Derive ONE synthesis question that, if answered, resolves the issue.
   (The harness will feed it back as a new request.)

If the implementation is sound, set is_overengineered=false and synthesis_question=null.

Respond with ONLY valid JSON:
{
  "is_overengineered": boolean,
  "selected_scenario": "A" | "B" | "C" | null,
  "synthesis_question": string | null,
  "rationale": string
}`;

export const TEST_WRITER_SYSTEM = `You are the Test Generation Engine.
Write focused unit tests for the provided implementation. Cover the business constraints listed.
Respond with ONLY the test code, no prose.`;

=== FILE: src/graph/nodes.ts ===
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


=== FILE: src/graph/builder.ts ===
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { AgentState, type AgentStateType, type ProposalGraph } from "../state.js";
import type { LLMProviderStrategy } from "../providers/base.js";
import type { TestRunner } from "../tools/testRunner.js";
import {
  makeAbstractGraphNode,
  makeBusinessContextNode,
  makeDecomposeNode,
  makeEvaluationNode,
  makeFastPatchNode,
  makeImplementNode,
  makePreFlightNode,
  makeProposalNode,
  makeTestRunnerNode,
  makeTriageNode,
  routeAfterPreFlight,
  routeAfterTests,
  routeAfterTriage,
  type NodeDeps,
} from "./nodes.js";

/**
 * Graph-level dependencies: a per-node provider resolver plus the test runner.
 * `resolveProvider(nodeName)` lets each pipeline node run on a different
 * model/provider (configured via `nri model` routing).
 */
export interface GraphDeps {
  resolveProvider: (node: string) => LLMProviderStrategy;
  testRunner: TestRunner;
}

/**
 * Pipeline:
 *
 *   triage -> business_context ─┬─ FAST:  fast_patch ─────────────┐
 *                               └─ HEAVY: decompose ->            │
 *                                          abstract_graph ->      │
 *                                          proposal ->            │
 *                                          human_approval ->      │
 *                                         pre_flight <────────────┘
 *                              valid(fast)  -> test_runner
 *                              valid(heavy) -> implement -> evaluate -> test_runner
 *                              invalid      -> re-plan (max 3 attempts)
 *   test_runner -> coverage >= target ? END : loop (fast_patch | decompose)
 */
export function buildGraph(deps: GraphDeps) {
  const { testRunner } = deps;
  const forNode = (node: string): NodeDeps => ({
    provider: deps.resolveProvider(node),
    testRunner,
  });
  const graph = new StateGraph(AgentState)
    .addNode("triage", makeTriageNode(forNode("triage")))
    .addNode("business_context", makeBusinessContextNode(forNode("business_context")))
    .addNode("fast_patch", makeFastPatchNode(forNode("fast_patch")))
    .addNode("decompose", makeDecomposeNode(forNode("decompose")))
    .addNode("abstract_graph", makeAbstractGraphNode(forNode("abstract_graph")))
    .addNode("proposal", makeProposalNode(forNode("proposal")))
    .addNode("human_approval", async () => ({ trace: ["[hitl] proposal graph approved"] }))
    .addNode("pre_flight", makePreFlightNode(forNode("pre_flight")))
    .addNode("implement", makeImplementNode(forNode("implement")))
    .addNode("evaluate", makeEvaluationNode(forNode("evaluate")))
    .addNode("test_runner", makeTestRunnerNode(forNode("test_writer")))
    .addEdge(START, "triage")
    .addEdge("triage", "business_context")
    .addConditionalEdges("business_context", routeAfterTriage, {
      fast_patch: "fast_patch",
      decompose: "decompose",
    })
    .addEdge("fast_patch", "pre_flight")
    .addEdge("decompose", "abstract_graph")
    .addEdge("abstract_graph", "proposal")
    .addEdge("proposal", "human_approval")
    .addEdge("human_approval", "pre_flight")
    .addConditionalEdges("pre_flight", routeAfterPreFlight, {
      fast_patch: "fast_patch",
      test_runner: "test_runner",
      implement: "implement",
      proposal: "proposal",
      __end__: END,
    })
    .addEdge("implement", "evaluate")
    .addEdge("evaluate", "test_runner")
    .addConditionalEdges("test_runner", routeAfterTests, {
      fast_patch: "fast_patch",
      decompose: "decompose",
      __end__: END,
    });

  const checkpointer = new MemorySaver();
  return graph.compile({ checkpointer, interruptBefore: ["human_approval"] });
}

export interface NriRunInput {
  request: string;
  targetTestCoverage: number;
  maxIterations?: number;
  threadId?: string;
}

export interface NriRunResult {
  finalState: AgentStateType;
  /** True when execution stopped at the HITL breakpoint and awaits approval. */
  awaitingApproval: boolean;
}

export type CompiledNriGraph = ReturnType<typeof buildGraph>;

/** Start (or resume) a run. Stops at the HITL breakpoint on the heavy path. */
export async function runNri(graph: CompiledNriGraph, input: NriRunInput): Promise<NriRunResult> {
  const config = { configurable: { thread_id: input.threadId ?? "nri-session" } };
  await graph.invoke(
    {
      originalRequest: input.request,
      currentRequest: input.request,
      targetTestCoverage: input.targetTestCoverage,
      maxIterations: input.maxIterations ?? 5,
    },
    config,
  );
  const snapshot = await graph.getState(config);
  return {
    finalState: snapshot.values as AgentStateType,
    awaitingApproval: snapshot.next.includes("human_approval"),
  };
}

/**
 * Resume after the HITL breakpoint. Pass an edited ProposalGraph to apply
 * user modifications before continuing, or null to approve as-is.
 */
export async function resumeNri(
  graph: CompiledNriGraph,
  editedProposalGraph: ProposalGraph | null,
  threadId = "nri-session",
): Promise<AgentStateType> {
  const config = { configurable: { thread_id: threadId } };
  if (editedProposalGraph) {
    await graph.updateState(config, { proposalGraph: editedProposalGraph });
  }
  await graph.invoke(null, config);
  const snapshot = await graph.getState(config);
  return snapshot.values as AgentStateType;
}

=== FILE: src/config.ts ===
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Credentials/settings for one provider, stored in nri config. */
export interface ProviderConfig {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  /** Extra model ids offered by this provider (e.g. imported from kimi-code). */
  models?: string[];
  /** Free-form provenance note, e.g. "imported from kimi-code (oauth token, expires ...)". */
  note?: string;
}

/** Per-node model routing: values are "provider:model" or "provider" specs. */
export interface RoutingConfig {
  default?: string;
  nodes?: Record<string, string>;
}

export interface NriConfig {
  locale?: string;
  providers?: Record<string, ProviderConfig>;
  routing?: RoutingConfig;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "nri", "config.json");
export const CWD_CONFIG_PATH = join(process.cwd(), "nri.config.json");

function readJson(path: string): NriConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as NriConfig;
  } catch {
    return {};
  }
}

function merge(base: NriConfig, over: NriConfig): NriConfig {
  return {
    locale: over.locale ?? base.locale,
    providers: { ...base.providers, ...over.providers },
    routing: {
      default: over.routing?.default ?? base.routing?.default,
      nodes: { ...base.routing?.nodes, ...over.routing?.nodes },
    },
  };
}

/** Load config: global (~/.config/nri/config.json) merged with cwd (nri.config.json). */
export function loadConfig(): NriConfig {
  return merge(readJson(GLOBAL_CONFIG_PATH), readJson(CWD_CONFIG_PATH));
}

/** Persist a partial config to the global config file (deep-merged). */
export function saveGlobalConfig(patch: NriConfig): void {
  const next = merge(readJson(GLOBAL_CONFIG_PATH), patch);
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

/** Mask a secret for display: keep first 4 / last 2 chars. */
export function maskKey(key?: string): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}

=== FILE: src/cli.ts ===
#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { buildGraph, resumeNri, runNri } from "./graph/builder.js";
import { PROVIDER_NAMES } from "./providers/factory.js";
import { makeProviderResolver } from "./providers/resolver.js";
import { createTestRunner } from "./tools/factory.js";
import { loadConfig } from "./config.js";
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
}

function parseArgs(): CliArgs {
  const args: CliArgs = { coverage: 80, maxIterations: 5, autoApprove: false, ui: false, help: false };
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
      case "--yes":
      case "-y":
        args.autoApprove = true;
        break;
      case "--ui":
        args.ui = true;
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
  nri --request "<task>" [options]
  nri "<task>" [options]
  nri provider <list|import|add|remove>   manage providers (also: /provider)
  nri model <list|assign|set|candidates>  per-node model routing (also: /model)

Options:
  -p, --provider <name>   ${PROVIDER_NAMES.join(" | ")}   (default: routing config, $NRI_PROVIDER, or openai)
  -m, --model <id>        model id override               (default: routing config or provider default)
  -r, --request <text>    the engineering task
  -c, --coverage <n>      target test coverage %          (default: 80)
      --max-iterations <n> loop guardrail                 (default: 5)
  -y, --yes               auto-approve the HITL proposal-graph review
      --ui                run with the ink TUI (seoulism theme)
  -h, --help              show this help

Commands:
  nri provider list                       configured providers (* = credentials available)
  nri provider import [kimi-code|codex]   auto-import credentials from existing AI clients
  nri provider add [name]                 manual interactive entry
  nri provider remove <name>              remove stored credentials
  nri model list                          current per-node routing table
  nri model assign                        multi-select models, auto-assign per node capability
  nri model set <node|default> <provider:model>
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

async function main(): Promise<void> {
  // Subcommands: accept both "provider" and "/provider" spellings.
  const command = argv[2]?.replace(/^\//, "");
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

  const args = parseArgs();
  if (args.help || !args.request) {
    stdout.write(HELP);
    exit(args.help ? 0 : 1);
  }

  if (args.ui) {
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

  const routing = loadConfig().routing;
  const resolver = makeProviderResolver({ provider: args.provider, model: args.model });
  if (routing?.default || Object.keys(routing?.nodes ?? {}).length > 0) {
    stdout.write(`nri: routing from config (default=${routing?.default ?? "cli"})\n`);
  } else {
    const head = resolver("triage");
    stdout.write(`nri: provider=${head.name} model=${head.model}\n`);
  }

  const graph = buildGraph({ resolveProvider: resolver, testRunner: createTestRunner() });
  const threadId = `nri-${Date.now()}`;

  const run = await runNri(graph, {
    request: args.request,
    targetTestCoverage: args.coverage,
    maxIterations: args.maxIterations,
    threadId,
  });

  let final = run.finalState;

  if (run.awaitingApproval) {
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
  }

  stdout.write("\n=== trace ===\n");
  for (const line of final.trace) stdout.write(`  ${line}\n`);
  stdout.write("\n=== result ===\n");
  stdout.write(`path:            ${final.selectedPath}\n`);
  stdout.write(`coverage:        ${final.currentTestCoverage}% (target ${final.targetTestCoverage}%)\n`);
  stdout.write(`iterations:      ${final.iterationCount}\n`);
  stdout.write(`complexity:      time=${final.timeComplexity ?? "-"} space=${final.spaceComplexity ?? "-"}\n`);
  stdout.write("\n=== generated code ===\n");
  stdout.write((final.generatedCode ?? "(none)") + "\n");

  exit(final.currentTestCoverage >= final.targetTestCoverage ? 0 : 3);
}

main().catch((err) => {
  console.error("nri failed:", err instanceof Error ? err.message : err);
  exit(1);
});
