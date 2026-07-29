import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { AgentState, type AgentStateType, type ProposalGraph } from "../state.js";
import type { LLMProviderStrategy } from "../providers/base.js";
import type { TestRunner } from "../tools/testRunner.js";
import {
  makeAbstractGraphNode,
  makeBusinessContextNode,
  makeDecomposeNode,
  makeDocsNode,
  makeEvaluationNode,
  makeFastPatchNode,
  makeFinalizeNode,
  makeImplementNode,
  makeNormalizeNode,
  makePreFlightNode,
  makeProposalNode,
  makeTestRunnerNode,
  makeTriageNode,
  makeVisualNode,
  routeAfterPreFlight,
  routeAfterTests,
  routeAfterTriage,
  routeAfterVisual,
  type NodeDeps,
} from "./nodes.js";
import type { ParsedChangeRequest, DetectedSimpleChange, TaskGroup as SimpleTaskGroup, SimplicityScores, ExecutionPath, ExecutionResult, CommitResult } from "./nodes.js";
import { ingest } from "../tools/ingest.js";
import { detect } from "../tools/detect.js";
import { plan as planSimpleChange } from "../tools/plan.js";
import { score } from "../tools/score.js";
import { decide } from "../tools/decide.js";
import { execute } from "../tools/execute.js";
import { finalize } from "../tools/finalize.js";

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
 *   triage ─┬─ FAST:  fast_patch ───────────────────────────► test_runner
 *           └─ HEAVY: business_context -> decompose ->
 *                     abstract_graph -> proposal -> human_approval ->
 *                     pre_flight ──valid──► implement -> evaluate -> test_runner
 *                               invalid -> re-plan (max 3 attempts)
 *   test_runner -> coverage >= target ? visual -> docs? -> finalize -> END
 *                  else loop (fast_patch | decompose)
 *
 * FAST is deliberately slim (patch -> verify): the business-context and
 * pre-flight audit chain is reserved for HEAVY work, and documentation is
 * generated only when the request asks for it.
 */
export interface BuildGraphOptions {
  /** Extra nodes to interrupt before (in addition to human_approval). */
  interruptBefore?: string[];
  /** Liveness hooks fired around every node execution (UI progress display). */
  hooks?: {
    onNodeStart?: (node: string) => void;
    onNodeEnd?: (node: string) => void;
    /** Mid-node live line (e.g. streamed file writes). */
    onTrace?: (node: string, line: string) => void;
  };
}

export function buildGraph(deps: GraphDeps, opts?: BuildGraphOptions) {
  const { testRunner } = deps;
  const forNode = (node: string): NodeDeps => ({
    provider: deps.resolveProvider(node),
    testRunner,
    emit: opts?.hooks?.onTrace ? (line) => opts.hooks!.onTrace!(node, line) : undefined,
  });
  type NodeFn = (state: AgentStateType) => Promise<Partial<AgentStateType>>;
  const wrap = (name: string, fn: NodeFn): NodeFn => {
    return async (state) => {
      const started = Date.now();
      opts?.hooks?.onNodeStart?.(name);
      try {
        const update = await fn(state);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        // Per-node timing in the trace: the only way to attribute a long run
        // (e.g. "proposal running 806s") to a specific stage after the fact.
        return { ...update, trace: [...(update.trace ?? []), `[timing] ${name} ${elapsed}s`] };
      } finally {
        opts?.hooks?.onNodeEnd?.(name);
      }
    };
  };
  const graph = new StateGraph(AgentState)
    .addNode("normalize", wrap("normalize", makeNormalizeNode(forNode("normalize"))))
    .addNode("triage", wrap("triage", makeTriageNode(forNode("triage"))))
    .addNode("business_context", wrap("business_context", makeBusinessContextNode(forNode("business_context"))))
    .addNode("fast_patch", wrap("fast_patch", makeFastPatchNode(forNode("fast_patch"))))
    .addNode("decompose", wrap("decompose", makeDecomposeNode(forNode("decompose"))))
    .addNode("abstract_graph", wrap("abstract_graph", makeAbstractGraphNode(forNode("abstract_graph"))))
    .addNode("proposal", wrap("proposal", makeProposalNode(forNode("proposal"))))
    .addNode(
      "human_approval",
      wrap("human_approval", async () => ({ trace: ["[hitl] proposal graph approved"] })),
    )
    .addNode("pre_flight", wrap("pre_flight", makePreFlightNode(forNode("pre_flight"))))
    .addNode("implement", wrap("implement", makeImplementNode(forNode("implement"))))
    .addNode("evaluate", wrap("evaluate", makeEvaluationNode(forNode("evaluate"))))
    .addNode("test_runner", wrap("test_runner", makeTestRunnerNode(forNode("test_writer"))))
    .addNode("visual", wrap("visual", makeVisualNode(forNode("fast_patch"))))
    .addNode("docs", wrap("docs", makeDocsNode(forNode("test_writer"))))
    .addNode("finalize", wrap("finalize", makeFinalizeNode(forNode("finalize"))))
    .addEdge(START, "normalize")
    .addEdge("normalize", "triage")
    .addConditionalEdges("triage", routeAfterTriage, {
      fast_patch: "fast_patch",
      business_context: "business_context",
    })
    .addEdge("business_context", "decompose")
    .addEdge("fast_patch", "test_runner")
    .addEdge("decompose", "abstract_graph")
    .addEdge("abstract_graph", "proposal")
    .addEdge("proposal", "human_approval")
    .addEdge("human_approval", "pre_flight")
    .addConditionalEdges("pre_flight", routeAfterPreFlight, {
      implement: "implement",
      decompose: "decompose",
      __end__: END,
    })
    .addEdge("implement", "evaluate")
    .addEdge("evaluate", "test_runner")
    .addConditionalEdges("test_runner", routeAfterTests, {
      fast_patch: "fast_patch",
      decompose: "decompose",
      visual: "visual",
      docs: "docs",
      finalize: "finalize",
    })
    .addConditionalEdges("visual", routeAfterVisual, {
      docs: "docs",
      finalize: "finalize",
    })
    .addEdge("docs", "finalize")
    .addEdge("finalize", END);

  const checkpointer = new MemorySaver();
  const interruptBefore = [...new Set(["human_approval", ...(opts?.interruptBefore ?? [])])];
  // LangGraph types interruptBefore as a union of node-name literals; our
  // names are valid but computed, hence the single cast.
  return graph.compile({ checkpointer, interruptBefore: interruptBefore as never });
}

export interface NriRunInput {
  request: string;
  targetTestCoverage: number;
  maxIterations?: number;
  threadId?: string;
  /** Final-output locale (resolved by caller; default en-US). */
  locale?: string;
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
      rawRequest: input.request,
      outputLocale: input.locale ?? "en-US",
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

/** Isolated deterministic workflow retained for narrowly-scoped maintenance work. */
export function buildSimpleChangeBypassGraph(): { run(rawRequest: string): Promise<{ commitHash: string; pushed: boolean }> } {
  return { async run(rawRequest) {
    const parsed: ParsedChangeRequest = await ingest(rawRequest);
    const detected: DetectedSimpleChange = detect(parsed);
    const taskGroup: SimpleTaskGroup = planSimpleChange(parsed, detected);
    const scores: SimplicityScores = score(taskGroup);
    const path: ExecutionPath = decide(detected, scores);
    const result: ExecutionResult = await execute(taskGroup, path);
    if (!result.success) throw new Error(`Simple change was not applied: ${result.errors.join(", ")}`);
    const commit: CommitResult = await finalize(result, parsed);
    return { commitHash: commit.commitHash, pushed: commit.pushed };
  }};
}
