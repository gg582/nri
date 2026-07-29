import { z } from "zod";
import type { LLMProviderStrategy } from "../providers/base.js";
import {
  type AbstractGraph,
  type AgentStateType,
  type ProposalGraph,
  type TaskNode,
} from "../state.js";
import { COMPACT_SYSTEM } from "../prompts.js";

type State = AgentStateType;

const CompactResultSchema = z.object({
  summary: z.string(),
  key_decisions: z.array(z.string()),
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

/** Cap for free-text fields when deterministically shrinking graph structures. */
const FREE_TEXT_CAP = 280;

function clip(text: string): string {
  return text.length > FREE_TEXT_CAP ? `${text.slice(0, FREE_TEXT_CAP - 1)}…` : text;
}

function clipTaskTree(node: TaskNode): TaskNode {
  return { ...node, task_description: clip(node.task_description), children: node.children.map(clipTaskTree) };
}

function clipAbstractGraph(graph: AbstractGraph): AbstractGraph {
  return {
    ...graph,
    linearization_notes: clip(graph.linearization_notes),
    primal_nodes: graph.primal_nodes.map((n) => ({
      ...n,
      responsibility: clip(n.responsibility),
      input_contract: clip(n.input_contract),
      output_contract: clip(n.output_contract),
    })),
  };
}

function clipProposals(proposals: ProposalGraph): ProposalGraph {
  return {
    selected_proposals: proposals.selected_proposals.map((p) => ({
      ...p,
      proposal: clip(p.proposal),
      reason_for_adoption: clip(p.reason_for_adoption),
    })),
  };
}

/**
 * /graph-compact — like /compact, and additionally shrinks the graph
 * structures DETERMINISTICALLY: only free-text fields are clipped to
 * FREE_TEXT_CAP chars while every task-tree node_id, abstract-graph primal
 * id and edge, and proposal node_id is preserved by construction (the LLM
 * never sees the structures, so reference integrity cannot be violated).
 */
export async function graphCompactState(state: State, provider: LLMProviderStrategy): Promise<Partial<State>> {
  const base = await compactState(state, provider);
  return {
    ...base,
    taskTree: state.taskTree ? clipTaskTree(state.taskTree) : state.taskTree,
    abstractGraph: state.abstractGraph ? clipAbstractGraph(state.abstractGraph) : state.abstractGraph,
    proposalGraph: state.proposalGraph ? clipProposals(state.proposalGraph) : state.proposalGraph,
    trace: (base.trace ?? []).map((l) => l.replace("[compact]", "[graph-compact]")),
  };
}
