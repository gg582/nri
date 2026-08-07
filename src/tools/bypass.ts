/**
 * Fail-closed early-exit routing for demonstrably simple repository changes.
 * The caller supplies the existing decision-graph and quick-patch mechanisms;
 * this module guarantees that the latter is unreachable until all gates pass.
 */

export type SimpleChangeClassification =
  | "style"
  | "regex-cleanup"
  | "convention-unification"
  | "equivalent-trivial"
  | "ineligible";

export interface ChangeRequest {
  readonly summary: string;
  readonly files?: readonly string[];
  readonly classificationHint?: Exclude<SimpleChangeClassification, "ineligible">;
  /** Required for the deliberately narrow equivalent-trivial category. */
  readonly equivalentComplexityEvidence?: boolean;
}

export interface ExecutionStep {
  readonly id: string;
  readonly description: string;
  readonly files?: readonly string[];
}

export interface TaskGroup {
  readonly id: "simple-change-group";
  readonly steps: readonly ExecutionStep[];
}

export interface ComponentAssessment {
  readonly stepId: string;
  /** Integer score: lower values represent lower complexity. */
  readonly score: number;
  readonly factors?: Readonly<Record<string, number>>;
}

export interface GroupAssessment {
  /** Integer score: lower values represent lower complexity. */
  readonly score: number;
  readonly factors?: Readonly<Record<string, number>>;
}

export interface BypassThresholds {
  readonly maximumComponentScore: number;
  readonly maximumGroupScore: number;
}

export const DEFAULT_BYPASS_THRESHOLDS: BypassThresholds = {
  maximumComponentScore: 3,
  maximumGroupScore: 6,
};

export interface BypassDecision {
  readonly classification: SimpleChangeClassification;
  readonly eligibleClassification: boolean;
  readonly group: TaskGroup;
  readonly componentAssessments: readonly ComponentAssessment[];
  readonly groupAssessment: GroupAssessment;
  readonly approved: boolean;
  readonly rejectionReasons: readonly string[];
}

export interface QuickPatch<Result> {
  readonly diff: string;
  readonly apply: () => Promise<Result>;
}

export interface BypassDependencies<FullResult, PatchResult> {
  /** Identifies every required operation before routing is considered. */
  readonly identifySteps: (request: ChangeRequest) => Promise<readonly ExecutionStep[]>;
  /** Scores every step, including verification-only steps. */
  readonly scoreComponent: (
    step: ExecutionStep,
    request: ChangeRequest,
    group: TaskGroup,
  ) => Promise<ComponentAssessment>;
  /** Scores the complete, single task group after all component scores exist. */
  readonly scoreGroup: (
    group: TaskGroup,
    components: readonly ComponentAssessment[],
    request: ChangeRequest,
  ) => Promise<GroupAssessment>;
  /** Existing quick diff generator and patch applier. Called only after approval. */
  readonly createQuickPatch: (
    request: ChangeRequest,
    decision: BypassDecision,
  ) => Promise<QuickPatch<PatchResult> | null | undefined>;
  /** Existing normal decision-graph entry point. */
  readonly runFullDecisionGraph: (
    request: ChangeRequest,
    context: { readonly decision?: BypassDecision; readonly rejectionReasons: readonly string[] },
  ) => Promise<FullResult>;
  readonly thresholds?: BypassThresholds;
  readonly classify?: (request: ChangeRequest) => SimpleChangeClassification;
}

export type BypassRoute<FullResult, PatchResult> =
  | {
      readonly route: "quick-patch";
      readonly result: PatchResult;
      readonly decision: BypassDecision;
    }
  | {
      readonly route: "full-decision-graph";
      readonly result: FullResult;
      readonly decision?: BypassDecision;
      readonly rejectionReasons: readonly string[];
    };

const EXCLUDED_REQUEST_PATTERN =
  /\b(api|schema|config(?:uration)?|security|auth(?:entication|orization)?|dependenc(?:y|ies)|upgrade|migration|database|binary|generated|behavior(?:al)?|semantic|multi[- ]purpose)\b/i;
const STYLE_PATTERN =
  /\b(style|format(?:ting)?|indent(?:ation)?|lint|whitespace|comment[- ]only)\b/i;
const REGEX_PATTERN =
  /\b(regex|regular expression|character class|escaping|escape sequence)\b/i;
const CONVENTION_PATTERN =
  /\b(convention|consistent naming|naming convention|unif(?:y|ication)|standardi[sz]e)\b/i;

/**
 * Conservative text classification. Callers with richer repository evidence
 * may supply a stricter classifier through BypassDependencies.classify.
 */
