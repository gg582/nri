import { exec } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../config.js";
import { checkPermission } from "./permissions.js";
import { buildChangeMesh, interpretChangeMesh, summarizeChangeMesh } from "./changeMesh.js";

const execAsync = promisify(exec);

export interface FileChange {
  path: string; // repo-relative
  kind: "diff" | "full-file";
  content: string; // diff text (kind=diff) or new file content (kind=full-file)
}

export interface ApplyPlan {
  format: "unified-diff" | "file-blocks" | "none";
  changes: FileChange[];
}

const PROTECTED_PATH = /^(?:\.git\/|\.nri-backup\/|node_modules\/)|(?:^|\/)\.env(?:\.|$)/;

/**
 * Structural guard only. Size is not a safety signal: a coherent 1,000-line
 * rewrite is valid, whereas an ungrounded duplicate path is not.
 */
function validatePlan(plan: ApplyPlan): string | null {
  const duplicate = plan.changes.find((change, index) => plan.changes.findIndex((other) => other.path === change.path) !== index);
  if (duplicate) return `safety block: duplicate edits for ${duplicate.path}`;
  for (const change of plan.changes) {
    if (PROTECTED_PATH.test(change.path)) return `safety block: protected path ${change.path}`;
  }
  return null;
}

/** Reject anything escaping the working directory. */
function safeRelPath(p: string): string | null {
  const cleaned = p.replace(/^[ab]\//, "").trim();
  if (!cleaned || isAbsolute(cleaned) || normalize(cleaned).startsWith("..")) return null;
  return cleaned;
}

/** Detect a unified diff and list its target files. */
function parseUnifiedDiff(text: string): FileChange[] {
  if (!/^--- /m.test(text) || !/^\+\+\+ /m.test(text) || !/^@@ /m.test(text)) return [];
  // Split into per-file segments at each "--- " header (lookahead-free: the
  // /m "$" trap terminates lazy matches at every line end).
  const starts: number[] = [];
  for (const m of text.matchAll(/^--- /gm)) starts.push(m.index);
  const files: FileChange[] = [];
  for (let i = 0; i < starts.length; i++) {
    const segment = text.slice(starts[i], starts[i + 1]).trimEnd() + "\n";
    const header = segment.match(/^--- (.+)\n\+\+\+ (.+)\n/);
    if (!header) continue;
    const path = safeRelPath(header[2]);
    if (path) files.push({ path, kind: "diff", content: segment });
  }
  return files;
}

/**
 * File-block path markers. Both directory-prefixed and root-level source
 * paths count. Models frequently create small projects as `main.py` or
 * `index.ts`; rejecting those markers made otherwise valid generated code
 * impossible to apply or verify. Used by parseFileBlocks and the incremental
 * stream parser.
 */
export const FILE_MARKER_PATTERN = "(?:(?:[\\w.-]+\\/)*[\\w.-]+\\.[A-Za-z0-9]+)";

/** Detect full-file blocks. Recognized markers:
 *   ```ts\n// src/foo.ts\n... ```  |  // src/foo.ts\n<code lines>
 *   ### src/foo.ts  (heading followed by a fenced block)
 */
function parseFileBlocks(text: string): FileChange[] {
  const changes: FileChange[] = [];
  const fenceRe = /```[\w-]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  const headerRe = new RegExp(`^\\s*(?:\\/\\/|#)\\s*(${FILE_MARKER_PATTERN})\\s*\\n`);
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1];
    const header = body.match(headerRe);
    if (header) {
      const path = safeRelPath(header[1]);
      if (path) changes.push({ path, kind: "full-file", content: body.slice(header[0].length) });
    }
  }
  if (changes.length > 0) return changes;
  // dogfood style: bare "// path/to/file" comment sections outside fences
  const bareRe = new RegExp(`^(?:\\/\\/|#)\\s+(${FILE_MARKER_PATTERN})\\s*$`, "gm");
  const marks: { path: string; index: number }[] = [];
  while ((m = bareRe.exec(text)) !== null) {
    const path = safeRelPath(m[1]);
    if (path) marks.push({ path, index: m.index });
  }
  return marks.map((mark, i) => ({
    path: mark.path,
    kind: "full-file" as const,
    content: text.slice(mark.index, marks[i + 1]?.index).split("\n").slice(1).join("\n").trim() + "\n",
  }));
}

/** Analyze generated output into an applicable plan. */
export function planApply(text: string): ApplyPlan {
  const diff = parseUnifiedDiff(text);
  if (diff.length > 0) return { format: "unified-diff", changes: diff };
  const blocks = parseFileBlocks(text);
  if (blocks.length > 0) return { format: "file-blocks", changes: blocks };
  return { format: "none", changes: [] };
}

/** One-line-per-file summary for the y/n prompt. */
export function summarizePlan(plan: ApplyPlan): string[] {
  return plan.changes.map((c) => {
    if (c.kind === "diff") {
      const plus = c.content.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
      const minus = c.content.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
      return `  ~ ${c.path}  (+${plus}/-${minus})`;
    }
    return `  ${existsSync(c.path) ? "~" : "+"} ${c.path}  (${c.content.split("\n").length} lines)`;
  });
}

