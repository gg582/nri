/**
 * The pre-graph simple-change gate.  This module intentionally has no file-system
 * or decision-graph dependencies: evaluation is pure and its caller supplies the
 * existing full-graph and safe-patch implementations.
 */

export type SimpleChangeCategory =
  | "style"
  | "regex-character-cleanup"
  | "convention-unification"
  | "equivalent-localized-change";

export type BypassDenialReason =
  | "unknown-classification"
  | "classification-not-simple"
  | "incomplete-step-discovery"
  | "missing-execution-steps"
  | "invalid-execution-step"
  | "forbidden-semantic-risk"
  | "component-threshold-exceeded"
  | "group-threshold-exceeded";

export interface ClassificationEvidence {
  /** A closed category; unrecognised categories never receive bypass approval. */
  readonly category: SimpleChangeCategory | string;
  /** The proposed edit is a textual/declarative replacement rather than new logic. */
  readonly declarative: boolean;
  /** Every affected target and replacement is bounded and known before routing. */
  readonly localized: boolean;
  /** The requester has established that matching/runtime intent is unchanged. */
  readonly behaviorPreserving: boolean;
  /** No API, schema, control-flow, dependency, or configuration-contract change. */
  readonly boundedPatch: boolean;
}

export type SemanticRiskFlag =
  | "api-change"
  | "schema-change"
  | "control-flow-change"
  | "dependency-change"
  | "configuration-contract-change"
  | "behavior-change"
  | "unknown";

export interface PatchEdit {
  /** Repository-relative path. Absolute paths and traversal paths are rejected. */
  readonly file: string;
  /** One-based inclusive line at which expectedText must occur. */
  readonly startLine: number;
  /** One-based inclusive end line; use startLine - 1 for an insertion. */
  readonly endLine: number;
  /** Exact old text, used as a patch precondition. */
  readonly expectedText: string;
  readonly replacementText: string;
}

export interface ExecutionStep {
  readonly id: string;
  readonly description: string;
  readonly edits: readonly PatchEdit[];
  readonly semanticRiskFlags?: readonly SemanticRiskFlag[];
  /** Required post-patch checks, for example formatter or targeted-test. */
  readonly validationActions?: readonly string[];
}

export interface SimpleChangeRequest {
  readonly id: string;
  readonly summary: string;
  readonly classification?: ClassificationEvidence;
  /** Must be true only once all concrete steps have been identified. */
  readonly discoveryComplete: boolean;
  readonly steps?: readonly ExecutionStep[];
}

export interface SimplicityMetrics {
  readonly files: number;
  readonly hunks: number;
  readonly changedLines: number;
  readonly semanticRisk: number;
  readonly validationActions: number;
}

export interface GroupSimplicityMetrics extends SimplicityMetrics {
  readonly steps: number;
}

/** Threshold equality passes; only values greater than these limits are denied. */
export const BYPASS_THRESHOLDS = {
  component: {
    files: 1,
    hunks: 3,
    changedLines: 12,
    semanticRisk: 0,
    validationActions: 2,
  },
  group: {
    files: 3,
    hunks: 6,
    changedLines: 24,
    semanticRisk: 0,
    validationActions: 3,
    steps: 3,
  },
} as const;

export interface ScoredStep {
  readonly step: ExecutionStep;
  readonly metrics: SimplicityMetrics;
}

export interface ApprovedTaskGroup {
  readonly id: string;
  readonly category: SimpleChangeCategory;
  readonly request: SimpleChangeRequest;
  readonly steps: readonly ScoredStep[];
  readonly metrics: GroupSimplicityMetrics;
  readonly thresholds: typeof BYPASS_THRESHOLDS;
}

export interface BypassApproved {
  readonly route: "quick-patch";
  readonly kind: "approved";
  readonly taskGroup: ApprovedTaskGroup;
}

export interface BypassDenied {
  readonly route: "full-graph";
  readonly kind: "denied";
  readonly reason: BypassDenialReason;
  /** This is the original object, not a normalized or copied request. */
  readonly request: SimpleChangeRequest;
  readonly metrics?: GroupSimplicityMetrics;
}

export type BypassDecision = BypassApproved | BypassDenied;

