/**
 * Deterministic early-exit evaluation for narrowly scoped, non-semantic
 * maintenance changes. This module is intentionally independent of provider
 * and graph implementations so the active linear decision pipeline can call
 * runBypassPipeline exactly once before invoking its existing full graph.
 */

export type SimpleChangeCategory =
  | "style-improvement"
  | "regex-character-cleanup"
  | "convention-unification"
  | "equivalent-trivial-edit";

export type IneligibleCategory =
  | "semantic-behavior-change"
  | "api-change"
  | "schema-change"
  | "dependency-change"
  | "multi-area-change"
  | "ambiguous"
  | "unrecognized";

export type ChangeCategory = SimpleChangeCategory | IneligibleCategory;

export interface NormalizedTransformation {
  readonly file: string;
  readonly description: string;
  readonly type: "format" | "rename-convention" | "regex-character" | "text-replacement";
  readonly estimatedChangedLines: number;
  readonly risk: "low" | "medium" | "high";
}

export interface NormalizedChangeRequest {
  readonly id: string;
  readonly category: ChangeCategory;
  readonly summary: string;
  readonly files: readonly string[];
  readonly transformations: readonly NormalizedTransformation[];
  /** An empty array is valid when no verification beyond patch application is required. */
  readonly verification: readonly string[];
  readonly areas?: readonly string[];
}

export interface SimplicityPolicy {
  readonly eligibleCategories: readonly SimpleChangeCategory[];
  readonly equivalentTrivialCategories: readonly string[];
  readonly componentMinimumScore: number;
  readonly groupMinimumScore: number;
  readonly maximumComponentFiles: number;
  readonly maximumComponentLines: number;
  readonly maximumGroupFiles: number;
  readonly maximumGroupLines: number;
  readonly maximumComponents: number;
  readonly componentPenalty: {
    readonly file: number;
    readonly line: number;
    readonly mediumRisk: number;
    readonly highRisk: number;
    readonly textReplacement: number;
  };
  readonly groupPenalty: {
    readonly component: number;
    readonly file: number;
    readonly line: number;
    readonly crossArea: number;
    readonly mediumRiskComponent: number;
    readonly highRiskComponent: number;
  };
}

export const DEFAULT_SIMPLICITY_POLICY: SimplicityPolicy = Object.freeze({
  eligibleCategories: [
    "style-improvement",
    "regex-character-cleanup",
    "convention-unification",
    "equivalent-trivial-edit",
  ] as SimpleChangeCategory[],
  equivalentTrivialCategories: [],
  componentMinimumScore: 80,
  groupMinimumScore: 80,
  maximumComponentFiles: 1,
  maximumComponentLines: 20,
  maximumGroupFiles: 3,
  maximumGroupLines: 40,
  maximumComponents: 5,
  componentPenalty: Object.freeze({
    file: 5,
    line: 1,
    mediumRisk: 15,
    highRisk: 45,
    textReplacement: 8,
  }),
  groupPenalty: Object.freeze({
    component: 3,
    file: 4,
    line: 1,
    crossArea: 15,
    mediumRiskComponent: 8,
    highRiskComponent: 30,
  }),
});

/** Compatibility adapter for the lightweight simple-change command. */
export function decide(
  detected: { isSimple: boolean },
  scores: { groupIsSimple: boolean },
): "quick-diff-patch" | "full-decision-graph" {
  return detected.isSimple && scores.groupIsSimple ? "quick-diff-patch" : "full-decision-graph";
}

export interface ChangeClassification {
  readonly eligible: boolean;
  readonly category: ChangeCategory;
  readonly evidence: readonly string[];
  readonly rejectionReasons: readonly string[];
}

export interface ExecutionStep {
  readonly id: string;
  readonly file: string;
  readonly transformation: NormalizedTransformation;
  readonly verification: readonly string[];
}

export interface StepIdentification {
  readonly identifiable: boolean;
  readonly steps: readonly ExecutionStep[];
  readonly rejectionReasons: readonly string[];
}

export interface TaskGroup {
  readonly id: string;
  readonly changeRequestId: string;
  readonly steps: readonly ExecutionStep[];
}

