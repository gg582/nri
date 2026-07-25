import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type ReportFinding = {
  id: string;
  category: "coverage" | "implementation" | "security" | "quality";
  observation: string;
  recommendation: string;
};

export type DevelopmentReport = {
  generatedAt: string;
  scope: string;
  findings: ReportFinding[];
  approvedFixes: string[];
  appliedChanges: string[];
};

export type ReportCommandOptions = {
  cwd?: string;
  write?: (message: string) => void;
  /**
   * The caller must connect this to the application's normal explicit approval
   * flow. A fix is never applied when this callback is absent or declines it.
   */
  approveFix?: (finding: ReportFinding) => Promise<boolean> | boolean;
  /** Applies an already approved fix. This command never creates commits. */
  applyApprovedFix?: (finding: ReportFinding) => Promise<string | void> | string | void;
};

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rb", ".php", ".cs"]);

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function trackedFiles(cwd: string): string[] {
  try {
    return run("git", ["ls-files"], cwd).split("\n").filter(Boolean);
  } catch {
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        if (IGNORED_DIRECTORIES.has(entry)) continue;
        const path = join(directory, entry);
        const stats = statSync(path);
        if (stats.isDirectory()) visit(path);
        else files.push(relative(cwd, path));
      }
    };
    visit(cwd);
    return files;
  }
}

function addFinding(
  findings: ReportFinding[],
  category: ReportFinding["category"],
  observation: string,
  recommendation: string,
): void {
  findings.push({
    id: `${category}-${findings.length + 1}`,
    category,
    observation,
    recommendation,
  });
}

function inspectSource(files: string[], cwd: string, findings: ReportFinding[]): void {
  let hasTests = false;

  for (const file of files) {
    if (/([./_-])(test|spec)\.[^.]+$/i.test(file) || file.includes("__tests__/")) hasTests = true;
    if (!SOURCE_EXTENSIONS.has(file.slice(file.lastIndexOf(".")))) continue;

    let source: string;
    try {
      source = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue;
    }

    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(source)) {
      addFinding(
        findings,
        "security",
        `${file} uses dynamic code execution, which can expose untrusted input to code injection.`,
        "Replace dynamic evaluation with an explicit parser or a bounded dispatch table.",
      );
    }
    if (/(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\s]{8,}/i.test(source)) {
      addFinding(
        findings,
        "security",
        `${file} appears to contain a hard-coded credential or token.`,
        "Move the value to a secret manager or environment configuration and rotate the exposed value.",
      );
    }
    if (/\.innerHTML\s*=/.test(source)) {
      addFinding(
        findings,
        "security",
        `${file} assigns to innerHTML and may permit cross-site scripting when input is not trusted.`,
        "Use textContent or sanitize the value before assigning HTML.",
      );
    }
    if (/\bTODO\b|\bFIXME\b/.test(source)) {
      addFinding(
        findings,
        "implementation",
        `${file} contains an unfinished-work marker.`,
        "Confirm the marker is tracked and either implement the missing behavior or remove stale work items.",
      );
    }
  }

  if (!hasTests) {
    addFinding(
      findings,
      "coverage",
      "No test files were found among the tracked project files.",
      "Add focused tests for expected behavior, failures, and boundary conditions before changing implementation code.",
    );
  }
}

export function generateDevelopmentReport(cwd = process.cwd(), scope = "working tree"): DevelopmentReport {
  const findings: ReportFinding[] = [];
  const files = trackedFiles(cwd);
  const packageJson = join(cwd, "package.json");

  if (existsSync(packageJson)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      if (!scripts.test && !scripts.coverage) {
        addFinding(
          findings,
          "coverage",
          "package.json does not define a test or coverage script.",
          "Add a repeatable test command and a coverage command so coverage checks can run in development and CI.",
        );
      }
    } catch {
      addFinding(
        findings,
        "quality",
        "package.json could not be parsed for test and coverage configuration.",
        "Correct the package manifest before relying on automated coverage reporting.",
      );
    }
  }

  inspectSource(files, cwd, findings);
  return {
    generatedAt: new Date().toISOString(),
    scope,
    findings,
    approvedFixes: [],
    appliedChanges: [],
  };
}

