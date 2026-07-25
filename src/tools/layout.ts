import { readdirSync, type Dirent } from "node:fs";
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
