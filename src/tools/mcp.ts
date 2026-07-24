import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseCoverage, ShellTestRunner, type TestRunner, type TestRunResult } from "./testRunner.js";
import { checkPermission } from "./permissions.js";

/**
 * MCP-backed test/coverage runner.
 *
 * The detailed coverage-measurement loop is delegated to an external MCP
 * server over stdio (de facto standard tool-calling protocol). Configure via:
 *   NRI_MCP_SERVER_COMMAND  e.g. "npx"
 *   NRI_MCP_SERVER_ARGS     e.g. "-y @modelcontextprotocol/server-everything"
 *   NRI_MCP_TOOL            tool name override (default: first tool whose
 *                           name contains "coverage" or "test")
 *
 * If the server exposes no matching tool, falls back to ShellTestRunner so
 * the pipeline keeps working.
 */
export class McpCoverageRunner implements TestRunner {
  private client: Client | null = null;
  private toolName: string | null = null;
  private readonly fallback = new ShellTestRunner();

  constructor(
    private readonly command = process.env.NRI_MCP_SERVER_COMMAND ?? "",
    private readonly args = (process.env.NRI_MCP_SERVER_ARGS ?? "").split(" ").filter(Boolean),
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.command) throw new Error("NRI_MCP_SERVER_COMMAND is not set");
    const transport = new StdioClientTransport({ command: this.command, args: this.args });
    const client = new Client({ name: "nri", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private async resolveTool(client: Client): Promise<string | null> {
    if (this.toolName) return this.toolName;
    if (process.env.NRI_MCP_TOOL) {
      this.toolName = process.env.NRI_MCP_TOOL;
      return this.toolName;
    }
    const { tools } = await client.listTools();
    const match = tools.find((t) => /coverage|test/i.test(t.name));
    this.toolName = match?.name ?? null;
    return this.toolName;
  }

  async run(code: string, tests: string, iteration: number): Promise<TestRunResult> {
    let client: Client;
    try {
      client = await this.connect();
    } catch {
      return this.fallback.run(code, tests, iteration);
    }
    const toolName = await this.resolveTool(client);
    if (!toolName) return this.fallback.run(code, tests, iteration);

    const gate = checkPermission(`mcp:${toolName}`);
    if (!gate.allowed) {
      return { coverage: 0, passed: false, output: `permission denied: ${gate.reason}` };
    }

    const result = await client.callTool({
      name: toolName,
      arguments: { code, tests, iteration },
    });
    const text = Array.isArray(result.content)
      ? result.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
      : String(result.content ?? "");
    const coverage = parseCoverage(text) ?? 0;
    return { coverage, passed: !result.isError, output: text };
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
