/**
 * A deterministic, one-pass early-exit evaluator for narrowly scoped changes.
 * This module is intentionally independent from a particular command runner so
 * the active decision-tree entry point can supply its existing full-graph and
 * patch implementations through BypassDependencies.
 */

export type ChangeCategory =
  | "style"
  | "regex-character-cleanup"
  | "convention-unification"
  | "equivalent-trivial-edit"
  | "semantic"
  | "api"
  | "schema"
  | "dependency"
  | "multi-area"
  | "ambiguous"
  | "unknown";

export type TransformationKind =
  | "format"
  | "whitespace"
  | "rename-convention"
  | "regex-character"
  | "text-replacement"
  | "other";

export interface NormalizedChangeStep {
  readonly id: string;
  readonly file: string;
  readonly transformation: TransformationKind;
  readonly changedLines: number;
  readonly expectedState: string;
  /** An empty array is valid only when the caller explicitly determined none are required. */
  readonly verification: readonly string[];
}

export interface NormalizedChangeRequest {
  readonly id: string;
  readonly category: ChangeCategory;
  readonly summary: string;
  readonly steps?: readonly NormalizedChangeStep[];
  readonly semanticBehaviorChange?: boolean;
  readonly apiOrSchemaChange?: boolean;
  readonly dependencyChange?: boolean;
  readonly areas?: readonly string[];
}

export interface BypassPolicy {
  readonly eligibleCategories: readonly ChangeCategory[];
  readonly componentThreshold: number;
  readonly groupThreshold: number;
  readonly maximumFilesPerComponent: number;
  readonly maximumLinesPerComponent: number;
  readonly maximumComponents: number;
  readonly maximumFilesPerGroup: number;
  readonly maximumLinesPerGroup: number;
  readonly componentWeights: {
    readonly changedLines: number;
    readonly transformationRisk: number;
    readonly verificationScope: number;
  };
  readonly groupWeights: {
    readonly componentCount: number;
    readonly changedLines: number;
    readonly files: number;
    readonly crossModuleScope: number;
    readonly aggregateRisk: number;
  };
  readonly transformationRisk: Readonly<Record<TransformationKind, number>>;
}

export const DEFAULT_BYPASS_POLICY: BypassPolicy = Object.freeze({
  eligibleCategories: Object.freeze([
    "style",
    "regex-character-cleanup",
    "convention-unification",
    "equivalent-trivial-edit",
  ]),
  componentThreshold: 75,
  groupThreshold: 70,
  maximumFilesPerComponent: 1,
  maximumLinesPerComponent: 20,
  maximumComponents: 4,
  maximumFilesPerGroup: 4,
  maximumLinesPerGroup: 40,
  componentWeights: Object.freeze({
    changedLines: 1,
    transformationRisk: 1,
    verificationScope: 1,
  }),
  groupWeights: Object.freeze({
    componentCount: 1,
    changedLines: 1,
    files: 1,
    crossModuleScope: 1,
    aggregateRisk: 1,
  }),
  transformationRisk: Object.freeze({
    format: 0,
    whitespace: 0,
    "rename-convention": 10,
    "regex-character": 15,
    "text-replacement": 20,
    other: 100,
  }),
});

export interface ChangeClassification {
  readonly eligible: boolean;
  readonly category: ChangeCategory;
  readonly evidence: readonly string[];
  readonly rejectionReason?: string;
}

export interface StepIdentification {
  readonly identifiable: boolean;
  readonly steps: readonly NormalizedChangeStep[];
  readonly rejectionReason?: string;
}

export interface TaskGroup {
  readonly id: string;
  readonly requestId: string;
  readonly components: readonly NormalizedChangeStep[];
}

export interface ComponentAssessment {
  readonly stepId: string;
  readonly factors: {
    readonly filesTouched: number;
    readonly changedLines: number;
    readonly transformationRisk: number;
    readonly verificationScope: number;
  };
  readonly score: number;
  readonly threshold: number;
  readonly approved: boolean;
}

export interface GroupAssessment {
  readonly factors: {
    readonly componentCount: number;
    readonly changedLines: number;
    readonly filesTouched: number;
    readonly crossModuleScope: number;
    readonly aggregateRisk: number;
  };
  readonly score: number;
  readonly threshold: number;
  readonly approved: boolean;
}

export interface BypassAssessment {
  readonly classification: ChangeClassification;
  readonly stepIdentification: StepIdentification;
  readonly group?: TaskGroup;
  readonly components: readonly ComponentAssessment[];
  readonly groupAssessment?: GroupAssessment;
  readonly approved: boolean;
  readonly rejectionReasons: readonly string[];
}

const clampScore = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const hasPositiveInteger = (value: number): boolean => Number.isFinite(value) && value >= 0;