/** Back up files about to be overwritten into .nri-backup/<ts>/. */
async function backup(paths: string[]): Promise<string> {
  const dir = join(".nri-backup", new Date().toISOString().replace(/[:.]/g, "-"));
  for (const p of paths) {
    if (existsSync(p)) {
      const dest = join(dir, p);
      await mkdir(dirname(dest), { recursive: true });
      await cp(p, dest);
    }
  }
  return dir;
}

async function applyUnifiedDiff(plan: ApplyPlan): Promise<string[]> {
  const diffText = plan.changes.map((c) => c.content).join("\n");
  const tmp = join(tmpdir(), `nri-${Date.now()}.patch`);
  await writeFile(tmp, diffText, "utf8");
  const gate = checkPermission("git apply");
  if (!gate.allowed) return [`apply blocked: ${gate.reason}`];
  const notes = gate.advisory ? [`[warn] ${gate.advisory}`] : [];
  await backup(plan.changes.map((c) => c.path));
  try {
    await execAsync("git apply --whitespace=fix " + JSON.stringify(tmp), { timeout: 30_000 });
    return [...notes, `applied unified diff to ${plan.changes.length} file(s) via git apply`];
  } catch (err) {
    return [...notes, `git apply failed: ${err instanceof Error ? err.message.split("\n")[0] : err}`];
  }
}

async function applyFileBlocks(plan: ApplyPlan): Promise<string[]> {
  const gate = checkPermission("write files");
  if (!gate.allowed) return [`apply blocked: ${gate.reason}`];
  await backup(plan.changes.map((c) => c.path));
  const lines: string[] = [];
  for (const c of plan.changes) {
    await mkdir(dirname(c.path), { recursive: true });
    await writeFile(c.path, c.content, "utf8");
    lines.push(`  wrote ${c.path}`);
  }
  return [
    ...(gate.advisory ? [`[warn] ${gate.advisory}`] : []),
    `applied ${plan.changes.length} file(s):`,
    ...lines,
  ];
}

/**
 * Incrementally write file blocks found in generated output, so files appear
 * locally as soon as they are produced (claude-code/kimi-code style) instead
 * of one dump at run end. Only full-file blocks are handled here — unified
 * diffs still wait for the end-of-run apply gate. Files whose on-disk
 * content already matches are skipped (loop iterations rewrite only deltas).
 */
export async function writeFileBlocksNow(code: string): Promise<{ written: string[]; lines: string[] }> {
  const plan = planApply(code);
  if (plan.format === "none" || plan.changes.length === 0) {
    return { written: [], lines: [] };
  }
  const lines = await applyFileBlocks(plan);
  return { written: plan.changes.map((c) => c.path), lines };
}

/** Legacy synchronous bypasses are deliberately disabled: all writes must go
 * through offerApply(), which enforces review and mesh validation. */
export function applyQuickDiffPatch(_diff: string): never {
  throw new Error("direct patch application is disabled; review the change mesh through the apply gate");
}

/**
 * Apply gate shared by CLI and TUI.
 * Mode resolution: yolo flag > config permissions.mode (default "auto").
 * Returns log lines; `ask` is only used in auto mode.
 *
 * Before gating, the agentic refinement mini-loop checks the output against
 * the real repo (phantom imports, dropped exports, broken JSON) and tries to
 * correct it into a clean unified diff. Yolo mode refuses to apply output
 * whose flags stay unresolved.
 */
export async function offerApply(
  generatedCode: string,
  ask: (question: string) => Promise<boolean>,
  opts?: { yolo?: boolean; provider?: import("../providers/base.js").LLMProviderStrategy },
): Promise<string[]> {
  const { refineChanges } = await import("./refine.js");
  const refined = await refineChanges(generatedCode, { provider: opts?.provider });
  const plan = refined.plan;
  if (plan.format === "none") return ["no applicable diff/file-blocks detected — output left unapplied."];
  const safetyBlock = validatePlan(plan);
  if (safetyBlock) return [`${safetyBlock}; output left unapplied.`];
  const mode = opts?.yolo ? "yolo" : (loadConfig().permissions?.mode ?? "auto");
  const summary = [
    `detected ${plan.format}: ${plan.changes.length} file(s)`,
    ...(() => {
      const mesh = buildChangeMesh(plan);
      const interpretation = interpretChangeMesh(mesh);
      return [
        ...summarizeChangeMesh(mesh),
        `graph interpretation: ${interpretation.kind}; +${interpretation.plusWeight}/-${interpretation.minusWeight}; clusters=${interpretation.clusters.length}; max-distance=${interpretation.maxDistance}`,
      ];
    })(),
    ...summarizePlan(plan),
    ...refined.report,
  ];
  if (mode === "plan") return [...summary, "plan mode: not applied."];
  if (!refined.clean && mode === "yolo") {
    return [...summary, "yolo safety: unresolved hallucination flags — NOT applied."];
  }
  if (mode !== "yolo") {
    const question = refined.clean
      ? `apply these ${plan.changes.length} file change(s)?`
      : `apply despite ${refined.report.length} unresolved refine note(s)?`;
    const ok = await ask(question);
    if (!ok) return [...summary, "not applied (user declined)."];
  }
  const result =
    plan.format === "unified-diff" ? await applyUnifiedDiff(plan) : await applyFileBlocks(plan);
  return [...summary, ...result];
}
