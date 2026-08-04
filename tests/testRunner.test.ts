import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShellTestRunner } from "../src/tools/testRunner.js";

describe("ShellTestRunner", () => {
  it("writes generated files directly to the target project directory", async () => {
    const project = await mkdtemp(join(tmpdir(), "nri-test-runner-"));
    try {
      const result = await new ShellTestRunner(project).run(
        "// src/generated.js\nexport const answer = 42;\n",
        "",
        1,
      );

      assert.equal(result.passed, true);
      assert.equal(await readFile(join(project, "src/generated.js"), "utf8"), "export const answer = 42;\n");
      await assert.rejects(readFile(join(project, "iter-1/src/generated.js"), "utf8"));
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
