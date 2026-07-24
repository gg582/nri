import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { storePaths } from "./paths.js";

export interface MemoryRecord {
  id: string;
  ts: string;
  kind: string; // e.g. "run", "note"
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Gen-1 memory: append-only JSONL store at the OS-standard data dir.
 * Simple, greppable, non-volatile.
 */
export class JsonlStore {
  constructor(private readonly file = storePaths().runsJsonl) {}

  append(record: Omit<MemoryRecord, "id" | "ts">): MemoryRecord {
    const full: MemoryRecord = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      ...record,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(full) + "\n", "utf8");
    return full;
  }

  readAll(): MemoryRecord[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as MemoryRecord);
  }

  /** Keyword scoring fallback shared with the RAG store. */
  search(query: string, k = 5): MemoryRecord[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = this.readAll().map((r) => {
      const hay = `${r.kind} ${r.content}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      return { r, score };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.r.ts.localeCompare(a.r.ts))
      .slice(0, k)
      .map((s) => s.r);
  }

  stats(): { count: number; file: string } {
    return { count: this.readAll().length, file: this.file };
  }
}
