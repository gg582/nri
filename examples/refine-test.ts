/** Unit test for the hallucination refine loop (no real LLM). Run: npx tsx examples/refine-test.ts */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { extractJson, type LLMProviderStrategy } from "../src/providers/base.js";
import { flagHallucinations } from "../src/tools/hallucination.js";
import { refineChanges } from "../src/tools/refine.js";
import { offerApply } from "../src/tools/apply.js";

const CLEAN_BLOCKS = `\`\`\`typescript
// src/ok.ts
export const ok = 1;
\`\`\``;

const HALLUCINATED = `\`\`\`typescript
// src/bad.ts
import { Annotation } from '@granular/core';
export const bad = 1;
\`\`\``;

class StubProvider implements LLMProviderStrategy {
  name = "stub";
  model = "stub";
  calls = 0;
  constructor(private readonly diff: string) {}
  async invoke(): Promise<string> {
    this.calls++;
    return JSON.stringify({ diff: this.diff, fixes_applied: ["removed phantom import"] });
  }
  async invokeJson<T>(_m: unknown, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(JSON.parse(extractJson(await this.invoke())));
  }
}

class GarbageProvider implements LLMProviderStrategy {
  name = "garbage";
  model = "garbage";
  async invoke(): Promise<string> {
    return JSON.stringify({ diff: "not a diff at all", fixes_applied: [] });
  }
  async invokeJson<T>(_m: unknown, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(JSON.parse(extractJson(await this.invoke())));
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "nri-refine-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^3" } }));
    // Keep auto-mode assertions independent from the user's global config.
    writeFileSync(join(dir, "nri.config.json"), JSON.stringify({ permissions: { mode: "auto" } }));

    // 1. clean input -> flags empty, no LLM call
    const stub = new StubProvider("unused");
    const r1 = await refineChanges(CLEAN_BLOCKS, { provider: stub });
    console.log("clean: flags =", r1.report.length, "| llm calls =", stub.calls, "| clean =", r1.clean);
    if (!r1.clean || stub.calls !== 0) throw new Error("clean path failed");

    // 2. phantom import flagged deterministically
    const flags = flagHallucinations((await refineChanges(HALLUCINATED)).plan);
    console.log("flags:", flags);
    if (!flags.some((f) => f.includes("@granular/core"))) throw new Error("phantom import not flagged");

    // 2b. import of a file created in the SAME change set is not a phantom
    const MULTI_FILE = `\`\`\`typescript
// src/promotion.ts
export const discount = (n: number) => n * 0.9;
\`\`\`
\`\`\`typescript
// src/cart.ts
import { discount } from "./promotion";
export const total = (n: number) => discount(n);
\`\`\``;
    const multiFlags = flagHallucinations((await refineChanges(MULTI_FILE)).plan);
    console.log("multi-file flags:", multiFlags);
    if (multiFlags.some((f) => f.includes("./promotion"))) {
      throw new Error("same-change-set import falsely flagged as phantom");
    }

    // 3. agentic loop corrects into a valid unified diff
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/bad.ts"), "export const old = 0;\n");
    const goodDiff = `--- a/src/bad.ts
+++ b/src/bad.ts
@@ -1,1 +1,1 @@
-export const old = 0;
+export const bad = 1;
`;
    const stubGood = new StubProvider(goodDiff);
    const r2 = await refineChanges(HALLUCINATED, { provider: stubGood });
    console.log("refined:", r2.report.join(" | "), "| clean =", r2.clean, "| format =", r2.plan.format);
    if (!r2.clean || r2.plan.format !== "unified-diff") throw new Error("refine loop failed");

    // 4. yolo refuses unresolved hallucinations
    const lines = await offerApply(HALLUCINATED, async () => true, { yolo: true, provider: new GarbageProvider() });
    console.log(lines.join("\n"));
    if (!lines.some((l) => l.includes("yolo safety"))) throw new Error("yolo safety missing");
    if (readFileSync(join(dir, "src/bad.ts"), "utf8") !== "export const old = 0;\n") {
      throw new Error("hallucinated content was applied in yolo mode");
    }

    // 5. auto mode still lets the user decide (decline here)
    const lines2 = await offerApply(HALLUCINATED, async () => false, { provider: new GarbageProvider() });
    if (!lines2.some((l) => l.includes("not applied"))) throw new Error("auto decline path failed");
    console.log("auto decline OK");
  } finally {
    process.chdir(cwd);
  }
  console.log("refine-test OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