export interface ComponentAssessment {
  readonly stepId: string;
  readonly factors: Readonly<Record<string, number | string>>;
  readonly score: number;
  readonly threshold: number;
  readonly passed: boolean;
}

export interface GroupAssessment {
  readonly factors: Readonly<Record<string, number | string>>;
  readonly score: number;
  readonly threshold: number;
  readonly passed: boolean;
}

export interface QuantitativeAssessment {
  readonly components: readonly ComponentAssessment[];
  readonly group: GroupAssessment;
  readonly approved: boolean;
  readonly rejectionReasons: readonly string[];
}

export interface BypassEvaluation {
  readonly classification: ChangeClassification;
  readonly stepIdentification: StepIdentification;
  readonly taskGroup?: TaskGroup;
  readonly assessment?: QuantitativeAssessment;
  readonly approved: boolean;
  readonly reason: string;
}

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const unique = (values: readonly string[]): string[] => Array.from(new Set(values));

const isEligibleCategory = (
  category: ChangeCategory,
  policy: SimplicityPolicy,
): category is SimpleChangeCategory =>
  (policy.eligibleCategories as readonly string[]).includes(category) ||
  policy.equivalentTrivialCategories.includes(category);

export function classifySimpleChange(
  request: NormalizedChangeRequest,
  policy: SimplicityPolicy = DEFAULT_SIMPLICITY_POLICY,
): ChangeClassification {
  const rejectionReasons: string[] = [];
  const evidence = ["category=" + request.category, "files=" + request.files.length];

  if (!request.id.trim()) rejectionReasons.push("missing-change-request-id");
  if (!request.summary.trim()) rejectionReasons.push("missing-change-summary");
  if (!isEligibleCategory(request.category, policy)) {
    rejectionReasons.push("ineligible-category:" + request.category);
  }
  if ((request.areas && unique(request.areas).length > 1) || request.category === "multi-area-change") {
    rejectionReasons.push("multi-area-change");
  }
  if (request.category === "ambiguous") rejectionReasons.push("ambiguous-change-request");
  if (request.category === "semantic-behavior-change") rejectionReasons.push("semantic-change");
  if (request.category === "api-change" || request.category === "schema-change") {
    rejectionReasons.push("public-contract-change");
  }
  if (request.category === "dependency-change") rejectionReasons.push("dependency-change");

  return Object.freeze({
    eligible: rejectionReasons.length === 0,
    category: request.category,
    evidence: Object.freeze(evidence),
    rejectionReasons: Object.freeze(unique(rejectionReasons)),
  });
}

export function identifyExecutionSteps(request: NormalizedChangeRequest): StepIdentification {
  const rejectionReasons: string[] = [];
  const knownFiles = new Set(request.files.filter((file) => file.trim().length > 0));

  if (knownFiles.size === 0) rejectionReasons.push("no-files-identified");
  if (request.transformations.length === 0) rejectionReasons.push("no-transformations-identified");
  if (!Array.isArray(request.verification) || request.verification.some((item) => !item.trim())) {
    rejectionReasons.push("verification-requirements-not-identifiable");
  }

  const steps: ExecutionStep[] = [];
  request.transformations.forEach((transformation, index) => {
    if (!transformation.file.trim() || !knownFiles.has(transformation.file)) {
      rejectionReasons.push("transformation-file-not-identified:" + index);
      return;
    }
    if (!transformation.description.trim()) {
      rejectionReasons.push("transformation-description-not-identified:" + index);
      return;
    }
    if (!Number.isFinite(transformation.estimatedChangedLines) || transformation.estimatedChangedLines < 0) {
      rejectionReasons.push("transformation-line-estimate-not-identifiable:" + index);
      return;
    }
    steps.push(Object.freeze({
      id: request.id + ":step:" + (index + 1),
      file: transformation.file,
      transformation,
      verification: Object.freeze([...request.verification]),
    }));
  });

  if (steps.length !== request.transformations.length) rejectionReasons.push("incomplete-execution-plan");

  return Object.freeze({
    identifiable: rejectionReasons.length === 0 && steps.length > 0,
    steps: Object.freeze(steps),
    rejectionReasons: Object.freeze(unique(rejectionReasons)),
  });
}

