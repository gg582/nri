import { loadConfig, saveGlobalConfig } from "../config.js";
import { JsonlStore, type MemoryRecord } from "./jsonl.js";
import { RagStore } from "./rag.js";

export type MemoryBackend = "jsonl" | "rag";

export function activeBackend(): MemoryBackend {
  return loadConfig().memory?.backend ?? "jsonl";
}

export function setBackend(backend: MemoryBackend): void {
  saveGlobalConfig({ memory: { backend } });
}

/** Persist one record to the active backend. */
export async function saveRecord(record: Omit<MemoryRecord, "id" | "ts">): Promise<MemoryRecord> {
  if (activeBackend() === "rag") {
    const rag = new RagStore();
    try {
      return await rag.add(record);
    } finally {
      rag.close();
    }
  }
  return new JsonlStore().append(record);
}

/** Persist a finished pipeline run (called by CLI and TUI after each run). */
export async function saveRun(args: {
  request: string;
  path: string;
  coverage: number;
  target: number;
  iterations: number;
  summary?: string;
}): Promise<void> {
  await saveRecord({
    kind: "run",
    content:
      `request: ${args.request}\npath: ${args.path} coverage ${args.coverage}%/${args.target}% ` +
      `iterations ${args.iterations}${args.summary ? `\n${args.summary}` : ""}`,
    metadata: { path: args.path, coverage: args.coverage, target: args.target },
  }).catch(() => undefined); // persistence must never break a run
}

export async function searchMemory(query: string, k = 5): Promise<MemoryRecord[]> {
  if (activeBackend() === "rag") {
    const rag = new RagStore();
    try {
      return await rag.search(query, k);
    } finally {
      rag.close();
    }
  }
  return new JsonlStore().search(query, k);
}

export async function memoryStats(): Promise<Record<string, unknown>> {
  const backend = activeBackend();
  if (backend === "rag") {
    const rag = new RagStore();
    try {
      return { backend, ...(await rag.stats()) };
    } finally {
      rag.close();
    }
  }
  return { backend, ...new JsonlStore().stats() };
}

export async function listMemory(limit = 20): Promise<MemoryRecord[]> {
  if (activeBackend() === "rag") {
    const rag = new RagStore();
    try {
      return (await rag.readAll()).slice(-limit);
    } finally {
      rag.close();
    }
  }
  return new JsonlStore().readAll().slice(-limit);
}
