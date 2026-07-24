import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { LLMProviderStrategy } from "../providers/base.js";
import { planApply, type ApplyPlan } from "./apply.js";
import { flagHallucinations } from "./hallucination.js";
import { REFINE_SYSTEM } from "../prompts.js";

const execAsync = promisify(exec);

export interface RefineResult {
  plan: ApplyPlan;
  /** Human-readable flags and fix notes for the apply summary. */
  report: string[];
  /** True when no unresolved hallucination flags remain. */
  clean: boolean;
}

const RefinedDiffSchema = z.object({
  diff: z.string(),
  fixes_applied: z.array(z.string()),
});

/** `git apply --check` against the real working tree. */
async function checkDiffApplies(diff: string): Promise<string | null> {
  const tmp = join(tmpdir(), `nri-refine-${Date.now()}.patch`);
  await writeFile(tmp, diff, "utf8");
  try {
    await execAsync(`git apply --check ${JSON.stringify(tmp)}`, { timeout: 30_000 });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n").slice(0, 3).join(" ") : String(err);
  }
}

/** Current content of target files (ground truth for the refiner). */
function groundTruth(plan: ApplyPlan, maxBytesPerFile = 8000): string {
  const parts: string[] = [];
  for (const c of plan.changes) {
    if (existsSync(c.path)) {
      const content = readFileSync(c.path, "utf8").slice(0, maxBytesPerFile);
      parts.push(`=== CURRENT ${c.path} ===\n${content}`);
    } else {
      parts.push(`=== CURRENT ${c.path} === (new file)`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Agentic refinement mini-loop, inserted between AI output and application.
 *
 *   parse -> deterministic hallucination flags (ground truth)
 *     -> clean? done (zero LLM cost)
 *     -> LLM reinterprets the output as a corrected UNIFIED DIFF
 *     -> validate mechanically (parses + git apply --check + re-flag)
 *     -> invalid? feed errors back (bounded iterations)
 *
 * Never returns a flagged plan silently: unresolved flags stay in `report`
 * and `clean=false` (yolo mode refuses to apply those).
 */
export async function refineChanges(
  generatedCode: string,
  opts: { provider?: LLMProviderStrategy; maxIterations?: number } = {},
): Promise<RefineResult> {
  const plan = planApply(generatedCode);
  if (plan.format === "none") return { plan, report: [], clean: true };

  const initialFlags = flagHallucinations(plan);
  if (initialFlags.length === 0) return { plan, report: [], clean: true };

  const report = initialFlags.map((f) => `[refine][flag] ${f}`);
  if (!opts.provider) {
    report.push("[refine] no provider available — flags unresolved");
    return { plan, report, clean: false };
  }

  const maxIterations = opts.maxIterations ?? 2;
  let lastError = "";
  for (let i = 0; i < maxIterations; i++) {
    const result = await opts.provider.invokeJson(
      [
        { role: "system", content: REFINE_SYSTEM },
        {
          role: "user",
          content:
            `AI output under review:\n${generatedCode}\n\n` +
            `Hallucination flags:\n${initialFlags.join("\n")}\n\n` +
            `${groundTruth(plan)}` +
            (lastError ? `\n\nYour previous diff was rejected: ${lastError}` : ""),
        },
      ],
      RefinedDiffSchema,
    );

    const refined = planApply(result.diff);
    if (refined.format !== "unified-diff") {
      lastError = "output was not a unified diff";
      continue;
    }
    const applyError = await checkDiffApplies(result.diff);
    if (applyError) {
      lastError = `git apply --check failed: ${applyError}`;
      continue;
    }
    const remaining = flagHallucinations(refined);
    if (remaining.length > 0) {
      lastError = `flags remain: ${remaining.join("; ")}`;
      continue;
    }
    report.push(`[refine] corrected via agentic loop (iteration ${i + 1}): ${result.fixes_applied.join("; ") || "diff rewritten"}`);
    return { plan: refined, report, clean: true };
  }

  report.push(`[refine] correction failed after ${maxIterations} iteration(s): ${lastError}`);
  return { plan, report, clean: false };
}
