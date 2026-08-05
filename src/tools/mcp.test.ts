import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const client = {
    connect: vi.fn(),
    close: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
  };
  const fallbackRun = vi.fn();

  return {
    checkPermission: vi.fn(),
    executeBash: vi.fn(),
    parseCoverage: vi.fn(),
    fallbackRun,
    client,
  };
});

vi.mock("./permissions.js", () => ({
  checkPermission: mocks.checkPermission,
}));

vi.mock("./bash.js", () => ({
  executeBash: mocks.executeBash,
}));

vi.mock("./testRunner.js", () => ({
  parseCoverage: mocks.parseCoverage,
  ShellTestRunner: class {
    run = mocks.fallbackRun;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(public readonly options: unknown) {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    constructor() {
      return mocks.client;
    }
  },
}));

import {
  AUTOMATED_ML_TOOL,
  MCP_TOOLS,
  McpCoverageRunner,
  SHELL_EXECUTION_TOOL,
  handleMlTrainAndEvaluate,
  handleShellExecution,
} from "./mcp.js";

describe("MCP tool definitions", () => {
  it("publishes shell execution and automated ML tools with required inputs", () => {
    expect(MCP_TOOLS).toEqual([SHELL_EXECUTION_TOOL, AUTOMATED_ML_TOOL]);
    expect(SHELL_EXECUTION_TOOL.inputSchema.required).toEqual(["command"]);
    expect(AUTOMATED_ML_TOOL.inputSchema.required).toEqual([
      "datasetPath",
      "targetColumn",
    ]);
    expect(AUTOMATED_ML_TOOL.inputSchema.properties.taskType).toMatchObject({
      enum: ["classification", "regression", "auto"],
    });
  });
});

describe("handleShellExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("denies execution when the permission gate rejects it", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: false, reason: "policy" });

    await expect(handleShellExecution({ command: "echo unsafe" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Permission denied: policy" }],
    });
    expect(mocks.executeBash).not.toHaveBeenCalled();
  });

  it("executes an allowed command and serializes its process result", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: true });
    mocks.executeBash.mockResolvedValue({
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
      error: undefined,
    });

    const response = await handleShellExecution({
      command: "echo done",
      cwd: "/tmp/project",
      timeout: 1234,
    });

    expect(mocks.executeBash).toHaveBeenCalledWith("echo done", {
      cwd: "/tmp/project",
      timeout: 1234,
    });
    expect(response.isError).toBe(false);
    expect(JSON.parse(response.content[0].text)).toEqual({
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("marks a non-zero shell result as an error", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: true });
    mocks.executeBash.mockResolvedValue({
      stdout: "",
      stderr: "failure",
      exitCode: 1,
      error: "failed",
    });

    const response = await handleShellExecution({ command: "false" });

    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      stderr: "failure",
      exitCode: 1,
      error: "failed",
    });
  });
});

describe("handleMlTrainAndEvaluate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects requests blocked by permission", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: false, reason: "disabled" });

    const response = await handleMlTrainAndEvaluate({
      datasetPath: "data.csv",
      targetColumn: "label",
    });

    expect(response).toEqual({
      isError: true,
      content: [{ type: "text", text: "Permission denied: disabled" }],
    });
    expect(mocks.executeBash).not.toHaveBeenCalled();
  });

  it("requires both datasetPath and targetColumn", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: true });

    const response = await handleMlTrainAndEvaluate({ datasetPath: "data.csv" });

    expect(response).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "datasetPath and targetColumn are required for ML training.",
        },
      ],
    });
    expect(mocks.executeBash).not.toHaveBeenCalled();
  });

  it("runs the generated Python training command and returns stdout on success", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: true });
    mocks.executeBash.mockResolvedValue({
      exitCode: 0,
      stdout: '{"status":"success"}',
      stderr: "",
    });

    const response = await handleMlTrainAndEvaluate({
      datasetPath: "my data.csv",
      targetColumn: "target",
      taskType: "classification",
      modelType: "linear",
      epochs: 20,
      testSize: 0.3,
    });

    expect(mocks.executeBash).toHaveBeenCalledOnce();
    const command = mocks.executeBash.mock.calls[0][0] as string;
    expect(command).toContain("python3 -c");
    expect(command).toContain("my data.csv");
    expect(command).toContain('"targetColumn":"target"');
    expect(response).toEqual({
      isError: false,
      content: [{ type: "text", text: '{"status":"success"}' }],
    });
  });

  it("returns stderr, or stdout when stderr is absent, after training failure", async () => {
    mocks.checkPermission.mockReturnValue({ allowed: true });
    mocks.executeBash.mockResolvedValue({ exitCode: 1, stdout: "fallback", stderr: "bad data" });

    const response = await handleMlTrainAndEvaluate({
      datasetPath: "data.csv",
      targetColumn: "target",
    });

    expect(response).toEqual({
      isError: true,
      content: [{ type: "text", text: "bad data" }],
    });
  });
});

describe("McpCoverageRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NRI_MCP_TOOL;
    mocks.checkPermission.mockReturnValue({ allowed: true });
  });

  it("uses ShellTestRunner when no MCP server command is configured", async () => {
    mocks.fallbackRun.mockResolvedValue({ coverage: 81, passed: true, output: "local" });
    const runner = new McpCoverageRunner("");

    await expect(runner.run("code", "tests", 2)).resolves.toEqual({
      coverage: 81,
      passed: true,
      output: "local",
    });
    expect(mocks.fallbackRun).toHaveBeenCalledWith("code", "tests", 2);
  });

  it("uses a discovered MCP coverage tool and parses its output", async () => {
    mocks.client.listTools.mockResolvedValue({
      tools: [{ name: "run_coverage" }, { name: "other" }],
    });
    mocks.client.callTool.mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "Statements: 87.5%" }],
    });
    mocks.parseCoverage.mockReturnValue(87.5);
    const runner = new McpCoverageRunner("node", ["server.js"]);

    const result = await runner.run("const x = 1", "expect(x).toBe(1)", 1);

    expect(mocks.client.connect).toHaveBeenCalledOnce();
    expect(mocks.client.callTool).toHaveBeenCalledWith({
      name: "run_coverage",
      arguments: { code: "const x = 1", tests: "expect(x).toBe(1)", iteration: 1 },
    });
    expect(result).toEqual({
      coverage: 87.5,
      passed: true,
      output: "Statements: 87.5%",
    });

    await runner.close();
    expect(mocks.client.close).toHaveBeenCalledOnce();
  });

  it("returns a denied result before calling an MCP tool", async () => {
    process.env.NRI_MCP_TOOL = "coverage_tool";
    mocks.checkPermission.mockReturnValue({ allowed: false, reason: "not granted" });
    const runner = new McpCoverageRunner("node");

    const result = await runner.run("code", "tests", 1);

    expect(result).toEqual({
      coverage: 0,
      passed: false,
      output: "permission denied: not granted",
    });
    expect(mocks.client.callTool).not.toHaveBeenCalled();
  });
});
