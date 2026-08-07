import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flagHallucinations } from '../src/tools/hallucination.js';
import type { ApplyPlan } from '../src/tools/apply.js';

describe('flagHallucinations relaxed rules', () => {
  it('should not flag imports of packages in node_modules or standard node builtins', () => {
    const plan: ApplyPlan = {
      format: "file-blocks",
      changes: [
        {
          path: "src/test_import.ts",
          kind: "full-file",
          content: 'import { existsSync } from "node:fs";\nimport { join } from "path";\nimport { z } from "zod";\n'
        }
      ]
    };
    const flags = flagHallucinations(plan);
    // Since zod is in package.json, it should not be flagged.
    assert.deepEqual(flags, []);
  });

  it('should not flag duplicate checking for common filenames', () => {
    const plan: ApplyPlan = {
      format: "file-blocks",
      changes: [
        {
          path: "src/utils.ts",
          kind: "full-file",
          content: 'export const add = (a: number, b: number) => a + b;\n'
        }
      ]
    };
    const flags = flagHallucinations(plan);
    assert.deepEqual(flags, []);
  });

  it('should not flag moderate export drops during full-file overwrite', () => {
    // Creating a dummy file with 3 exports, then overwriting it to drop 1 export.
    const plan: ApplyPlan = {
      format: "file-blocks",
      changes: [
        {
          path: "src/tools/index.ts", // this file exists and exports 4 things
          kind: "full-file",
          content: 'export * from "./apply.js";\nexport * from "./bypass.js";\nexport * from "./bash.js";\n' // dropped webSearch
        }
      ]
    };
    const flags = flagHallucinations(plan);
    assert.deepEqual(flags, []);
  });
});
