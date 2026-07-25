import { z } from "zod";
import { StructuredTool } from "@langchain/core/tools";

const coverageEvaluationSchema = z.object({
  coverageFile: z.string().min(1).describe("Repository-relative path to the coverage report selected after inspecting the candidates."),
  coverageValues: z.array(z.object({
    metric: z.string().min(1).describe("The coverage metric exactly as identified in the report, such as lines, statements, functions, or branches."),
    value: z.number().min(0).max(100).describe("The percentage read from the report."),
    source: z.string().min(1).describe("The exact report line, table cell, or XML attribute containing the value."),
  })).min(1),
  requirement: z.number().min(0).max(100).describe("The configured threshold supplied in the request."),
  decision: z.enum(["pass", "fail"]),
  rationale: z.string().min(1).describe("Explain the decision using the extracted source values and configured requirement."),
  diagnostics: z.string().optional().describe("Missing, ambiguous, malformed, or otherwise relevant report diagnostics."),
});

export type CoverageEvaluation = z.infer<typeof coverageEvaluationSchema>;

/**
 * Validates and records an LLM coverage evaluation. The model, not this tool,
 * discovers the report, reads its values, and decides the outcome.
 */
export class CoverageEvaluationTool extends StructuredTool {
  name = "record_coverage_evaluation";
  description = `Record an LLM coverage evaluation for an NRI quality gate.
Before calling this tool, use repository file-listing and file-reading tools to locate coverage reports. Read the selected report itself; do not infer values from filenames or use mechanical parsing. Support the report's native language and format (for example lcov, Cobertura XML, JaCoCo XML, Istanbul JSON/text, Go cover, Python coverage, or .NET coverage). Extract every value used as quoted source evidence, apply the supplied configured threshold without changing it, and make the pass/fail decision yourself. If reports are missing, ambiguous, or malformed, record a fail with diagnostics and the available evidence.`;
  schema = coverageEvaluationSchema;

  async _call(evaluation: CoverageEvaluation): Promise<string> {
    return JSON.stringify({
      coverageFile: evaluation.coverageFile,
      coverageValues: evaluation.coverageValues,
      requirement: evaluation.requirement,
      decision: evaluation.decision,
      rationale: evaluation.rationale,
      diagnostics: evaluation.diagnostics,
    }, null, 2);
  }
}

export function createCoverageEvaluationTool(): CoverageEvaluationTool {
  return new CoverageEvaluationTool();
}
