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

export const NormalizedRequestSchema = z.object({
  canonical_request: z.string(),
  source_language: z.string(),
  notes: z.string(),
});
export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

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
  /** Untouched user input; normalize reads this, everything else uses the canonical form. */
  rawRequest: replace<string>(),
  /** Compact graph of completed REPL turns relevant to this request. */
  conversationContext: replace<string>(),
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

  /** Output of /compact or /graph-compact: dense summary of folded context. */
  compactSummary: replace<string>(),

  /** BCP-47-ish locale for the final user-facing output (default en-US). */
  outputLocale: Annotation<string>({ reducer: (_a, b) => b, default: () => "en-US" }),
  /** Localized final summary produced by the finalize node. */
  finalOutput: replace<string>(),

  iterationCount: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  maxIterations: Annotation<number>({ reducer: (_a, b) => b, default: () => 5 }),
  preFlightAttempts: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),

  /** Execution trace for observability. */
  trace: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  /** Repo-relative paths already written to disk during the run. */
  appliedFiles: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  /** True when the test runner could not evaluate the code (unknown language
   * or missing toolchain) — the loop must stop instead of re-patching blind. */
  testUnevaluable: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),

  /** Last verification output, fed back into the next patch attempt. */
  lastTestOutput: replace<string>(),

  /** Generated test spec, cached across loop iterations so the test writer
   * runs once per run instead of once per iteration. */
  testSpec: replace<{ test_code: string; run_command?: string | null; coverage_regex?: string | null } | null>(),

  /** Hashes of generated candidates in this run. Repeating a candidate after
   * a failed verification is a no-progress loop and must terminate safely. */
  implementationFingerprints: Annotation<string[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type AgentStateType = typeof AgentState.State;
