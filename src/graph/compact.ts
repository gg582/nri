import { z } from "zod";
import type { LLMProviderStrategy } from "../providers/base.js";
import {
  AbstractGraphSchema,
  ProposalGraphSchema,
  TaskNodeSchema,
  type AgentStateType,
} from "../state.js";
import { COMPACT_SYSTEM, GRAPH_COMPACT_SYSTEM } from "../prompts.js";

type State = AgentStateType;

const CompactResultSchema = z.object({
  summary: z.string(),
  key_decisions: z.array(z.string()),
});

const GraphCompactResultSchema = z.object({
  summary: z.string(),
  task_tree: TaskNodeSchema.nullable(),
  abstract_graph: AbstractGraphSchema.nullable(),
  proposals: ProposalGraphSchema.nullable(),
});

/**
 * /compact — compress run context (trace + free text) into a summary.
 * Graph structures are left untouched; only conversational bulk is folded.
 */
export async function compactState(state: State, provider: LLMProviderStrategy): Promise<Partial<State>> {
  const result = await provider.invokeJson(
    [
      { role: "system", content: COMPACT_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          { trace: state.trace, synthesis_question: state.synthesisQuestion, notes: state.generatedCode ? "code present" : null },
          null,
          2,
        ),
      },
    ],
    CompactResultSchema,
  );
  return {
    compactSummary: result.summary,
    trace: [`[compact] ${result.summary}`, ...state.trace.slice(-3)],
  };
}

function collectTreeIds(node: { node_id: string; children: unknown[] } | null, acc = new Set<string>()): Set<string> {
  if (!node) return acc;
  acc.add(node.node_id);
  for (const c of node.children as { node_id: string; children: unknown[] }[]) collectTreeIds(c, acc);
  return acc;
}

/**
 * /graph-compact — like /compact, but compresses WHILE preserving graph
 * reference integrity: every task-tree node_id, abstract-graph primal id and
 * edge, and proposal node_id must survive. The LLM may only shorten
 * free-text fields; structural identity is validated after the call and any
 * violation falls back to the original structure.
 */
export async function graphCompactState(state: State, provider: LLMProviderStrategy): Promise<Partial<State>> {
  const result = await provider.invokeJson(
    [
      { role: "system", content: GRAPH_COMPACT_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          {
            trace: state.trace,
            task_tree: state.taskTree,
            abstract_graph: state.abstractGraph,
            proposals: state.proposalGraph,
          },
          null,
          2,
        ),
      },
    ],
    GraphCompactResultSchema,
  );

  // --- reference-integrity validation ---
  const warnings: string[] = [];
  let taskTree = state.taskTree;
  if (result.task_tree && state.taskTree) {
    const before = collectTreeIds(state.taskTree);
    const after = collectTreeIds(result.task_tree);
    const missing = [...before].filter((id) => !after.has(id));
    if (missing.length === 0) taskTree = result.task_tree;
    else warnings.push(`task_tree ids lost (${missing.join(", ")}) — kept original`);
  }
  let abstractGraph = state.abstractGraph;
  if (result.abstract_graph && state.abstractGraph) {
    const idsBefore = new Set(state.abstractGraph.primal_nodes.map((n) => n.id));
    const edgesBefore = new Set(state.abstractGraph.edges.map((e) => `${e.from}->${e.to}`));
    const idsAfter = new Set(result.abstract_graph.primal_nodes.map((n) => n.id));
    const edgesAfter = new Set(result.abstract_graph.edges.map((e) => `${e.from}->${e.to}`));
    const missingIds = [...idsBefore].filter((i) => !idsAfter.has(i));
    const missingEdges = [...edgesBefore].filter((e) => !edgesAfter.has(e));
    if (missingIds.length === 0 && missingEdges.length === 0) abstractGraph = result.abstract_graph;
    else warnings.push(`abstract_graph refs lost (${[...missingIds, ...missingEdges].join(", ")}) — kept original`);
  }
  let proposalGraph = state.proposalGraph;
  if (result.proposals && state.proposalGraph) {
    const before = new Set(state.proposalGraph.selected_proposals.map((p) => p.node_id));
    const after = new Set(result.proposals.selected_proposals.map((p) => p.node_id));
    const missing = [...before].filter((id) => !after.has(id));
    if (missing.length === 0) proposalGraph = result.proposals;
    else warnings.push(`proposal node_ids lost (${missing.join(", ")}) — kept original`);
  }

  return {
    compactSummary: result.summary,
    taskTree,
    abstractGraph,
    proposalGraph,
    trace: [
      `[graph-compact] ${result.summary}`,
      ...warnings.map((w) => `[graph-compact][warn] ${w}`),
      ...state.trace.slice(-3),
    ],
  };
}
