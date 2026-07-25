import {
  ParsedChangeRequest,
  DetectedSimpleChange,
  TaskGroup,
  EditOperation,
  VerificationStep,
} from '../graph/nodes.js';
import fs from 'fs';
import path from 'path';

export function plan(parsed: ParsedChangeRequest, detected: DetectedSimpleChange): TaskGroup {
  const excluded = new Set(parsed.scopeBoundaries.excludedModules);
  const filesToModify = parsed.scopeBoundaries.targetFiles.filter(file => {
    if (Array.from(excluded).some(ex => file.includes(ex))) return false;
    return fs.existsSync(file);
  });

  const editOperations: EditOperation[] = [];
  const desc = parsed.changeDescription.toLowerCase();

  for (const file of filesToModify) {
    if (desc.includes('rename') || desc.includes('naming')) {
      editOperations.push({ type: 'replace', file, oldText: 'placeholder_old', newText: 'placeholder_new' });
    } else if (desc.includes('format') || desc.includes('lint') || desc.includes('prettier') || desc.includes('whitespace')) {
      editOperations.push({ type: 'replace', file, oldText: '  ', newText: ' ' });
    } else if (desc.includes('delete') || desc.includes('remove')) {
      editOperations.push({ type: 'delete', file, oldText: 'placeholder' });
    } else if (desc.includes('insert') || desc.includes('add')) {
      editOperations.push({ type: 'insert', file, newText: 'placeholder', position: 0 });
    } else {
      editOperations.push({ type: 'replace', file, oldText: 'placeholder', newText: 'placeholder' });
    }
  }

  const verificationSteps: VerificationStep[] = [];
  for (const file of filesToModify) {
    const ext = path.extname(file);
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      verificationSteps.push({ name: `Type-check ${file}`, command: `npx tsc --noEmit ${file}`, tool: 'tsc' });
      verificationSteps.push({ name: `Lint ${file}`, command: `npx eslint ${file}`, tool: 'eslint' });
    } else if (ext === '.py') {
      verificationSteps.push({ name: `Compile ${file}`, command: `python -m py_compile ${file}`, tool: 'python' });
    }
  }

  verificationSteps.push({ name: 'Run tests', command: 'npm test', tool: 'npm' });

  const toolInvocations = [...new Set([
    'git',
    ...verificationSteps.map(v => v.tool),
    ...editOperations.map(() => 'sed'),
  ])];

  const orderedSteps = [
    'resolve-scope',
    'read-files',
    ...editOperations.map((_, i) => `edit-${i}`),
    ...verificationSteps.map((_, i) => `verify-${i}`),
  ];

  const dependencies: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < orderedSteps.length - 1; i++) {
    dependencies.push({ from: orderedSteps[i], to: orderedSteps[i + 1] });
  }

  const validated =
    filesToModify.every(file => editOperations.some(op => op.file === file)) &&
    editOperations.every(op =>
      verificationSteps.some(v => v.name.includes(path.extname(op.file)) || v.name === 'Run tests')
    );

  return {
    id: `task-group-${Date.now()}`,
    filesToModify,
    editOperations,
    verificationSteps,
    toolInvocations,
    orderedSteps,
    dependencies,
    validated,
  };
}
