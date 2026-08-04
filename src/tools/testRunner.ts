import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkPermission } from "./permissions.js";
import { planApply, type FileChange } from "./apply.js";

const execAsync = promisify(exec);

export interface TestRunResult {
  coverage: number; // 0..100
  passed: boolean;
  output: string;
  /** True when the code could not be evaluated at all (unknown language or
   * missing toolchain) — the pipeline must NOT loop on this. */
  unevaluable?: boolean;
}

/**
 * Coverage extraction: tries common reporter formats
 * ("All files | 87.5", "Coverage: 87.5%", "87.5%").
 */
export function parseCoverage(output: string): number | null {
  const patterns = [
    /All files\s*\|[^|]*\|[^|]*\|[^|]*\|\s*([\d.]+)/i, // istanbul table
    /coverage[:\s]+([\d.]+)\s*%/i,
    /([\d.]+)\s*%\s*(?:coverage|statements|tests passed)/i, // istanbul, ctest
    /PASSED\s*\(([\d.]+)\s*%\)/i,
  ];
  for (const re of patterns) {
    const m = output.match(re);
    if (m) return Number.parseFloat(m[1]);
  }
  if (/100%\s*tests passed|ALL PASSED|\[\s*PASSED\s*\]/i.test(output)) {
    return 100;
  }
  return null;
}

export interface TestSpec {
  testCode: string;
  runCommand?: string;
  coverageRegex?: string | null;
}

export interface TestRunner {
  run(code: string, testSpec: string | TestSpec, iteration: number): Promise<TestRunResult>;
}

type Lang = "python" | "cpp" | "ts" | "js" | "unknown";

const CPP_EXTS = new Set(["cpp", "cc", "cxx", "c++", "c", "h", "hpp"]);

