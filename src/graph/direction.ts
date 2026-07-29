import { existingProjectFiles } from "../tools/layout.js";

/**
 * Graph direction (execution order) selection.
 *
 * The pipeline's forward wiring is top-down: request -> decompose -> plan ->
 * implement -> verify. `/reverse on` flips every edge for a bottom-up run
 * (implement -> verify -> plan -> decompose). `/reverse auto` — the default —
 * decides per request with STATIC analysis only: no LLM call, no reasoning
 * chain, just structural signals from the request text and the project tree.
 * The graph is flipped only when one direction wins by an overwhelming
 * margin; anything close keeps the normal top-down order.
 */

export type ReverseMode = "on" | "off" | "auto";

/** Config stores "on" | "off" | "auto" (legacy booleans: true = on, false = off). */
export function normalizeReverseMode(value: unknown): ReverseMode {
  if (value === true || value === "on") return "on";
  if (value === false || value === "off") return "off";
  return "auto";
}

export interface DirectionDecision {
  /** True = run the graph reversed (bottom-up). */
  reversed: boolean;
  /** bottom-up score minus top-down score. */
  score: number;
  reason: string;
}

// Architectural intent -> top-down favors (plan before code).
const ARCHITECTURAL =
  /(architect|redesign|refactor|restructure|subsystem|module structure|migrat\w*|overhaul|rewrite|system-wide|across (the )?(codebase|modules|project)|multiple modules|greenfield|from scratch|설계|아키텍처|리팩터|전체)/gi;
// Localized intent (bug/spot fix) -> bottom-up favors (code before ceremony).
const LOCALIZED =
  /(fix|bug|typo|off-by-one|hotfix|rename|patch|crash|null pointer|undefined is|line \d+|오타|버그)/gi;
// Concrete file references are the strongest bottom-up signal.
const FILE_REF =
  /[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|java|go|rs|c|cc|cpp|h|hpp|cs|rb|php|json|ya?ml|toml)(?=\s|$|[),.:;])/gi;

/** Margin required before auto mode flips the graph — "overwhelming" only. */
const OVERWHELMING_MARGIN = 4;

/**
 * Score a request structurally. Bottom-up wins for concrete, file-scoped
 * work inside an existing tree; top-down wins for architectural language
 * and greenfield/empty trees. No LLM involved.
 */
export function analyzeDirection(request: string, projectFiles: number): DirectionDecision {
  const arch = (request.match(ARCHITECTURAL) ?? []).length;
  const local = (request.match(LOCALIZED) ?? []).length;
  const fileRefs = (request.match(FILE_REF) ?? []).length;
  const topDown = arch * 2 + (projectFiles === 0 ? 2 : 0);
  const bottomUp = local * 2 + fileRefs * 3 + (projectFiles >= 20 && fileRefs > 0 ? 2 : 0);
  const score = bottomUp - topDown;
  if (Math.abs(score) < OVERWHELMING_MARGIN) {
    return {
      reversed: false,
      score,
      reason: `no overwhelming structural edge (top-down ${topDown} vs bottom-up ${bottomUp}) — normal order`,
    };
  }
  const reversed = score > 0;
  return {
    reversed,
    score,
    reason:
      `static analysis favors ${reversed ? "bottom-up" : "top-down"} by ${Math.abs(score)} ` +
      `(top-down ${topDown}, bottom-up ${bottomUp}, files=${projectFiles})`,
  };
}

/**
 * Resolve the effective direction for a run. "on"/"off" are forced; "auto"
 * runs the static analysis against the request and the current project tree.
 */
export function resolveDirection(mode: ReverseMode, request: string): DirectionDecision & { mode: ReverseMode } {
  if (mode === "on") return { mode, reversed: true, score: Infinity, reason: "forced on" };
  if (mode === "off") return { mode, reversed: false, score: -Infinity, reason: "forced off" };
  return { mode, ...analyzeDirection(request, existingProjectFiles().length) };
}
