import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { storePaths } from "./paths.js";
import { cosine, embed } from "./embed.js";
import type { MemoryRecord } from "./jsonl.js";

type DatabaseSyncT = import("node:sqlite").DatabaseSync;

/**
 * Gen-2 memory: DB-backed RAG store (node:sqlite, no native deps).
 * Documents + embedding vectors live in a single SQLite file at the
 * OS-standard data dir; retrieval is cosine similarity with a keyword
 * fallback when no embedding provider key is configured.
 * node:sqlite is imported lazily so gen-1 (JSONL) users never see its
 * ExperimentalWarning.
 */
export class RagStore {
  private db: DatabaseSyncT | null = null;

  constructor(private readonly file = storePaths().ragDb) {}

  private async open(): Promise<DatabaseSyncT> {
    if (this.db) return this.db;
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT
      );
      CREATE TABLE IF NOT EXISTS embeddings (
        doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        vector TEXT NOT NULL
      );
    `);
    this.db = db;
    return db;
  }

  async add(record: Omit<MemoryRecord, "id" | "ts">): Promise<MemoryRecord> {
    const full: MemoryRecord = {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      ...record,
    };
    const db = await this.open();
    db.prepare("INSERT INTO documents (id, ts, kind, content, metadata) VALUES (?, ?, ?, ?, ?)").run(
      full.id,
      full.ts,
      full.kind,
      full.content,
      JSON.stringify(full.metadata ?? {}),
    );
    const vector = await embed(`${full.kind}\n${full.content}`).catch(() => null);
    if (vector) {
      db.prepare("INSERT INTO embeddings (doc_id, vector) VALUES (?, ?)").run(full.id, JSON.stringify(vector));
    }
    return full;
  }

  async readAll(): Promise<MemoryRecord[]> {
    if (!existsSync(this.file)) return [];
    const db = await this.open();
    const rows = db.prepare("SELECT id, ts, kind, content, metadata FROM documents ORDER BY ts").all() as unknown as {
      id: string; ts: string; kind: string; content: string; metadata: string;
    }[];
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata || "{}") }));
  }

  /** RAG retrieval: cosine over embeddings, keyword fallback without vectors. */
  async search(query: string, k = 5): Promise<MemoryRecord[]> {
    const db = await this.open();
    const qVec = await embed(query).catch(() => null);
    if (qVec) {
      const rows = db
        .prepare(
          `SELECT d.id, d.ts, d.kind, d.content, d.metadata, e.vector
           FROM documents d JOIN embeddings e ON e.doc_id = d.id`,
        )
        .all() as unknown as { id: string; ts: string; kind: string; content: string; metadata: string; vector: string }[];
      if (rows.length > 0) {
        return rows
          .map((r) => ({ r, score: cosine(qVec, JSON.parse(r.vector) as number[]) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, k)
          .map(({ r }) => ({ id: r.id, ts: r.ts, kind: r.kind, content: r.content, metadata: JSON.parse(r.metadata || "{}") }));
      }
    }
    // keyword fallback
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (await this.readAll())
      .map((r) => {
        const hay = `${r.kind} ${r.content}`.toLowerCase();
        return { r, score: terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0) };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.r.ts.localeCompare(a.r.ts))
      .slice(0, k)
      .map((s) => s.r);
  }

  async stats(): Promise<{ count: number; embedded: number; file: string }> {
    if (!existsSync(this.file)) return { count: 0, embedded: 0, file: this.file };
    const db = await this.open();
    const count = (db.prepare("SELECT COUNT(*) AS c FROM documents").get() as { c: number }).c;
    const embedded = (db.prepare("SELECT COUNT(*) AS c FROM embeddings").get() as { c: number }).c;
    return { count, embedded, file: this.file };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