export function createTaskGroup(
  request: NormalizedChangeRequest,
  stepIdentification: StepIdentification,
): TaskGroup | undefined {
  if (!stepIdentification.identifiable) return undefined;
  return Object.freeze({
    id: request.id + ":simple-change-group",
    changeRequestId: request.id,
    steps: stepIdentification.steps,
  });
}

export function assessTaskGroup(
  group: TaskGroup,
  policy: SimplicityPolicy = DEFAULT_SIMPLICITY_POLICY,
): QuantitativeAssessment {
  const components = group.steps.map((step): ComponentAssessment => {
    const transformation = step.transformation;
    const riskPenalty = transformation.risk === "high"
      ? policy.componentPenalty.highRisk
      : transformation.risk === "medium"
        ? policy.componentPenalty.mediumRisk
        : 0;
    const score = clampScore(
      100 -
        policy.componentPenalty.file -
        transformation.estimatedChangedLines * policy.componentPenalty.line -
        riskPenalty -
        (transformation.type === "text-replacement" ? policy.componentPenalty.textReplacement : 0),
    );
    const passed =
      score >= policy.componentMinimumScore &&
      transformation.estimatedChangedLines <= policy.maximumComponentLines &&
      policy.maximumComponentFiles >= 1;
    return Object.freeze({
      stepId: step.id,
      factors: Object.freeze({
        filesTouched: 1,
        linesChanged: transformation.estimatedChangedLines,
        transformationType: transformation.type,
        risk: transformation.risk,
      }),
      score,
      threshold: policy.componentMinimumScore,
      passed,
    });
  });

  const files = unique(group.steps.map((step) => step.file));
  const lines = group.steps.reduce((total, step) => total + step.transformation.estimatedChangedLines, 0);
  const areas = unique(files.map((file) => {
    const separator = file.indexOf("/");
    return separator === -1 ? "." : file.slice(0, separator);
  }));
  const mediumRiskComponents = group.steps.filter((step) => step.transformation.risk === "medium").length;
  const highRiskComponents = group.steps.filter((step) => step.transformation.risk === "high").length;
  const groupScore = clampScore(
    100 -
      group.steps.length * policy.groupPenalty.component -
      files.length * policy.groupPenalty.file -
      lines * policy.groupPenalty.line -
      (areas.length > 1 ? policy.groupPenalty.crossArea : 0) -
      mediumRiskComponents * policy.groupPenalty.mediumRiskComponent -
      highRiskComponents * policy.groupPenalty.highRiskComponent,
  );
  const groupPassed =
    groupScore >= policy.groupMinimumScore &&
    group.steps.length <= policy.maximumComponents &&
    files.length <= policy.maximumGroupFiles &&
    lines <= policy.maximumGroupLines;
  const groupAssessment: GroupAssessment = Object.freeze({
    factors: Object.freeze({
      componentCount: group.steps.length,
      filesTouched: files.length,
      linesChanged: lines,
      areasTouched: areas.length,
      mediumRiskComponents,
      highRiskComponents,
    }),
    score: groupScore,
    threshold: policy.groupMinimumScore,
    passed: groupPassed,
  });

  const rejectionReasons: string[] = [];
  components.filter((component) => !component.passed).forEach((component) => {
    rejectionReasons.push("component-threshold-failed:" + component.stepId);
  });
  if (!groupPassed) rejectionReasons.push("group-threshold-failed");

  return Object.freeze({
    components: Object.freeze(components),
    group: groupAssessment,
    approved: rejectionReasons.length === 0,
    rejectionReasons: Object.freeze(rejectionReasons),
  });
}