function extOf(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function detectLang(changes: FileChange[]): Lang {
  const exts = changes.map((c) => extOf(c.path));
  if (exts.includes("py")) return "python";
  if (exts.some((e) => CPP_EXTS.has(e))) return "cpp";
  if (exts.some((e) => e === "ts" || e === "tsx")) return "ts";
  if (exts.some((e) => e === "js" || e === "mjs" || e === "cjs" || e === "jsx")) return "js";
  return "unknown";
}

/** Guess a single-file name from raw content when no file blocks were found. */
function sniffSingleFile(code: string): FileChange {
  if (/#\s*include\s*[<"]/.test(code)) return { path: "main.cpp", kind: "full-file", content: code };
  if (/^\s*(def |import |from |print\()/m.test(code)) return { path: "main.py", kind: "full-file", content: code };
  if (/\bfunction\b|=>|console\.log/.test(code)) return { path: "main.js", kind: "full-file", content: code };
  return { path: "main.txt", kind: "full-file", content: code };
}

function isInfraFailure(code: number, output: string): boolean {
  return code === 127 || /command not found|ENOENT|is not recognized|No such file or directory/.test(output);
}

/** Unwrap a whole-response markdown code fence, if the model added one. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const full = trimmed.match(/^```[\w-]*\n([\s\S]*?)```\s*$/);
  if (full) return full[1];
  // partial: stray fence on the first/last line
  const lines = trimmed.split("\n");
  if (lines[0]?.startsWith("```")) lines.shift();
  if (lines[lines.length - 1]?.trim() === "```") lines.pop();
  return lines.join("\n");
}

/**
 * Real runner: materializes generated files directly into the current project
 * directory and verifies them with a language-appropriate check:
 *   python — pytest when the model wrote pytest tests (else py_compile)
 *   cpp    — g++ -fsyntax-only
 *   ts     — npx tsc --noEmit
 *   js     — node --check
 * Verification passes => coverage 100 (the loop contract), fails => 0 with
 * the compiler/test output fed back into the next patch. Missing toolchains
 * and unknown languages report `unevaluable` so the pipeline finalizes
 * instead of burning loop iterations against a broken harness.
 *
 * Setting NRI_TEST_COMMAND explicitly restores the legacy behavior: run the
 * command as-is and parse a coverage percentage from its output.
 */
export class ShellTestRunner implements TestRunner {
  constructor(
    /** The project directory to update and verify. Defaults to the process cwd. */
    private readonly workspace = process.cwd(),
    private readonly command = process.env.NRI_TEST_COMMAND,
  ) {}

  private async exec(cmd: string, cwd: string): Promise<{ code: number; output: string }> {
    const gate = checkPermission(cmd);
    if (!gate.allowed) return { code: 126, output: `permission denied: ${gate.reason}` };
    const advisory = gate.advisory ? `[warn] ${gate.advisory}\n` : "";
    try {
      const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 120_000 });
      return { code: 0, output: `${advisory}${stdout}\n${stderr}` };
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const code = typeof e.code === "number" ? e.code : 1;
      return { code, output: `${advisory}${e.stdout ?? ""}\n${e.stderr ?? e.message ?? String(err)}` };
    }
  }

  /** Legacy path: explicit NRI_TEST_COMMAND + coverage parsing. */
  private async runLegacy(dir: string, code: string, tests: string): Promise<TestRunResult> {
    await writeFile(join(dir, "implementation.ts"), code, "utf8");
    await writeFile(join(dir, "implementation.test.ts"), tests, "utf8");
    const { code: exitCode, output } = await this.exec(this.command!, dir);
    const coverage = parseCoverage(output);
    if (exitCode === 0 && coverage !== null) return { coverage, passed: true, output };
    if (isInfraFailure(exitCode, output)) {
      return { coverage: coverage ?? 0, passed: false, output, unevaluable: true };
    }
    return { coverage: coverage ?? 0, passed: false, output };
  }

  async run(code: string, testInput: string | TestSpec, iteration: number): Promise<TestRunResult> {
    const spec: TestSpec =
      typeof testInput === "string" ? { testCode: testInput } : testInput;
    const tests = spec.testCode;

    // Keep generated files in the target project.  A per-iteration workspace
    // made verified changes invisible to the user until a separate apply step.
    const dir = this.workspace;
    await mkdir(dir, { recursive: true });
    if (this.command) return this.runLegacy(dir, code, tests);

    const plan = planApply(code);
    const changes = plan.changes.length > 0 ? plan.changes : [sniffSingleFile(stripCodeFence(code))];
    for (const c of changes) {
      const dest = join(dir, c.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, c.content, "utf8");
    }

    // Materialize test code files if returned as file blocks or single file
    if (tests) {
      const testPlan = planApply(tests);
      const testChanges = testPlan.changes.length > 0 ? testPlan.changes : [{ path: "test_runner_generated", kind: "full-file" as const, content: stripCodeFence(tests) }];
      for (const tc of testChanges) {
        const dest = join(dir, tc.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, tc.content, "utf8");
      }
    }

    // AI-Driven Dynamic Execution: if AI provided a runCommand, execute it directly
    if (spec.runCommand) {
      const res = await this.exec(spec.runCommand, dir);
      let coverage = parseCoverage(res.output);
      if (coverage === null && spec.coverageRegex) {
        try {
          const match = res.output.match(new RegExp(spec.coverageRegex, "i"));
          if (match && match[1]) coverage = Number.parseFloat(match[1]);
        } catch {
          /* invalid user regex ignored */
        }
      }
      if (res.code === 0) {
        return {
          coverage: coverage ?? 100,
          passed: true,
          output: `AI command passed (${spec.runCommand})\n${res.output}`,
        };
      }
      if (isInfraFailure(res.code, res.output)) {
        return { coverage: coverage ?? 0, passed: false, output: res.output, unevaluable: true };
      }
      return { coverage: coverage ?? 0, passed: false, output: res.output };
    }

    const lang = detectLang(changes);
    switch (lang) {
      case "python":
        return this.verifyPython(dir, changes, tests);
      case "cpp":
        return this.verifyCpp(dir, changes, tests);
      case "ts":
        return this.verifyCompile(dir, "npx --yes tsc --noEmit --skipLibCheck", changes, ["ts", "tsx"]);
      case "js":
        return this.verifyJs(dir, changes);
      default:
        return {
          coverage: 0,
          passed: false,
          output: "no verifier for this language — skipped evaluation",
          unevaluable: true,
        };
    }
  }

  private async verifyPython(dir: string, changes: FileChange[], tests: string): Promise<TestRunResult> {
    // Run the model's own tests with pytest when they look like pytest tests.
    // Models often wrap the response in a markdown fence despite instructions
    // — strip it, or collection fails with a SyntaxError every iteration.
    if (/def test_|import unittest|class Test/.test(tests)) {
      await writeFile(join(dir, "test_generated.py"), stripCodeFence(tests), "utf8");
      const res = await this.exec("python3 -m pytest -q --tb=short test_generated.py", dir);
      if (!/No module named pytest/.test(res.output)) {
        return res.code === 0
          ? { coverage: 100, passed: true, output: `pytest passed\n${res.output}` }
          : isInfraFailure(res.code, res.output)
            ? { coverage: 0, passed: false, output: res.output, unevaluable: true }
            : { coverage: 0, passed: false, output: res.output };
      }
      // pytest unavailable — fall through to a syntax check.
    }
    return this.verifyCompile(dir, "python3 -m py_compile", changes, ["py"]);
  }

  private async verifyCpp(dir: string, changes: FileChange[], tests: string): Promise<TestRunResult> {
    const isHeader = (p: string) => ["h", "hpp"].includes(extOf(p));
    const sources = changes.filter((c) => CPP_EXTS.has(extOf(c.path)) && !isHeader(c.path));
    const targets = sources.length > 0 ? sources : changes.filter((c) => CPP_EXTS.has(extOf(c.path)));

    // Try CMake build & test execution if CMakeLists.txt exists
    if (changes.some((c) => c.path === "CMakeLists.txt")) {
      const buildRes = await this.exec("cmake -S . -B build && cmake --build build -j4", dir);
      if (buildRes.code !== 0) {
        return isInfraFailure(buildRes.code, buildRes.output)
          ? { coverage: 0, passed: false, output: buildRes.output, unevaluable: true }
          : { coverage: 0, passed: false, output: buildRes.output };
      }
      const ctestRes = await this.exec("ctest --test-dir build --output-on-failure", dir);
      const parsedCov = parseCoverage(ctestRes.output);
      if (ctestRes.code === 0) {
        return {
          coverage: parsedCov ?? 100,
          passed: true,
          output: `ctest passed\n${ctestRes.output}`,
        };
      }
      return { coverage: parsedCov ?? 0, passed: false, output: ctestRes.output };
    }

    // Direct test runner compile if standalone test code was written
    if (tests && /main\s*\(/.test(tests)) {
      await writeFile(join(dir, "test_runner.cpp"), stripCodeFence(tests), "utf8");
      const srcFiles = targets.map((f) => JSON.stringify(f.path)).join(" ");
      const compileRes = await this.exec(`g++ -std=c++17 ${srcFiles} test_runner.cpp -Iinclude -Isrc -o test_runner`, dir);
      if (compileRes.code === 0) {
        const runRes = await this.exec("./test_runner", dir);
        const parsedCov = parseCoverage(runRes.output);
        return runRes.code === 0
          ? { coverage: parsedCov ?? 100, passed: true, output: runRes.output }
          : { coverage: parsedCov ?? 0, passed: false, output: runRes.output };
      }
    }

    // Fallback: g++ syntax check
    return this.verifyCompile(dir, "g++ -fsyntax-only -Iinclude -Isrc", targets, [...CPP_EXTS]);
  }

  private async verifyCompile(
    dir: string,
    tool: string,
    changes: FileChange[],
    exts: string[],
  ): Promise<TestRunResult> {
    const files = changes.filter((c) => exts.includes(extOf(c.path))).map((c) => c.path);
    if (files.length === 0) {
      return { coverage: 0, passed: false, output: "no sources to verify", unevaluable: true };
    }
    const res = await this.exec(`${tool} ${files.map((f) => JSON.stringify(f)).join(" ")}`, dir);
    if (res.code === 0) {
      return { coverage: 100, passed: true, output: `verification passed (${tool.split(" ")[0]})\n${res.output}` };
    }
    if (isInfraFailure(res.code, res.output)) {
      return { coverage: 0, passed: false, output: res.output, unevaluable: true };
    }
    return { coverage: 0, passed: false, output: res.output };
  }

  private async verifyJs(dir: string, changes: FileChange[]): Promise<TestRunResult> {
    const files = changes.filter((c) => ["js", "mjs", "cjs", "jsx"].includes(extOf(c.path)));
    if (files.length === 0) {
      return { coverage: 0, passed: false, output: "no sources to verify", unevaluable: true };
    }
    for (const f of files) {
      const res = await this.exec(`node --check ${JSON.stringify(f.path)}`, dir);
      if (res.code !== 0) {
        return isInfraFailure(res.code, res.output)
          ? { coverage: 0, passed: false, output: res.output, unevaluable: true }
          : { coverage: 0, passed: false, output: res.output };
      }
    }
    return { coverage: 100, passed: true, output: "verification passed (node --check)" };
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