export function classifySimpleChange(
  request: NormalizedChangeRequest,
  policy: BypassPolicy = DEFAULT_BYPASS_POLICY,
): ChangeClassification {
  const evidence = [`category:${request.category}`];

  if (request.semanticBehaviorChange) {
    return { eligible: false, category: request.category, evidence, rejectionReason: "semantic-behavior-change" };
  }
  if (request.apiOrSchemaChange || request.category === "api" || request.category === "schema") {
    return { eligible: false, category: request.category, evidence, rejectionReason: "api-or-schema-change" };
  }
  if (request.dependencyChange || request.category === "dependency") {
    return { eligible: false, category: request.category, evidence, rejectionReason: "dependency-change" };
  }
  if (request.category === "multi-area" || (request.areas !== undefined && request.areas.length > 1)) {
    return { eligible: false, category: request.category, evidence, rejectionReason: "multi-area-change" };
  }
  if (request.category === "ambiguous" || request.category === "unknown") {
    return { eligible: false, category: request.category, evidence, rejectionReason: "ambiguous-or-unrecognized-category" };
  }
  if (!policy.eligibleCategories.includes(request.category)) {
    return { eligible: false, category: request.category, evidence, rejectionReason: "category-not-enabled-by-policy" };
  }

  evidence.push("eligible-category-configured");
  return { eligible: true, category: request.category, evidence };
}

export function identifyExecutionSteps(request: NormalizedChangeRequest): StepIdentification {
  if (request.steps === undefined || request.steps.length === 0) {
    return { identifiable: false, steps: [], rejectionReason: "no-concrete-execution-steps" };
  }

  for (const step of request.steps) {
    if (!step.id || !step.file || !step.expectedState || !hasPositiveInteger(step.changedLines)) {
      return { identifiable: false, steps: [], rejectionReason: "step-missing-file-transformation-or-expected-state" };
    }
    if (step.transformation === "other") {
      return { identifiable: false, steps: [], rejectionReason: "unsafe-or-unrecognized-transformation" };
    }
    if (!Array.isArray(step.verification)) {
      return { identifiable: false, steps: [], rejectionReason: "verification-requirements-not-identified" };
    }
  }

  return { identifiable: true, steps: Object.freeze([...request.steps]) };
}

export function createTaskGroup(requestId: string, steps: readonly NormalizedChangeStep[]): TaskGroup {
  return Object.freeze({
    id: `quick-bypass:${requestId}`,
    requestId,
    components: Object.freeze([...steps]),
  });
}

export function assessComponent(step: NormalizedChangeStep, policy: BypassPolicy): ComponentAssessment {
  const transformationRisk = policy.transformationRisk[step.transformation];
  const factors = Object.freeze({
    filesTouched: 1,
    changedLines: step.changedLines,
    transformationRisk,
    verificationScope: step.verification.length,
  });
  const score = clampScore(
    100
      - (step.changedLines / policy.maximumLinesPerComponent) * 35 * policy.componentWeights.changedLines
      - (transformationRisk / 100) * 40 * policy.componentWeights.transformationRisk
      - Math.min(step.verification.length, 5) * 5 * policy.componentWeights.verificationScope,
  );
  const approved = step.changedLines <= policy.maximumLinesPerComponent
    && 1 <= policy.maximumFilesPerComponent
    && score >= policy.componentThreshold;

  return Object.freeze({
    stepId: step.id,
    factors,
    score,
    threshold: policy.componentThreshold,
    approved,
  });
}

export function assessTaskGroup(group: TaskGroup, policy: BypassPolicy): GroupAssessment {
  const filesTouched = new Set(group.components.map((step) => step.file)).size;
  const changedLines = group.components.reduce((total, step) => total + step.changedLines, 0);
  const aggregateRisk = group.components.reduce(
    (total, step) => total + policy.transformationRisk[step.transformation],
    0,
  );
  const crossModuleScope = new Set(group.components.map((step) => step.file.split("/")[0] || step.file)).size;
  const factors = Object.freeze({
    componentCount: group.components.length,
    changedLines,
    filesTouched,
    crossModuleScope,
    aggregateRisk,
  });
  const score = clampScore(
    100
      - (group.components.length / policy.maximumComponents) * 20 * policy.groupWeights.componentCount
      - (changedLines / policy.maximumLinesPerGroup) * 30 * policy.groupWeights.changedLines
      - (filesTouched / policy.maximumFilesPerGroup) * 15 * policy.groupWeights.files
      - Math.max(0, crossModuleScope - 1) * 15 * policy.groupWeights.crossModuleScope
      - (aggregateRisk / Math.max(1, group.components.length * 100)) * 20 * policy.groupWeights.aggregateRisk,
  );
  const approved = group.components.length <= policy.maximumComponents
    && filesTouched <= policy.maximumFilesPerGroup
    && changedLines <= policy.maximumLinesPerGroup
    && score >= policy.groupThreshold;

  return Object.freeze({ factors, score, threshold: policy.groupThreshold, approved });
}