export function classifySimpleChange(request: ChangeRequest): SimpleChangeClassification {
  const text = request.summary.trim();
  if (!text || EXCLUDED_REQUEST_PATTERN.test(text)) return "ineligible";

  if (request.classificationHint === "equivalent-trivial") {
    return request.equivalentComplexityEvidence ? "equivalent-trivial" : "ineligible";
  }
  if (request.classificationHint) return request.classificationHint;

  if (STYLE_PATTERN.test(text)) return "style";
  if (REGEX_PATTERN.test(text)) return "regex-cleanup";
  if (CONVENTION_PATTERN.test(text)) return "convention-unification";
  return "ineligible";
}

function isValidIntegerScore(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the linear pre-routing workflow. The full graph is called exactly once
 * for every rejection or quick-patch-path failure, and never after success.
 */
export async function runGatedSimpleChange<FullResult, PatchResult>(
  request: ChangeRequest,
  dependencies: BypassDependencies<FullResult, PatchResult>,
): Promise<BypassRoute<FullResult, PatchResult>> {
  const classification = (dependencies.classify ?? classifySimpleChange)(request);
  const eligibleClassification = classification !== "ineligible";
  const thresholds = dependencies.thresholds ?? DEFAULT_BYPASS_THRESHOLDS;

  const fallback = async (
    rejectionReasons: readonly string[],
    decision?: BypassDecision,
  ): Promise<BypassRoute<FullResult, PatchResult>> => ({
    route: "full-decision-graph",
    result: await dependencies.runFullDecisionGraph(request, { decision, rejectionReasons }),
    decision,
    rejectionReasons,
  });

  if (
    !isValidIntegerScore(thresholds.maximumComponentScore) ||
    !isValidIntegerScore(thresholds.maximumGroupScore)
  ) {
    return fallback(["Invalid bypass score thresholds."]);
  }

  let steps: readonly ExecutionStep[];
  try {
    // This deliberately happens before eligibility-based routing.
    steps = await dependencies.identifySteps(request);
  } catch (error) {
    return fallback([`Unable to identify all execution steps: ${asErrorMessage(error)}`]);
  }

  if (!steps.length || steps.some((step) => !step.id || !step.description)) {
    return fallback(["Execution-step identification was incomplete."]);
  }

  const group: TaskGroup = { id: "simple-change-group", steps };
  let componentAssessments: readonly ComponentAssessment[];
  let groupAssessment: GroupAssessment;

  try {
    componentAssessments = await Promise.all(
      steps.map((step) => dependencies.scoreComponent(step, request, group)),
    );
    groupAssessment = await dependencies.scoreGroup(group, componentAssessments, request);
  } catch (error) {
    return fallback([`Simplicity assessment failed: ${asErrorMessage(error)}`]);
  }

  const rejectionReasons: string[] = [];
  if (!eligibleClassification) rejectionReasons.push("Change classification is not eligible for bypass.");
  if (componentAssessments.length !== steps.length) {
    rejectionReasons.push("Not every execution component was assessed.");
  }

  for (const assessment of componentAssessments) {
    if (!steps.some((step) => step.id === assessment.stepId)) {
      rejectionReasons.push(`Assessment references unknown step '${assessment.stepId}'.`);
    } else if (!isValidIntegerScore(assessment.score)) {
      rejectionReasons.push(`Step '${assessment.stepId}' has an invalid complexity score.`);
    } else if (assessment.score > thresholds.maximumComponentScore) {
      rejectionReasons.push(
        `Step '${assessment.stepId}' exceeds component threshold (${assessment.score} > ${thresholds.maximumComponentScore}).`,
      );
    }
  }

  if (!isValidIntegerScore(groupAssessment.score)) {
    rejectionReasons.push("Task group has an invalid complexity score.");
  } else if (groupAssessment.score > thresholds.maximumGroupScore) {
    rejectionReasons.push(
      `Task group exceeds group threshold (${groupAssessment.score} > ${thresholds.maximumGroupScore}).`,
    );
  }

  const decision: BypassDecision = {
    classification,
    eligibleClassification,
    group,
    componentAssessments,
    groupAssessment,
    approved: rejectionReasons.length === 0,
    rejectionReasons,
  };

  if (!decision.approved) return fallback(rejectionReasons, decision);

  try {
    const patch = await dependencies.createQuickPatch(request, decision);
    if (!patch || !patch.diff.trim()) {
      return fallback(["Quick diff-patch generation was unavailable."], decision);
    }
    return { route: "quick-patch", result: await patch.apply(), decision };
  } catch (error) {
    return fallback([`Quick diff-patch application failed: ${asErrorMessage(error)}`], decision);
  }
}
