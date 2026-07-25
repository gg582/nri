import type { LLMProviderStrategy, ChatMessage } from "../providers/base.js";
import { extractJson } from "../providers/base.js";
import { z } from "zod";
import type { TestRunner } from "../tools/testRunner.js";
import { writeFileBlocksNow } from "../tools/apply.js";
import { existingProjectFiles } from "../tools/layout.js";
import { IncrementalFileParser, type StreamedFile } from "../tools/streamApply.js";
import {
  AbstractGraphSchema,
  BusinessContextSchema,
  EvaluationResultSchema,
  ImplementationResultSchema,
  type ImplementationResult,
  NormalizedRequestSchema,
  PreFlightResultSchema,
  ProposalGraphSchema,
  TaskNodeSchema,
  TriageResultSchema,
  type AgentStateType,
} from "../state.js";
import { captureScreenshot, detectVisualTarget } from "../tools/visual.js";
import {
  ABSTRACT_GRAPH_SYSTEM,
  BUSINESS_CONTEXT_SYSTEM,
  DECOMPOSE_SYSTEM,
  DOCS_SYSTEM,
  EVALUATION_SYSTEM,
  FAST_PATCH_SYSTEM,
  FINALIZE_SYSTEM,
  IMPLEMENT_SYSTEM,
  NORMALIZE_SYSTEM,
  PRE_FLIGHT_SYSTEM,
  PROPOSAL_SYSTEM,
  TEST_WRITER_SYSTEM,
  TRIAGE_SYSTEM,
  VISUAL_CRITIQUE_SYSTEM,
} from "../prompts.js";

export interface NodeDeps {
  provider: LLMProviderStrategy;
  testRunner: TestRunner;
  /** Live mid-node line channel (streamed file writes); absent = trace only. */
  emit?: (line: string) => void;
}

type State = AgentStateType;
type Update = Partial<State>;

const businessContextBlock = (s: State) =>
  s.businessContext
    ? `\n\nDeclared business context:\n${JSON.stringify(s.businessContext, null, 2)}`
    : "";

/**
 * Anchor the model to the layout already on disk (session-written files plus
 * a bounded cwd scan) so it modifies existing files instead of inventing a
 * parallel directory tree.
 */
const layoutBlock = (s: State): string => {
  const all = [...new Set([...existingProjectFiles(), ...(s.appliedFiles ?? [])])];
  if (all.length === 0) return "";
  return (
    "\n\nExisting project files (modify THESE at their exact paths; never create " +
    "a duplicate copy of a file under another directory):\n" +
    all.slice(0, 60).join("\n")
  );
};

/**
 * Stream the implementation call when the provider supports it, writing each
 * file block to disk the moment it completes. Returns null when streaming is
 * unavailable or the streamed output fails validation — callers then fall
 * back to invokeJson. `lines` carries apply notes only when no live `emit`
 * channel exists (otherwise they were already pushed).
 */
async function streamImplementation(
  provider: LLMProviderStrategy,
  messages: ChatMessage[],
  emit: ((line: string) => void) | undefined,
): Promise<{ impl: ImplementationResult; written: string[]; lines: string[] } | null> {
  if (!provider.stream) return null;
  const parser = new IncrementalFileParser();
  const written: string[] = [];
  const lines: string[] = [];
  const note = (line: string) => (emit ? emit(line) : lines.push(line));
  const flush = async (files: StreamedFile[]): Promise<void> => {
    for (const f of files) {
      const res = await writeFileBlocksNow(`// ${f.path}\n${f.content}`);
      written.push(...res.written);
      for (const line of res.lines) note(line);
    }
  };
  try {
    let raw = "";
    for await (const delta of provider.stream(messages)) {
      raw += delta;
      await flush(parser.feed(delta));
    }
    await flush(parser.finish());
    const impl = ImplementationResultSchema.parse(JSON.parse(extractJson(raw)));
    // Canonical pass: catches any block the incremental parser missed.
    const res = await writeFileBlocksNow(impl.code);
    written.push(...res.written);
    for (const line of res.lines) note(line);
    return { impl, written, lines };
  } catch {
    return null;
  }
}

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

