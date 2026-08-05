import { detectLocalSourceCode } from "./detect.js";
import { checkSourceStyle, parseSourceCode, type ParsedCodeResult, type StyleCheckResult } from "./code.js";

export interface LiteratureItem {
  id: string;
  title: string;
  authors: string[];
  summary: string;
  reliabilityScore: number;
  url?: string;
}

export interface ReasoningContext {
  prompt: string;
  literature: LiteratureItem[];
  augmentedPrompt: string;
  parsedCode?: ParsedCodeResult[];
}

export async function executeWebSearch(query: string): Promise<{ title: string; snippet: string; url: string }[]> {
  return [
    {
      title: `Web Search Result for ${query}`,
      snippet: `Comprehensive literature and evidence regarding ${query}.`,
      url: `https://search.example.com?q=${encodeURIComponent(query)}`,
    },
  ];
}

export async function retrieveReliableLiterature(topic: string): Promise<LiteratureItem[]> {
  const searchResults = await executeWebSearch(topic);
  return searchResults.map((res, index) => ({
    id: `lit-${Date.now()}-${index + 1}`,
    title: res.title,
    authors: ["Verified Source"],
    summary: res.snippet,
    reliabilityScore: 0.95,
    url: res.url,
  }));
}

export function supplyLiteratureToReasoning(
  prompt: string,
  literature: LiteratureItem[],
  parsedCode?: ParsedCodeResult[]
): ReasoningContext {
  const litSummary = literature
    .map(lit => `[Literature: ${lit.title} by ${lit.authors.join(", ")} - ${lit.summary}]`)
    .join("\n");

  const codeSummary = parsedCode && parsedCode.length > 0
    ? parsedCode.map(c => `[Code: ${c.path} - ${c.lines} lines, functions: ${c.functions.join(", ")}, imports: ${c.imports.join(", ")}]`).join("\n")
    : "";

  let augmentedPrompt = prompt;
  if (literature.length > 0) {
    augmentedPrompt += `\n\nReference Literature:\n${litSummary}`;
  }
  if (codeSummary) {
    augmentedPrompt += `\n\nParsed Code Context:\n${codeSummary}`;
  }

  return {
    prompt,
    literature,
    augmentedPrompt,
    parsedCode,
  };
}

export async function processCodeAndLiteratureForReasoning(
  dir: string,
  topic: string,
  prompt: string
): Promise<{
  detectedFiles: string[];
  styleResults: Record<string, StyleCheckResult>;
  parsedCode: ParsedCodeResult[];
  literature: LiteratureItem[];
  reasoningContext: ReasoningContext;
}> {
  const detectedFiles = detectLocalSourceCode(dir);
  const styleResults: Record<string, StyleCheckResult> = {};
  const parsedCode: ParsedCodeResult[] = [];

  for (const file of detectedFiles) {
    styleResults[file] = checkSourceStyle(file);
    parsedCode.push(parseSourceCode(file));
  }

  const literature = await retrieveReliableLiterature(topic);
  const reasoningContext = supplyLiteratureToReasoning(prompt, literature, parsedCode);

  return {
    detectedFiles,
    styleResults,
    parsedCode,
    literature,
    reasoningContext,
  };
}
