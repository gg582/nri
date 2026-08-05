/** Unit test for the apply layer (no LLM). Run: npx tsx examples/apply-test.ts */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerApply, planApply, summarizePlan } from "../src/tools/apply.js";

const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 export default a;
--- a/src/b.ts
+++ b/src/b.ts
@@ -0,0 +1 @@
+export const b = 2;
`;

const BLOCKS = `Here is the implementation:

\`\`\`typescript
// src/calc.ts
export const add = (a: number, b: number) => a + b;
\`\`\`

\`\`\`typescript
// src/util/math.ts
export const mul = (a: number, b: number) => a * b;
\`\`\`
`;

async function main() {
  // --- parsing ---
  const d = planApply(DIFF);
  console.log("diff format:", d.format, "files:", d.changes.map((c) => c.path).join(","), "|", summarizePlan(d).join(" "));
  if (d.format !== "unified-diff" || d.changes.length !== 2) throw new Error("diff parse failed");

  const b = planApply(BLOCKS);
  console.log("blocks format:", b.format, "files:", b.changes.map((c) => c.path).join(","));
  if (b.format !== "file-blocks" || b.changes.length !== 2) throw new Error("block parse failed");

  const none = planApply("just some prose, no code markers");
  if (none.format !== "none") throw new Error("none parse failed");

  // path traversal guard
  const evil = planApply("```ts\n// ../escape.ts\nbad()\n```");
  if (evil.changes.length !== 0) throw new Error("path traversal not blocked");
  console.log("path traversal blocked OK");

  // --- application in a temp cwd ---
  const dir = mkdtempSync(join(tmpdir(), "nri-apply-"));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    // Keep this test independent from the user's global permission mode.
    // (The yolo cases below opt in explicitly.)
    writeFileSync(join(dir, "nri.config.json"), JSON.stringify({ permissions: { mode: "auto" } }));

    // file-blocks via yolo
    const lines1 = await offerApply(BLOCKS, async () => false, { yolo: true });
    console.log(lines1.join("\n"));
    if (readFileSync(join(dir, "src/calc.ts"), "utf8") !== "export const add = (a: number, b: number) => a + b;\n") {
      throw new Error("calc.ts content mismatch");
    }
    if (!existsSync(join(dir, "src/util/math.ts"))) throw new Error("math.ts missing");

    // unified diff via yolo (git apply)
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "const a = 1;\nexport default a;\n");
    const lines2 = await offerApply(DIFF, async () => false, { yolo: true });
    console.log(lines2.join("\n"));
    if (!readFileSync(join(dir, "src/a.ts"), "utf8").includes("const b = 2;")) throw new Error("git apply failed");
    if (!existsSync(join(dir, "src/b.ts"))) throw new Error("b.ts missing");

    // auto mode decline -> nothing written
    const lines3 = await offerApply(BLOCKS.replace("calc.ts", "declined.ts"), async () => false);
    console.log(lines3.join("\n"));
    if (existsSync(join(dir, "src/declined.ts"))) throw new Error("declined change was applied");

    // backup created
    if (!existsSync(join(dir, ".nri-backup"))) throw new Error("no backup dir");
    console.log("backup dir OK");
  } finally {
    process.chdir(cwd);
  }
  console.log("apply-test OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
