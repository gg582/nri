/**
 * Real-usage example: let nri generate a minimal, high-quality Qt calculator.
 *
 * Uses the real OpenAI provider for all reasoning nodes and the mock test
 * runner (NRI_TEST_MODE=mock) so the coverage loop terminates without a
 * Python/Qt test infrastructure. The generated artifact is saved to
 * examples/calculator-qt/calculator.py.
 *
 * Run:  npx tsx examples/calculator-qt/run.ts [provider]
 * Requires: an API key for the chosen provider (default: $NRI_PROVIDER or openai)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, resumeNri, runNri } from "../../src/graph/builder.js";
import { createProvider } from "../../src/providers/factory.js";
import { MockTestRunner } from "../../src/tools/testRunner.js";

const providerName = process.argv[2];

const REQUEST = [
  "Implement a minimal but high-quality desktop calculator with PySide6 (Qt for Python).",
  "Single self-contained file. A QLineEdit display on top and a grid of buttons:",
  "digits 0-9, operators + - * /, equals, and clear (C).",
  "Evaluate expressions safely WITHOUT eval() — use a small shunting-yard or ast-based parser.",
  "Use type hints, docstrings, and a clean class structure.",
].join(" ");

async function main() {
  process.env.NRI_TEST_MODE = "mock";
  const provider = createProvider(providerName);
  console.log(`provider=${provider.name} model=${provider.model}`);

  const graph = buildGraph({ resolveProvider: () => provider, testRunner: new MockTestRunner() });
  const threadId = `calc-${Date.now()}`;

  let run = await runNri(graph, { request: REQUEST, targetTestCoverage: 80, threadId });
  let final = run.finalState;
  for (let i = 0; i < 6 && run.awaitingApproval; i++) {
    final = await resumeNri(graph, null, threadId);
    const snap = await graph.getState({ configurable: { thread_id: threadId } });
    run = { finalState: final, awaitingApproval: snap.next.includes("human_approval") };
  }

  console.log("\n=== trace ===");
  for (const line of final.trace) console.log(" ", line);
  console.log(`\npath=${final.selectedPath} coverage=${final.currentTestCoverage}% iterations=${final.iterationCount}`);

  const outDir = dirname(fileURLToPath(import.meta.url));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "calculator.py"), final.generatedCode ?? "", "utf8");
  console.log(`\nsaved -> ${join(outDir, "calculator.py")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
