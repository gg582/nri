import { stdout } from "node:process";
import { activeBackend, listMemory, memoryStats, saveRecord, searchMemory, setBackend } from "../store/memory.js";

function printRecords(records: { id: string; ts: string; kind: string; content: string }[]): void {
  for (const r of records) {
    stdout.write(`[${r.ts.slice(0, 19)}] (${r.kind}) ${r.content.split("\n")[0].slice(0, 100)}  <${r.id}>\n`);
  }
  if (records.length === 0) stdout.write("(no records)\n");
}

/**
 * /memory — inspect and manage persisted run memory.
 *   nri memory list [n]        recent records
 *   nri memory search <query>  RAG retrieval (embedding or keyword fallback)
 *   nri memory ingest "<text>" add a note record manually
 *   nri memory stats           backend + counts
 *   nri memory backend <jsonl|rag>   select gen-1 (JSONL) or gen-2 (DB RAG)
 */
export async function memoryCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case undefined:
      printRecords(await listMemory(rest[0] ? Number(rest[0]) : 20));
      return;
    case "search": {
      const query = rest.join(" ");
      if (!query) throw new Error('usage: nri memory search "<query>"');
      printRecords(await searchMemory(query));
      return;
    }
    case "ingest": {
      const text = rest.join(" ");
      if (!text) throw new Error('usage: nri memory ingest "<text>"');
      const rec = await saveRecord({ kind: "note", content: text });
      stdout.write(`ingested <${rec.id}> into backend=${activeBackend()}\n`);
      return;
    }
    case "stats":
      for (const [k, v] of Object.entries(await memoryStats())) stdout.write(`${k}: ${v}\n`);
      return;
    case "backend": {
      const b = rest[0];
      if (b !== "jsonl" && b !== "rag") throw new Error("usage: nri memory backend <jsonl|rag>");
      setBackend(b);
      stdout.write(`memory backend -> ${b}\n`);
      return;
    }
    default:
      throw new Error(`unknown memory subcommand "${sub}" (list|search|ingest|stats|backend)`);
  }
}
