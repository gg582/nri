import {
  detectLocalSourceCode,
  checkSourceStyle,
  parseSourceCode,
  executeWebSearch,
  retrieveReliableLiterature,
  supplyLiteratureToReasoning,
  processCodeAndLiteratureForReasoning,
} from "../src/index.js";

describe("NRI Local Code and Literature Pipeline", () => {
  test("detectLocalSourceCode finds source files", () => {
    const files = detectLocalSourceCode(".");
    expect(Array.isArray(files)).toBe(true);
  });

  test("checkSourceStyle checks line constraints and whitespace", () => {
    const result = checkSourceStyle("src/index.ts");
    expect(result).toHaveProperty("valid");
    expect(result).toHaveProperty("issues");
  });

  test("parseSourceCode extracts functions and imports", () => {
    const result = parseSourceCode("src/index.ts");
    expect(result).toHaveProperty("path");
    expect(result).toHaveProperty("lines");
    expect(result).toHaveProperty("functions");
    expect(result).toHaveProperty("imports");
  });

  test("executeWebSearch returns search results", async () => {
    const results = await executeWebSearch("test topic");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("title");
  });

  test("retrieveReliableLiterature builds literature items", async () => {
    const items = await retrieveReliableLiterature("test topic");
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveProperty("reliabilityScore");
  });

  test("supplyLiteratureToReasoning constructs augmented prompt", () => {
    const ctx = supplyLiteratureToReasoning("original prompt", [], []);
    expect(ctx.augmentedPrompt).toContain("original prompt");
  });

  test("processCodeAndLiteratureForReasoning orchestrates full pipeline", async () => {
    const result = await processCodeAndLiteratureForReasoning(".", "test topic", "test prompt");
    expect(result).toHaveProperty("detectedFiles");
    expect(result).toHaveProperty("styleResults");
    expect(result).toHaveProperty("parsedCode");
    expect(result).toHaveProperty("literature");
    expect(result).toHaveProperty("reasoningContext");
  });
});
