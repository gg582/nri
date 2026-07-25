import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ApplyPlan, FileChange } from "./apply.js";

/**
 * Deterministic hallucination flags — ground-truth checks of AI output
 * against the real repo, no LLM involved.
 */

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "util", "child_process", "readline", "process", "events",
  "stream", "http", "https", "crypto", "url", "buffer", "node:fs", "node:path",
  "node:os", "node:util", "node:child_process", "node:readline/promises", "node:process",
]);

function packageDeps(): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

/** Extract module specifiers from TS/JS and Python content. */
export function extractImports(content: string): string[] {
  const specs = new Set<string>();
  for (const m of content.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of content.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) specs.add(m[1]);
  for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) specs.add(m[1]);
  return [...specs];
}

function resolveRelativeImport(fromFile: string, spec: string): boolean {
  const base = join(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.py`, join(base, "index.ts"), join(base, "index.js")];
  return candidates.some((c) => existsSync(c));
}

/** Exported symbol names (crude: TS/JS export declarations). */
function exportedSymbols(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(/export\s+(?:async\s+)?(?:const|function|class|interface|type|enum)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  return names;
}

function flagChange(change: FileChange, deps: Set<string>): string[] {
  const flags: string[] = [];

  // 1. Phantom imports (the classic hallucination: '@granular/core' et al.)
  for (const spec of extractImports(change.content)) {
    if (spec.startsWith(".")) {
      if (!resolveRelativeImport(change.path, spec)) {
        flags.push(`${change.path}: relative import "${spec}" does not resolve to any file`);
      }
    } else {
      const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!NODE_BUILTINS.has(root) && !deps.has(root)) {
        flags.push(`${change.path}: package "${root}" is not in package.json (likely hallucinated)`);
      }
    }
  }

  // 2. JSON targets must parse.
  if (change.path.endsWith(".json")) {
    try {
      JSON.parse(change.kind === "full-file" ? change.content : change.content.replace(/^[-+].*$/gm, ""));
    } catch {
      flags.push(`${change.path}: JSON content does not parse`);
    }
  }

  // 3. Full-file overwrites of existing files: detect silent content drops.
  if (change.kind === "full-file" && existsSync(change.path)) {
    const oldContent = readFileSync(change.path, "utf8");
    const removed = [...exportedSymbols(oldContent)].filter((s) => !exportedSymbols(change.content).has(s));
    if (removed.length > 0) {
      flags.push(`${change.path}: overwrite drops existing exports: ${removed.join(", ")}`);
    }
    const oldLines = oldContent.split("\n").length;
    const newLines = change.content.split("\n").length;
    if (oldLines > 40 && newLines < oldLines * 0.5) {
      flags.push(`${change.path}: overwrite shrinks file ${oldLines} -> ${newLines} lines (possible content drop)`);
    }
  }
  return flags;
}

/** Run all deterministic checks over a plan. */
export function flagHallucinations(plan: ApplyPlan): string[] {
  const deps = packageDeps();
  const flags = plan.changes.flatMap((c) => flagChange(c, deps));
  for (const change of plan.changes) {
    if (change.kind === "full-file" && !existsSync(change.path)) {
      const name = basename(change.path);
      const duplicate = plan.changes.find((other) => other.path !== change.path && basename(other.path) === name) ??
        findExistingByBasename(name);
      if (duplicate) flags.push(`${change.path}: possible duplicate of existing file ${typeof duplicate === "string" ? duplicate : duplicate.path}`);
    }
  }
  return flags;
}

/** Bounded search for a same-named source file. Creating src/foo.ts beside an
 * existing app/foo.ts is a common model hallucination. */
function findExistingByBasename(name: string, root = process.cwd(), depth = 0): string | null {
  if (depth > 4) return null;
  let entries: Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".nri-backup") continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findExistingByBasename(name, path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