export function reportAsMarkdown(report: DevelopmentReport): string {
  const lines = [
    "# Development Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Scope: ${report.scope}`,
    "",
    "## Observations and Recommendations",
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("No potential problems were identified by the configured checks.");
  } else {
    for (const finding of report.findings) {
      lines.push(`### ${finding.id} (${finding.category})`);
      lines.push(`- **Observation:** ${finding.observation}`);
      lines.push(`- **Recommendation:** ${finding.recommendation}`);
      lines.push("");
    }
  }

  lines.push("## Approved Fixes", "");
  lines.push(report.approvedFixes.length ? report.approvedFixes.map((fix) => `- ${fix}`).join("\n") : "None.");
  lines.push("", "## Applied Changes", "");
  lines.push(report.appliedChanges.length ? report.appliedChanges.map((change) => `- ${change}`).join("\n") : "None. Reporting does not create commits.", "");
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function reportAsHtml(report: DevelopmentReport): string {
  const findings = report.findings.length
    ? report.findings.map((finding) => `<article><h2>${escapeHtml(finding.id)} (${escapeHtml(finding.category)})</h2><p><strong>Observation:</strong> ${escapeHtml(finding.observation)}</p><p><strong>Recommendation:</strong> ${escapeHtml(finding.recommendation)}</p></article>`).join("\n")
    : "<p>No potential problems were identified by the configured checks.</p>";
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Development Report</title></head><body><h1>Development Report</h1><p>Generated: ${escapeHtml(report.generatedAt)}</p><p>Scope: ${escapeHtml(report.scope)}</p><h2>Observations and Recommendations</h2>${findings}<h2>Approved Fixes</h2><p>${escapeHtml(report.approvedFixes.join("; ") || "None.")}</p><h2>Applied Changes</h2><p>${escapeHtml(report.appliedChanges.join("; ") || "None. Reporting does not create commits.")}</p></body></html>\n`;
}

function ensureGitHubAccess(cwd: string): void {
  try {
    run("gh", ["--version"], cwd);
  } catch {
    throw new Error("GitHub CLI (gh) is required for pull-request reporting. Install gh and try again.");
  }
  try {
    run("gh", ["auth", "status"], cwd);
  } catch {
    throw new Error("GitHub CLI authentication is required. Run 'gh auth login' and try again.");
  }
}

function pullRequestDiff(number: string, cwd: string): string {
  ensureGitHubAccess(cwd);
  return run("gh", ["pr", "diff", number], cwd);
}

function findingsFromDiff(diff: string): ReportFinding[] {
  const report = generateDevelopmentReport(process.cwd(), "pull request diff");
  const findings = report.findings;
  if (/^\+.*\beval\s*\(/m.test(diff)) {
    addFinding(findings, "security", "The pull request adds eval usage.", "Avoid dynamic evaluation in pull-request code.");
  }
  if (/^\+.*(?:api[_-]?key|secret|password|token)\s*[:=]/im.test(diff)) {
    addFinding(findings, "security", "The pull request may add a credential-like value.", "Store credentials outside source control and rotate any exposed secret.");
  }
  return findings;
}

export async function runReportCommand(args: string[], options: ReportCommandOptions = {}): Promise<DevelopmentReport> {
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? ((message: string) => process.stdout.write(`${message}\n`));
  const [mode, number] = args;

  if (mode === "markdown") {
    const report = generateDevelopmentReport(cwd);
    writeFileSync(join(cwd, "REPORT.md"), reportAsMarkdown(report), "utf8");
    write("Report written to REPORT.md (not committed).");
    return report;
  }

  if (mode === "html") {
    const report = generateDevelopmentReport(cwd);
    writeFileSync(join(cwd, "REPORT.html"), reportAsHtml(report), "utf8");
    write("Report written to REPORT.html (not committed).");
    return report;
  }

  if (mode === "pr") {
    if (!number && args[1] !== "create") throw new Error("Usage: /report pr create|edit <pull_request_number>|review <pull_request_number>");
    const action = args[1];
    const prNumber = args[2];

    if (action === "create") {
      ensureGitHubAccess(cwd);
      const report = generateDevelopmentReport(cwd);
      const temporaryBody = join(cwd, ".report-pr-body.md");
      writeFileSync(temporaryBody, reportAsMarkdown(report), "utf8");
      try {
        const url = run("gh", ["pr", "create", "--draft", "--title", "Development report", "--body-file", temporaryBody], cwd);
        write(`Draft pull request created: ${url}`);
      } finally {
        rmSync(temporaryBody, { force: true });
      }
      return report;
    }

    if (!prNumber || !/^\d+$/.test(prNumber)) throw new Error("A numeric pull request number is required.");
    const diff = pullRequestDiff(prNumber, cwd);
    const report: DevelopmentReport = {
      generatedAt: new Date().toISOString(),
      scope: `pull request #${prNumber}`,
      findings: findingsFromDiff(diff),
      approvedFixes: [],
      appliedChanges: [],
    };

    if (action === "review") {
      run("gh", ["pr", "review", prNumber, "--comment", "--body", reportAsMarkdown(report)], cwd);
      write(`Review comments posted to pull request #${prNumber}; no code was modified.`);
      return report;
    }

    if (action === "edit") {
      for (const finding of report.findings) {
        if (!options.approveFix || !await options.approveFix(finding)) continue;
        report.approvedFixes.push(`${finding.id}: ${finding.recommendation}`);
        if (options.applyApprovedFix) {
          const change = await options.applyApprovedFix(finding);
          if (change) report.appliedChanges.push(change);
        }
      }
      run("gh", ["pr", "comment", prNumber, "--body", reportAsMarkdown(report)], cwd);
      write(`Pull request #${prNumber} was inspected. Only explicitly approved fixes were eligible for application; no commit was created.`);
      return report;
    }

    throw new Error("Usage: /report pr create|edit <pull_request_number>|review <pull_request_number>");
  }

  if (mode) throw new Error("Usage: /report [markdown|html|pr create|pr edit <pull_request_number>|pr review <pull_request_number>]");
  const report = generateDevelopmentReport(cwd);
  write(reportAsMarkdown(report));
  return report;
}