export function evaluateBypass(
  request: NormalizedChangeRequest,
  policy: SimplicityPolicy = DEFAULT_SIMPLICITY_POLICY,
): BypassEvaluation {
  const classification = classifySimpleChange(request, policy);
  if (!classification.eligible) {
    return Object.freeze({
      classification,
      stepIdentification: Object.freeze({ identifiable: false, steps: Object.freeze([]), rejectionReasons: classification.rejectionReasons }),
      approved: false,
      reason: classification.rejectionReasons.join(","),
    });
  }

  const stepIdentification = identifyExecutionSteps(request);
  if (!stepIdentification.identifiable) {
    return Object.freeze({
      classification,
      stepIdentification,
      approved: false,
      reason: stepIdentification.rejectionReasons.join(","),
    });
  }

  const taskGroup = createTaskGroup(request, stepIdentification)!;
  const assessment = assessTaskGroup(taskGroup, policy);
  return Object.freeze({
    classification,
    stepIdentification,
    taskGroup,
    assessment,
    approved: assessment.approved,
    reason: assessment.approved ? "approved-simple-change-bypass" : assessment.rejectionReasons.join(","),
  });
}

export interface QuickPatchExecutor<Patch> {
  generate(group: TaskGroup): Promise<Patch>;
  apply(patch: Patch): Promise<void>;
  verify(group: TaskGroup, patch: Patch): Promise<boolean>;
}

export type BypassRoute = "full-decision-graph" | "quick-diff-patch";
export type PatchExecutionStatus = "not-attempted" | "completed" | "failed";

export interface PipelineBypassResult<FullGraphResult> {
  readonly route: BypassRoute;
  readonly bypassedFullGraph: boolean;
  readonly reason: string;
  readonly evaluation: BypassEvaluation;
  readonly patchExecutionStatus: PatchExecutionStatus;
  readonly fullGraphResult?: FullGraphResult;
  readonly failure?: string;
  readonly provenance: "quantitative-simple-change-bypass" | "full-decision-graph";
}

/**
 * The selected linear pipeline entry point should invoke this function once.
 * Rejected candidates call the unchanged graph; approved candidates never do.
 */
export async function runBypassPipeline<Patch, FullGraphResult>(
  request: NormalizedChangeRequest,
  dependencies: {
    readonly runFullDecisionGraph: (request: NormalizedChangeRequest, bypass: BypassEvaluation) => Promise<FullGraphResult>;
    readonly quickPatch: QuickPatchExecutor<Patch>;
    readonly policy?: SimplicityPolicy;
  },
): Promise<PipelineBypassResult<FullGraphResult>> {
  const evaluation = evaluateBypass(request, dependencies.policy ?? DEFAULT_SIMPLICITY_POLICY);
  if (!evaluation.approved) {
    const fullGraphResult = await dependencies.runFullDecisionGraph(request, evaluation);
    return Object.freeze({
      route: "full-decision-graph",
      bypassedFullGraph: false,
      reason: evaluation.reason,
      evaluation,
      patchExecutionStatus: "not-attempted",
      fullGraphResult,
      provenance: "full-decision-graph",
    });
  }

  try {
    const patch = await dependencies.quickPatch.generate(evaluation.taskGroup!);
    await dependencies.quickPatch.apply(patch);
    const verified = await dependencies.quickPatch.verify(evaluation.taskGroup!, patch);
    if (!verified) {
      return Object.freeze({
        route: "quick-diff-patch",
        bypassedFullGraph: true,
        reason: "quick-patch-verification-failed",
        evaluation,
        patchExecutionStatus: "failed",
        failure: "Quick diff patch was applied but its expected resulting state could not be verified.",
        provenance: "quantitative-simple-change-bypass",
      });
    }
    return Object.freeze({
      route: "quick-diff-patch",
      bypassedFullGraph: true,
      reason: "quick-patch-completed",
      evaluation,
      patchExecutionStatus: "completed",
      provenance: "quantitative-simple-change-bypass",
    });
  } catch (error) {
    return Object.freeze({
      route: "quick-diff-patch",
      bypassedFullGraph: true,
      reason: "quick-patch-failed",
      evaluation,
      patchExecutionStatus: "failed",
      failure: error instanceof Error ? error.message : String(error),
      provenance: "quantitative-simple-change-bypass",
    });
  }
}