const CATEGORIES: ReadonlySet<string> = new Set<SimpleChangeCategory>([
  "style",
  "regex-character-cleanup",
  "convention-unification",
  "equivalent-localized-change",
]);

function lineCount(value: string): number {
  return value === "" ? 0 : value.split("\n").length;
}

function validPath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function metricsForStep(step: ExecutionStep): SimplicityMetrics {
  const files = new Set(step.edits.map((edit) => edit.file)).size;
  const changedLines = step.edits.reduce(
    (total, edit) => total + Math.max(lineCount(edit.expectedText), lineCount(edit.replacementText)),
    0,
  );
  return {
    files,
    hunks: step.edits.length,
    changedLines,
    semanticRisk: step.semanticRiskFlags?.length ?? 0,
    validationActions: step.validationActions?.length ?? 0,
  };
}

function exceedsComponent(metrics: SimplicityMetrics): boolean {
  const limit = BYPASS_THRESHOLDS.component;
  return metrics.files > limit.files || metrics.hunks > limit.hunks ||
    metrics.changedLines > limit.changedLines || metrics.semanticRisk > limit.semanticRisk ||
    metrics.validationActions > limit.validationActions;
}

function exceedsGroup(metrics: GroupSimplicityMetrics): boolean {
  const limit = BYPASS_THRESHOLDS.group;
  return metrics.files > limit.files || metrics.hunks > limit.hunks ||
    metrics.changedLines > limit.changedLines || metrics.semanticRisk > limit.semanticRisk ||
    metrics.validationActions > limit.validationActions || metrics.steps > limit.steps;
}

function isClassifiedSimple(request: SimpleChangeRequest): request is SimpleChangeRequest & {
  classification: ClassificationEvidence & { category: SimpleChangeCategory };
} {
  const evidence = request.classification;
  return Boolean(
    evidence && CATEGORIES.has(evidence.category) && evidence.declarative && evidence.localized &&
      evidence.behaviorPreserving && evidence.boundedPatch,
  );
}

function validStep(step: ExecutionStep): boolean {
  if (!step.id || !step.description || step.edits.length === 0 || (step.semanticRiskFlags?.length ?? 0) > 0) {
    return false;
  }
  return step.edits.every((edit) =>
    validPath(edit.file) && Number.isInteger(edit.startLine) && Number.isInteger(edit.endLine) &&
    edit.startLine > 0 && edit.endLine >= edit.startLine - 1 &&
    edit.expectedText !== edit.replacementText,
  );
}

function groupMetrics(scoredSteps: readonly ScoredStep[]): GroupSimplicityMetrics {
  const files = new Set<string>();
  let hunks = 0;
  let changedLines = 0;
  let semanticRisk = 0;
  let validationActions = 0;
  for (const scored of scoredSteps) {
    scored.step.edits.forEach((edit) => files.add(edit.file));
    hunks += scored.metrics.hunks;
    changedLines += scored.metrics.changedLines;
    semanticRisk += scored.metrics.semanticRisk;
    validationActions += scored.metrics.validationActions;
  }
  return { files: files.size, hunks, changedLines, semanticRisk, validationActions, steps: scoredSteps.length };
}

/** Pure, deterministic evaluation. It neither reads files nor invokes either route. */
export function evaluateSimpleChange(request: SimpleChangeRequest): BypassDecision {
  if (!request.classification || !CATEGORIES.has(request.classification.category)) {
    return { kind: "denied", route: "full-graph", reason: "unknown-classification", request };
  }
  if (!isClassifiedSimple(request)) {
    return { kind: "denied", route: "full-graph", reason: "classification-not-simple", request };
  }
  if (!request.discoveryComplete) {
    return { kind: "denied", route: "full-graph", reason: "incomplete-step-discovery", request };
  }
  if (!request.steps || request.steps.length === 0) {
    return { kind: "denied", route: "full-graph", reason: "missing-execution-steps", request };
  }
  if (!request.steps.every(validStep)) {
    const hasRisk = request.steps.some((step) => (step.semanticRiskFlags?.length ?? 0) > 0);
    return {
      kind: "denied",
      route: "full-graph",
      reason: hasRisk ? "forbidden-semantic-risk" : "invalid-execution-step",
      request,
    };
  }

  const scoredSteps = request.steps.map((step) => ({ step, metrics: metricsForStep(step) }));
  const metrics = groupMetrics(scoredSteps);
  if (scoredSteps.some((scored) => exceedsComponent(scored.metrics))) {
    return { kind: "denied", route: "full-graph", reason: "component-threshold-exceeded", request, metrics };
  }
  if (exceedsGroup(metrics)) {
    return { kind: "denied", route: "full-graph", reason: "group-threshold-exceeded", request, metrics };
  }

  return {
    kind: "approved",
    route: "quick-patch",
    taskGroup: {
      id: `simple-change:${request.id}`,
      category: request.classification.category,
      request,
      steps: scoredSteps,
      metrics,
      thresholds: BYPASS_THRESHOLDS,
    },
  };
}