/** Evaluates all gates once. Callers must not re-run this after a patch failure. */
export function evaluateBypass(
  request: NormalizedChangeRequest,
  policy: BypassPolicy = DEFAULT_BYPASS_POLICY,
): BypassAssessment {
  const classification = classifySimpleChange(request, policy);
  if (!classification.eligible) {
    return Object.freeze({
      classification,
      stepIdentification: { identifiable: false, steps: [], rejectionReason: "classification-ineligible" },
      components: [],
      approved: false,
      rejectionReasons: Object.freeze([classification.rejectionReason as string]),
    });
  }

  const stepIdentification = identifyExecutionSteps(request);
  if (!stepIdentification.identifiable) {
    return Object.freeze({
      classification,
      stepIdentification,
      components: [],
      approved: false,
      rejectionReasons: Object.freeze([stepIdentification.rejectionReason as string]),
    });
  }

  const group = createTaskGroup(request.id, stepIdentification.steps);
  const components = Object.freeze(group.components.map((step) => assessComponent(step, policy)));
  const groupAssessment = assessTaskGroup(group, policy);
  const rejectionReasons = [
    ...components.filter((component) => !component.approved).map((component) => `component-threshold:${component.stepId}`),
    ...(groupAssessment.approved ? [] : ["group-threshold"]),
  ];

  return Object.freeze({
    classification,
    stepIdentification,
    group,
    components,
    groupAssessment,
    approved: rejectionReasons.length === 0,
    rejectionReasons: Object.freeze(rejectionReasons),
  });
}

export interface QuickPatch {
  readonly id: string;
  readonly diff: string;
}

export interface BypassDependencies<FullGraphResult> {
  readonly runFullDecisionGraph: (
    request: NormalizedChangeRequest,
    bypassAssessment: BypassAssessment,
  ) => Promise<FullGraphResult>;
  readonly generateQuickPatch: (group: TaskGroup) => Promise<QuickPatch>;
  readonly applyQuickPatch: (patch: QuickPatch) => Promise<boolean>;
  readonly verifyQuickPatch: (group: TaskGroup, patch: QuickPatch) => Promise<boolean>;
}

export type BypassRoute = "full-decision-graph" | "quick-diff-patch" | "failed-quick-diff-patch";
export type PatchExecutionStatus = "not-attempted" | "completed" | "generation-failed" | "application-failed" | "verification-failed";

export interface PipelineBypassResult<FullGraphResult> {
  readonly route: BypassRoute;
  readonly reason: string;
  readonly assessment: BypassAssessment;
  readonly patchExecutionStatus: PatchExecutionStatus;
  readonly provenance: "quantitative-quick-bypass" | "full-decision-graph";
  readonly fullGraphResult?: FullGraphResult;
  readonly patch?: QuickPatch;
}

/**
 * Active pipeline integration point: invoke this before the existing full graph.
 * Rejected candidates enter the existing graph exactly once. Patch failures are
 * terminal failed-bypass results and never report successful completion.
 */
export async function runDecisionPipeline<FullGraphResult>(
  request: NormalizedChangeRequest,
  dependencies: BypassDependencies<FullGraphResult>,
  policy: BypassPolicy = DEFAULT_BYPASS_POLICY,
): Promise<PipelineBypassResult<FullGraphResult>> {
  const assessment = evaluateBypass(request, policy);
  if (!assessment.approved || !assessment.group) {
    const fullGraphResult = await dependencies.runFullDecisionGraph(request, assessment);
    return {
      route: "full-decision-graph",
      reason: assessment.rejectionReasons.join(", ") || "bypass-not-approved",
      assessment,
      patchExecutionStatus: "not-attempted",
      provenance: "full-decision-graph",
      fullGraphResult,
    };
  }

  let patch: QuickPatch;
  try {
    patch = await dependencies.generateQuickPatch(assessment.group);
  } catch {
    return {
      route: "failed-quick-diff-patch",
      reason: "quick-patch-generation-failed",
      assessment,
      patchExecutionStatus: "generation-failed",
      provenance: "quantitative-quick-bypass",
    };
  }

  try {
    if (!(await dependencies.applyQuickPatch(patch))) {
      return {
        route: "failed-quick-diff-patch",
        reason: "quick-patch-application-failed",
        assessment,
        patchExecutionStatus: "application-failed",
        provenance: "quantitative-quick-bypass",
        patch,
      };
    }
  } catch {
    return {
      route: "failed-quick-diff-patch",
      reason: "quick-patch-application-failed",
      assessment,
      patchExecutionStatus: "application-failed",
      provenance: "quantitative-quick-bypass",
      patch,
    };
  }

  try {
    if (!(await dependencies.verifyQuickPatch(assessment.group, patch))) {
      return {
        route: "failed-quick-diff-patch",
        reason: "quick-patch-verification-failed",
        assessment,
        patchExecutionStatus: "verification-failed",
        provenance: "quantitative-quick-bypass",
        patch,
      };
    }
  } catch {
    return {
      route: "failed-quick-diff-patch",
      reason: "quick-patch-verification-failed",
      assessment,
      patchExecutionStatus: "verification-failed",
      provenance: "quantitative-quick-bypass",
      patch,
    };
  }

  return {
    route: "quick-diff-patch",
    reason: "all-classification-step-and-quantitative-gates-approved",
    assessment,
    patchExecutionStatus: "completed",
    provenance: "quantitative-quick-bypass",
    patch,
  };
}
