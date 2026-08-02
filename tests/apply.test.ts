import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planApply } from "../src/tools/apply.js";

describe("apply tool test", () => {
  it("parses file blocks correctly", () => {
    const code = "```ts\n// src/foo.ts\nconst a = 1;\n```";
    const plan = planApply(code);
    assert.equal(plan.format, "file-blocks");
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0].path, "src/foo.ts");
    assert.equal(plan.changes[0].content.trim(), "const a = 1;");
  });

  it("returns none for empty or invalid code", () => {
    const plan = planApply("hello world without any code blocks");
    assert.equal(plan.format, "none");
    assert.equal(plan.changes.length, 0);
  });

  it("parses a root-level source file block", () => {
    const plan = planApply("// main.py\nprint('hello')\n");
    assert.equal(plan.format, "file-blocks");
    assert.deepEqual(plan.changes.map((change) => change.path), ["main.py"]);
    assert.equal(plan.changes[0].content.trim(), "print('hello')");
  });
});
