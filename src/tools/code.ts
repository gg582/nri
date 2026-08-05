import fs from "node:fs";

export interface StyleCheckResult {
  valid: boolean;
  issues: string[];
}

export interface ParsedCodeResult {
  path: string;
  lines: number;
  functions: string[];
  imports: string[];
}

export function checkSourceStyle(filePath: string): StyleCheckResult {
  if (!fs.existsSync(filePath)) {
    return { valid: false, issues: [`File not found: ${filePath}`] };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const issues: string[] = [];

  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    if (line.trimEnd() !== line) {
      issues.push(`Line ${idx + 1}: Trailing whitespace detected.`);
    }
    if (line.length > 120) {
      issues.push(`Line ${idx + 1}: Exceeds 120 characters.`);
    }
  });

  return {
    valid: issues.length === 0,
    issues,
  };
}

export function parseSourceCode(filePath: string): ParsedCodeResult {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, lines: 0, functions: [], imports: [] };
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const functions: string[] = [];
  const imports: string[] = [];

  for (const line of lines) {
    const fnMatch = line.match(/(?:function\s+([a-zA-Z0-9_]+)|const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(|def\s+([a-zA-Z0-9_]+))/);
    if (fnMatch) {
      const name = fnMatch[1] || fnMatch[2] || fnMatch[3];
      if (name) functions.push(name);
    }
    const impMatch = line.match(/(?:import\s+.*from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\))/);
    if (impMatch) {
      const imp = impMatch[1] || impMatch[2] || impMatch[3];
      if (imp) imports.push(imp);
    }
  }

  return {
    path: filePath,
    lines: lines.length,
    functions,
    imports,
  };
}
