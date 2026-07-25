import type { TaskGroup, ExecutionPath, ExecutionResult } from '../graph/nodes.js';
import { applyQuickDiffPatch } from './apply.js';
import { execSync } from 'child_process';
import fs from 'fs';

function generateDiffFromEdits(taskGroup: TaskGroup): string {
  const hunks: string[] = [];
  for (const op of taskGroup.editOperations) {
    const content = fs.readFileSync(op.file, 'utf-8');
    const lines = content.split('\n');
    if (op.type === 'replace' && op.oldText && op.newText) {
      const oldText = op.oldText;
      const index = lines.findIndex(l => l.includes(oldText));
      if (index >= 0) {
        const oldLine = lines[index]!;
        const newLine = oldLine.replace(op.oldText, op.newText);
        hunks.push(`--- a/${op.file}`);
        hunks.push(`+++ b/${op.file}`);
        hunks.push(`@@ -${index + 1},1 +${index + 1},1 @@`);
        hunks.push(`-${oldLine}`);
        hunks.push(`+${newLine}`);
      }
    } else if (op.type === 'insert' && op.newText) {
      hunks.push(`--- a/${op.file}`);
      hunks.push(`+++ b/${op.file}`);
      hunks.push(`@@ -0,0 +1,1 @@`);
      hunks.push(`+${op.newText}`);
    } else if (op.type === 'delete' && op.oldText) {
      const oldText = op.oldText;
      const index = lines.findIndex(l => l.includes(oldText));
      if (index >= 0) {
        hunks.push(`--- a/${op.file}`);
        hunks.push(`+++ b/${op.file}`);
        hunks.push(`@@ -${index + 1},1 +${index + 1},0 @@`);
        hunks.push(`-${lines[index]!}`);
      }
    }
  }
  return hunks.join('\n');
}

export async function execute(taskGroup: TaskGroup, path: ExecutionPath): Promise<ExecutionResult> {
  const result: ExecutionResult = {
    path,
    success: false,
    appliedFiles: [],
    diff: '',
    errors: [],
  };

  if (path === 'quick-diff-patch') {
    const diff = generateDiffFromEdits(taskGroup);
    result.diff = diff;
    try {
      applyQuickDiffPatch(diff);
      result.appliedFiles = taskGroup.filesToModify;
      result.success = true;
    } catch (err) {
      result.errors.push(String(err));
      result.success = false;
    }
  } else {
    try {
      execSync('npm run decision-graph', { stdio: 'inherit' });
      result.success = true;
    } catch (err) {
      result.errors.push(String(err));
      result.success = false;
    }
  }

  return result;
}
