import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

const SKIP = new Set(["node_modules", ".git", ".nri-workspace", ".nri-backup", "dist", "build", ".next", "out"]);

/**
 * Bounded listing of the working directory's existing files (repo-relative
 * paths). Fed into implementation prompts so the model modifies the layout
 * that is already on disk instead of inventing a parallel directory tree.
 */
export function existingProjectFiles(root = process.cwd(), maxDepth = 4, cap = 60): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (out.length >= cap || depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= cap) return;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(join(dir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk(root, "", 1);
  return out;
}

/** Text files only — reading binaries into a prompt is pure token waste. */
const TEXT_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|cpp|cc|cxx|c|h|hpp|rs|go|java|kt|rb|php|cs|swift|sh|bash|zsh|md|txt|toml|ya?ml|xml|html|css|scss|sql|proto|cfg|ini|mk|cmake)$/i;

/** Never read secrets/VC internals into a prompt. */
const PROTECTED_PATH = /^(?:\.git\/|\.nri-backup\/|node_modules\/)|(?:^|\/)\.env(?:\.|$)/;

/** Generic English words that match everything and select nothing. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "fix", "add",
  "all", "any", "out", "use", "using", "make", "update", "change", "remove",
]);

/** Lowercased word tokens of a request (stopwords and short bits removed). */
function pathTokens(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[\s/_.-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export interface SourceContextOptions {
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}

/**
 * Read the CONTENTS of the files most relevant to a request, so the model
 * patches the code that is actually on disk instead of hallucinating against
 * a bare file-name list. Selection is deterministic (zero LLM cost): request
 * tokens matched against repo-relative paths, plus any explicitly named paths
 * (e.g. files already written this run). Hard caps bound prompt growth.
 */
export function relevantFileContents(
  request: string,
  extraPaths: string[] = [],
  opts: SourceContextOptions = {},
): { path: string; content: string }[] {
  const maxFiles = opts.maxFiles ?? 6;
  const maxCharsPerFile = opts.maxCharsPerFile ?? 8000;
  const maxTotalChars = opts.maxTotalChars ?? 24000;

  const tokens = [...new Set(pathTokens(request))];
  const isTextFile = (p: string) => TEXT_EXT.test(p) && !PROTECTED_PATH.test(p);

  const picked: string[] = [];
  const push = (p: string) => {
    if (picked.length < maxFiles && isTextFile(p) && !picked.includes(p) && existsSync(p)) {
      picked.push(p);
    }
  };

  // Explicitly named paths first (session-written files, exact mentions).
  for (const p of extraPaths) push(p);

  if (tokens.length > 0) {
    const scored = existingProjectFiles(process.cwd(), 4, 400)
      .filter(isTextFile)
      .map((p) => {
        const hay = p.toLowerCase();
        let score = 0;
        for (const t of tokens) {
          if (hay.includes(t)) score += t.length; // longer token match = more specific
        }
        return { p, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    for (const s of scored) push(s.p);
  }

  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const p of picked) {
    try {
      if (statSync(p).size > maxCharsPerFile * 4) continue; // huge file: skip outright
      let content = readFileSync(p, "utf8");
      if (content.includes("\0")) continue;
      if (content.length > maxCharsPerFile) {
        content = content.slice(0, maxCharsPerFile) + "\n// …(truncated)";
      }
      if (total + content.length > maxTotalChars) break;
      total += content.length;
      out.push({ path: p, content });
    } catch {
      /* unreadable file — skip */
    }
  }
  return out;
}