export function makeFastPatchNode({ provider, emit }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const feedback = state.preFlight?.violation_reason
      ? `\n\nPrevious attempt was rejected by pre-flight audit: ${state.preFlight.violation_reason}\nFix this.`
      : "";
    const testFeedback = state.lastTestOutput
      ? `\n\nLatest test/verification output:\n${state.lastTestOutput}\nFix the errors above.`
      : "";
    const messages: ChatMessage[] = [
      { role: "system", content: FAST_PATCH_SYSTEM },
      {
        role: "user",
        content:
          `Request:\n${state.currentRequest}${businessContextBlock(state)}${layoutBlock(state)}${feedback}${testFeedback}` +
          (state.generatedCode ? `\n\nCurrent code:\n${state.generatedCode}` : ""),
      },
    ];
    // Streamed path: files hit disk one by one as the model emits them.
    const streamed = await streamImplementation(provider, messages, emit);
    const impl = streamed?.impl ?? (await provider.invokeJson(messages, ImplementationResultSchema));
    const applied = streamed ?? (await writeFileBlocksNow(impl.code));
    return {
      generatedCode: impl.code,
      timeComplexity: impl.time_complexity,
      spaceComplexity: impl.space_complexity,
      preFlight: null,
      appliedFiles: applied.written,
      trace: [`[fast-patch] applied (${impl.notes})`, ...applied.lines],
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
    const feedback = state.preFlight?.violation_reason
      ? `\n\nPrevious plan was rejected by pre-flight audit: ${state.preFlight.violation_reason}\nAddress this in the new proposals.`
      : "";
    const proposals = await provider.invokeJson(
      [
        { role: "system", content: PROPOSAL_SYSTEM },
        {
          role: "user",
          content:
            `Abstract graph:\n${JSON.stringify(state.abstractGraph, null, 2)}` +
            `\n\nTask tree:\n${JSON.stringify(state.taskTree, null, 2)}` +
            businessContextBlock(state) +
            feedback,
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
    if (result.is_business_valid) {
      return {
        preFlight: result,
        preFlightAttempts: state.preFlightAttempts + 1,
        trace: ["[pre-flight] valid=true"],
      };
    }
    // Rejection means the request was underspecified: subdivide it ourselves
    // by folding the violation into the request, so the re-plan addresses it
    // instead of repeating the same plan. Incomplete termination is reserved
    // for genuine exhaustion (attempt guardrail in routeAfterPreFlight).
    const refinedRequest =
      `${state.currentRequest}\n\n` +
      `Additional requirements identified during plan review (must be addressed): ` +
      (result.violation_reason ?? "plan did not satisfy the declared business context");
    return {
      preFlight: result,
      preFlightAttempts: state.preFlightAttempts + 1,
      currentRequest: refinedRequest,
      trace: [
        `[pre-flight] valid=false — ${result.violation_reason ?? "unspecified violation"}`,
        "[pre-flight] request refined with the missing requirements; re-planning",
      ],
    };
  };
}

/* ---------------- HEAVY_PATH implementation (steps 8-9) ---------------- */

export function makeImplementNode({ provider, emit }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const messages: ChatMessage[] = [
      { role: "system", content: IMPLEMENT_SYSTEM },
      {
        role: "user",
        content:
          `Abstract graph:\n${JSON.stringify(state.abstractGraph, null, 2)}` +
          `\n\nAdopted proposals:\n${JSON.stringify(state.proposalGraph, null, 2)}` +
          businessContextBlock(state) +
          layoutBlock(state),
      },
    ];
    // Streamed path: files hit disk one by one as the model emits them —
    // later validation loops rewrite them in place, so the user watches the
    // implementation materialize.
    const streamed = await streamImplementation(provider, messages, emit);
    const impl = streamed?.impl ?? (await provider.invokeJson(messages, ImplementationResultSchema));
    const applied = streamed ?? (await writeFileBlocksNow(impl.code));
    return {
      generatedCode: impl.code,
      timeComplexity: impl.time_complexity,
      spaceComplexity: impl.space_complexity,
      appliedFiles: applied.written,
      trace: [`[implement] time=${impl.time_complexity} space=${impl.space_complexity}`, ...applied.lines],
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

const TestSpecSchema = z.object({
  test_code: z.string(),
  run_command: z.string().optional().nullable(),
  coverage_regex: z.string().optional().nullable(),
});

export function makeTestRunnerNode({ provider, testRunner }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    let testInput: string | { testCode: string; runCommand?: string; coverageRegex?: string | null } = "";
    try {
      const spec = await provider.invokeJson(
        [
          { role: "system", content: TEST_WRITER_SYSTEM },
          {
            role: "user",
            content: `Implementation:\n${state.generatedCode}${businessContextBlock(state)}`,
          },
        ],
        TestSpecSchema,
      );
      testInput = {
        testCode: spec.test_code,
        runCommand: spec.run_command ?? undefined,
        coverageRegex: spec.coverage_regex ?? undefined,
      };
    } catch {
      // Fallback if LLM responded with raw text test code
      const raw = await provider.invoke([
        { role: "system", content: TEST_WRITER_SYSTEM },
        {
          role: "user",
          content: `Implementation:\n${state.generatedCode}${businessContextBlock(state)}`,
        },
      ]);
      testInput = raw;
    }

    const result = await testRunner.run(state.generatedCode ?? "", testInput, state.iterationCount + 1);
    return {
      currentTestCoverage: result.coverage,
      iterationCount: state.iterationCount + 1,
      testUnevaluable: Boolean(result.unevaluable),
      lastTestOutput: result.passed ? "" : result.output.slice(0, 4000),
      trace: [
        `[test-runner] coverage=${result.coverage}% target=${state.targetTestCoverage}% passed=${result.passed}` +
          (result.unevaluable ? " (unevaluable — finalizing without loop)" : ""),
      ],
    };
  };
}

/* ---------------- Documentation (HEAVY_PATH only, separate from code gen) ---------------- */

const DocsResultSchema = z.object({ docs: z.string() });

export function makeDocsNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    const result = await provider.invokeJson(
      [
        { role: "system", content: DOCS_SYSTEM },
        {
          role: "user",
          content:
            `Request:\n${state.currentRequest}${businessContextBlock(state)}${layoutBlock(state)}` +
            `\n\nImplementation notes: time=${state.timeComplexity ?? "-"} space=${state.spaceComplexity ?? "-"}`,
        },
      ],
      DocsResultSchema,
    );
    const applied = await writeFileBlocksNow(result.docs);
    return {
      appliedFiles: applied.written,
      trace: ["[docs] wrote project documentation", ...applied.lines],
    };
  };
}

/* ---------------- Visual critique & loop (multimodal models only) ---------------- */

const VisualCritiqueSchema = z.object({
  ok: z.boolean(),
  issues: z.string(),
});

export function makeVisualNode({ provider }: NodeDeps) {
  return async (state: State): Promise<Update> => {
    if (!provider.invokeVision || !state.generatedCode) {
      return { trace: ["[visual] skipped (no multimodal provider or no code)"] };
    }
    const target = detectVisualTarget(state.generatedCode, state.currentRequest);
    if (!target) return { trace: ["[visual] skipped (no UI detected)"] };

    const shot = await captureScreenshot(target, state.generatedCode);
    if (!shot) return { trace: ["[visual] screenshot capture skipped or unsupported"] };

    try {
      const raw = await provider.invokeVision(VISUAL_CRITIQUE_SYSTEM, shot);
      const critique = VisualCritiqueSchema.parse(JSON.parse(extractJson(raw)));
      if (critique.ok || !critique.issues) {
        return { trace: ["[visual] UI critique passed"] };
      }
      return {
        currentRequest:
          `${state.currentRequest}\n\n[Visual UI Fix Needed]\n` +
          `A screenshot revealed the following visual/layout issues: ${critique.issues}. Fix them.`,
        trace: [`[visual] UI issues found: ${critique.issues}`],
      };
    } catch (err) {
      return { trace: [`[visual] critique failed: ${(err as Error).message}`] };
    }
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
): "fast_patch" | "test_runner" | "implement" | "decompose" | "__end__" {
  if (state.preFlight?.is_business_valid) {
    return state.selectedPath === "FAST_PATH" ? "test_runner" : "implement";
  }
  if (state.preFlightAttempts >= 3) return "__end__";
  // HEAVY: re-subdivide from the refined request (pre_flight folded the
  // violation into currentRequest) instead of re-proposing blindly.
  return state.selectedPath === "FAST_PATH" ? "fast_patch" : "decompose";
}

export function routeAfterTests(
  state: State,
): "fast_patch" | "decompose" | "visual" | "docs" | "finalize" {
  if (state.currentTestCoverage >= state.targetTestCoverage) {
    // Check visual quality if visual node is supported and applicable
    return "visual";
  }
  // No way to measure progress (missing toolchain/language) — re-patching
  // blind only wastes iterations; finalize with what we have.
  if (state.testUnevaluable) return "finalize";
  if (state.iterationCount >= state.maxIterations) return "finalize";
  return state.selectedPath === "FAST_PATH" ? "fast_patch" : "decompose";
}

export function routeAfterVisual(state: State): "docs" | "finalize" {
  return state.selectedPath === "HEAVY_PATH" ? "docs" : "finalize";
}