export interface SafePatchWorkspace {
  /** Repository-safe patch application (normally backed by the project's patch tool). */
  applyUnifiedDiff(patch: string, allowedFiles: readonly string[]): Promise<void>;
}

export interface QuickPatchSuccess {
  readonly route: "quick-patch";
  readonly applied: true;
  readonly patch: string;
  readonly changedFiles: readonly string[];
  readonly hunkCount: number;
}

export interface QuickPatchFailure {
  readonly route: "quick-patch";
  readonly applied: false;
  readonly changedFiles: readonly string[];
  readonly diagnostics: string;
}

export type QuickPatchResult = QuickPatchSuccess | QuickPatchFailure;

function renderEdit(edit: PatchEdit): string {
  const oldLines = edit.expectedText === "" ? [] : edit.expectedText.split("\n");
  const newLines = edit.replacementText === "" ? [] : edit.replacementText.split("\n");
  const oldStart = edit.startLine;
  const newStart = edit.startLine;
  return [
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

/** Produces only hunks explicitly present in the approved, concrete task group. */
export function createMinimalUnifiedDiff(taskGroup: ApprovedTaskGroup): string {
  const byFile = new Map<string, PatchEdit[]>();
  for (const { step } of taskGroup.steps) {
    for (const edit of step.edits) {
      const edits = byFile.get(edit.file) ?? [];
      edits.push(edit);
      byFile.set(edit.file, edits);
    }
  }
  return [...byFile.entries()].map(([file, edits]) => [
    `--- a/${file}`,
    `+++ b/${file}`,
    ...edits.sort((left, right) => left.startLine - right.startLine).map(renderEdit),
  ].join("\n")).join("\n");
}

/** Re-evaluates forged/stale approvals before handing a patch to the workspace. */
export async function executeQuickPatch(
  taskGroup: ApprovedTaskGroup,
  workspace: SafePatchWorkspace,
): Promise<QuickPatchResult> {
  const rechecked = evaluateSimpleChange(taskGroup.request);
  if (rechecked.kind !== "approved") {
    return {
      route: "quick-patch",
      applied: false,
      changedFiles: [],
      diagnostics: `Approval is no longer valid: ${rechecked.reason}`,
    };
  }

  const checkedGroup = rechecked.taskGroup;
  const changedFiles = [...new Set(checkedGroup.steps.flatMap(({ step }) => step.edits.map((edit) => edit.file)))];
  const patch = createMinimalUnifiedDiff(checkedGroup);
  try {
    await workspace.applyUnifiedDiff(patch, changedFiles);
    return {
      route: "quick-patch",
      applied: true,
      patch,
      changedFiles,
      hunkCount: checkedGroup.metrics.hunks,
    };
  } catch (error) {
    return {
      route: "quick-patch",
      applied: false,
      changedFiles,
      diagnostics: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Explicit pre-graph integration point. Denials call the existing graph with the
 * untouched request; approvals are the only requests allowed to reach quick patch.
 */
export async function runWithSimpleChangeEarlyExit<FullGraphResult>(
  request: SimpleChangeRequest,
  fullGraph: (originalRequest: SimpleChangeRequest) => Promise<FullGraphResult> | FullGraphResult,
  workspace: SafePatchWorkspace,
): Promise<FullGraphResult | QuickPatchResult> {
  const decision = evaluateSimpleChange(request);
  if (decision.kind === "denied") {
    return fullGraph(decision.request);
  }
  return executeQuickPatch(decision.taskGroup, workspace);
}
