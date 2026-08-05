import fs from "node:fs";
import path from "node:path";
import type { ParsedChangeRequest, DetectedSimpleChange, DetectedIndicator, SimpleChangeCategory } from '../graph/nodes.js';

const KEYWORD_MAP: Record<SimpleChangeCategory, string[]> = {
  'style-improvement': [
    'format', 'lint', 'prettier', 'eslint', 'semicolon', 'indent', 'whitespace',
    'trailing space', 'trailing whitespace', 'naming', 'rename', 'style', 'quote',
    'import order', 'sort imports',
  ],
  'regex-cleanup': [
    'regex', 'regexp', 'character class', 'escape', 'pattern', 'character-class',
  ],
  'convention-unification': [
    'convention', 'standardize', 'unify', 'consistent', 'quote style', 'file naming',
    'naming convention', 'coding standard',
  ],
  'equivalent-complexity': [
    'single-line', 'one-line', 'trivial', 'minor', 'typo', 'spelling', 'comment',
    'capitalization', 'case',
  ],
};

export function detectLocalSourceCode(dir: string = "."): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "coverage") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...detectLocalSourceCode(fullPath));
    } else if (/\.(js|ts|jsx|tsx|py|rs|go|c|cpp|h|java|rb|php)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export function detect(parsed: ParsedChangeRequest): DetectedSimpleChange {
  const text = `${parsed.changeDescription} ${parsed.businessContext}`.toLowerCase();
  const indicators: DetectedIndicator[] = [];

  (Object.keys(KEYWORD_MAP) as SimpleChangeCategory[]).forEach(category => {
    KEYWORD_MAP[category].forEach(keyword => {
      if (text.includes(keyword.toLowerCase())) {
        indicators.push({
          category,
          indicator: keyword,
          confidence: 0.8,
        });
      }
    });
  });

  const allowedCategories: SimpleChangeCategory[] = [
    'style-improvement',
    'regex-cleanup',
    'convention-unification',
    'equivalent-complexity',
  ];

  const allSimple = indicators.length > 0 && indicators.every(i => allowedCategories.includes(i.category));
  const scopeIsBounded =
    parsed.scopeBoundaries.targetFiles.length > 0 &&
    parsed.scopeBoundaries.targetFiles.length <= parsed.scopeBoundaries.maxChangeSize;

  const isSimple = allSimple && scopeIsBounded;

  return {
    isSimple,
    indicators,
    reason: isSimple
      ? 'All detected indicators are in allowed simple-change categories and scope is bounded.'
      : !allSimple
      ? 'Change contains indicators outside allowed simple-change categories.'
      : 'Scope is unbounded or too large.',
  };
}
