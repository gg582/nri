/** Store-layer test (no LLM): paths, JSONL gen-1, SQLite RAG gen-2. Run: npx tsx examples/store-test.ts */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "nri-store-"));
process.env.NRI_CONFIG_HOME = join(dir, "cfg");
process.env.NRI_DATA_HOME = join(dir, "data");

const { storePaths } = await import("../src/store/paths.js");
const { JsonlStore } = await import("../src/store/jsonl.js");
const { RagStore } = await import("../src/store/rag.js");
const { loadConfig, saveGlobalConfig } = await import("../src/config.js");
const { saveRecord, searchMemory, memoryStats, setBackend } = await import("../src/store/memory.js");

// --- paths honor overrides ---
const p = storePaths();
console.log("configDir:", p.configDir, "| dataDir:", p.dataDir);
if (p.configDir !== join(dir, "cfg") || p.dataDir !== join(dir, "data")) throw new Error("paths override failed");

// --- gen-1: JSONL ---
const jsonl = new JsonlStore();
jsonl.append({ kind: "run", content: "request: fix checkout rounding path: FAST_PATH coverage 80%" });
jsonl.append({ kind: "note", content: "billing module uses decimal arithmetic" });
const hits = jsonl.search("checkout rounding");
console.log("jsonl: count =", jsonl.stats().count, "| search hits =", hits.length);
if (jsonl.stats().count !== 2 || hits.length === 0) throw new Error("jsonl failed");
if (!existsSync(p.runsJsonl)) throw new Error("jsonl file not persisted");
JSON.parse(readFileSync(p.runsJsonl, "utf8").split("\n")[0]); // valid JSONL line

// --- gen-2: SQLite RAG (keyword fallback; no embedding key in test env) ---
const rag = new RagStore();
await rag.add({ kind: "run", content: "request: refactor billing module path: HEAVY_PATH coverage 85%" });
await rag.add({ kind: "note", content: "exchange rates must be auditable" });
const ragHits = await rag.search("billing refactor");
const stats = await rag.stats();
rag.close();
console.log("rag: count =", stats.count, "| hits =", ragHits.length, "| file =", stats.file);
if (stats.count !== 2 || ragHits.length === 0) throw new Error("rag failed");
if (!existsSync(p.ragDb)) throw new Error("rag db not persisted");

// --- facade + backend switching (config persisted to OS-standard dir) ---
setBackend("rag");
const rec = await saveRecord({ kind: "note", content: "facade write via rag backend" });
const facadeHits = await searchMemory("facade write");
const facadeStats = await memoryStats();
console.log("facade: backend =", facadeStats.backend, "| saved =", rec.kind, "| hits =", facadeHits.length);
if (facadeStats.backend !== "rag" || facadeHits.length === 0) throw new Error("facade failed");
setBackend("jsonl");
await saveRecord({ kind: "note", content: "facade write via jsonl backend" });
if (loadConfig().memory?.backend !== "jsonl") throw new Error("backend config not persisted");
if (!existsSync(p.configFile)) throw new Error("config not written to OS-standard path");

console.log("store-test OK");
