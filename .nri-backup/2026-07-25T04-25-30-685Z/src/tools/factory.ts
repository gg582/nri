import { McpCoverageRunner } from "./mcp.js";
import { MockTestRunner, ShellTestRunner, type TestRunner } from "./testRunner.js";

/**
 * Test-runner factory.
 * Precedence: mock mode > MCP tool-call submodule > local shell runner.
 */
export function createTestRunner(): TestRunner {
  if (process.env.NRI_TEST_MODE === "mock") return new MockTestRunner();
  if (process.env.NRI_MCP_SERVER_COMMAND) return new McpCoverageRunner();
  return new ShellTestRunner();
}
