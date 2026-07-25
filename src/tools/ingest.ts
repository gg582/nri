import type { ParsedChangeRequest, ScopeBoundaries } from '../graph/nodes.js';

export async function ingest(rawRequest: string): Promise<ParsedChangeRequest> {
  const lines = rawRequest.split('\n').map(l => l.trim()).filter(Boolean);

  const changeDescription = lines[0] || rawRequest.slice(0, 200);
  const businessContext = lines.slice(1).join(' ') || 'No additional business context provided.';

  const targetFiles: string[] = [];
  const excludedModules: string[] = [];
  let maxChangeSize = 100;

  const fileRegex = /(?:file|path|files?)\s*[:=]\s*([^\n]+)/gi;
  const excludeRegex = /(?:exclude|skip|ignore)\s*[:=]\s*([^\n]+)/gi;
  const sizeRegex = /(?:max|limit|size)\s*[:=]\s*(\d+)/i;

  let match;
  while ((match = fileRegex.exec(rawRequest)) !== null) {
    targetFiles.push(...match[1].split(/[,\s]+/).filter(Boolean));
  }
  while ((match = excludeRegex.exec(rawRequest)) !== null) {
    excludedModules.push(...match[1].split(/[,\s]+/).filter(Boolean));
  }
  const sizeMatch = sizeRegex.exec(rawRequest);
  if (sizeMatch) {
    maxChangeSize = parseInt(sizeMatch[1], 10);
  }

  if (targetFiles.length === 0) {
    const codeFileRegex = /(?:src\/|examples\/|lib\/|test\/|tests\/)[\w\-\/\.]+/g;
    const codeMatches = rawRequest.match(codeFileRegex);
    if (codeMatches) {
      targetFiles.push(...codeMatches);
    }
  }

  const scopeBoundaries: ScopeBoundaries = {
    targetFiles: [...new Set(targetFiles)],
    excludedModules: [...new Set(excludedModules)],
    maxChangeSize,
  };

  return {
    changeDescription,
    businessContext,
    scopeBoundaries,
    rawRequest,
  };
}
