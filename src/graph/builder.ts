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
  makeFinalizeNode,
  makeImplementNode,
  makeNormalizeNode,
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
export interface BuildGraphOptions {
  /** Extra nodes to interrupt before (in addition to human_approval). */
  interruptBefore?: string[];
}

export function buildGraph(deps: GraphDeps, opts?: BuildGraphOptions) {
  const { testRunner } = deps;
  const forNode = (node: string): NodeDeps => ({
    provider: deps.resolveProvider(node),
    testRunner,
  });
  const graph = new StateGraph(AgentState)
    .addNode("normalize", makeNormalizeNode(forNode("normalize")))
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
    .addNode("finalize", makeFinalizeNode(forNode("finalize")))
    .addEdge(START, "normalize")
    .addEdge("normalize", "triage")
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
      finalize: "finalize",
    })
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
