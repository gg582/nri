import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkPermission } from "./permissions.js";

const execAsync = promisify(exec);

export interface TestRunResult {
  coverage: number; // 0..100
  passed: boolean;
  output: string;
}

/**
 * Coverage extraction: tries common reporter formats
 * ("All files | 87.5", "Coverage: 87.5%", "87.5%").
 */
export function parseCoverage(output: string): number | null {
  const patterns = [
    /All files\s*\|[^|]*\|[^|]*\|[^|]*\|\s*([\d.]+)/i, // istanbul table
    /coverage[:\s]+([\d.]+)\s*%/i,
    /([\d.]+)\s*%\s*(?:coverage|statements)/i,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return Number.parseFloat(m[1]);
  }
  return null;
}

export interface TestRunner {
  run(code: string, tests: string, iteration: number): Promise<TestRunResult>;
}

/**
 * Real runner: materializes code + tests into a workspace directory and
 * executes the configured shell command (NRI_TEST_COMMAND), parsing the
 * coverage percentage from its output.
 */
export class ShellTestRunner implements TestRunner {
  constructor(
    private readonly workspace = process.env.NRI_WORKSPACE ?? ".nri-workspace",
    private readonly command = process.env.NRI_TEST_COMMAND ?? "npm test -- --coverage",
  ) {}

  async run(code: string, tests: string, iteration: number): Promise<TestRunResult> {
    const gate = checkPermission(this.command);
    if (!gate.allowed) {
      return { coverage: 0, passed: false, output: `permission denied: ${gate.reason}` };
    }
    const advisory = gate.advisory ? `[warn] ${gate.advisory}\n` : "";
    const dir = join(this.workspace, `iter-${iteration}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "implementation.ts"), code, "utf8");
    await writeFile(join(dir, "implementation.test.ts"), tests, "utf8");
    try {
      const { stdout, stderr } = await execAsync(this.command, { cwd: dir, timeout: 120_000 });
      const output = `${advisory}${stdout}\n${stderr}`;
      const coverage = parseCoverage(output);
      if (coverage === null) throw new Error(`Could not parse coverage from test output:\n${output}`);
      return { coverage, passed: true, output };
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      const coverage = parseCoverage(output) ?? 0;
      return { coverage, passed: false, output };
    }
  }
}

/**
 * Mock runner for dry runs / demos (NRI_TEST_MODE=mock): simulates a
 * coverage ramp so the loop can be exercised without a real test suite.
 */
export class MockTestRunner implements TestRunner {
  async run(_code: string, _tests: string, iteration: number): Promise<TestRunResult> {
    const coverage = Math.min(40 + iteration * 20, 100);
    return { coverage, passed: true, output: `[mock] coverage=${coverage}%` };
  }
}

export function createTestRunner(): TestRunner {
  return process.env.NRI_TEST_MODE === "mock" ? new MockTestRunner() : new ShellTestRunner();
}
