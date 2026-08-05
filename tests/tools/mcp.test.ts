import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SHELL_EXECUTION_TOOL,
  AUTOMATED_ML_TOOL,
  MCP_TOOLS,
  handleShellExecution,
  handleMlTrainAndEvaluate,
  McpCoverageRunner,
} from '../../src/tools/mcp.js';
import * as permissions from '../../src/tools/permissions.js';
import * as bash from '../../src/tools/bash.js';

vi.mock('../../src/tools/permissions.js');
vi.mock('../../src/tools/bash.js');
vi.mock('../../src/tools/testRunner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/testRunner.js')>();
  return {
    ...actual,
    ShellTestRunner: vi.fn().mockImplementation(() => ({
      run: vi.fn().mockResolvedValue({ coverage: 85, passed: true, output: 'ok' }),
    })),
  };
});

describe('MCP Tools & Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Definitions', () => {
    it('should export valid tool definitions', () => {
      expect(SHELL_EXECUTION_TOOL.name).toBe('execute_shell_command');
      expect(AUTOMATED_ML_TOOL.name).toBe('automated_ml_training_and_evaluation');
      expect(MCP_TOOLS).toHaveLength(2);
      expect(MCP_TOOLS).toContain(SHELL_EXECUTION_TOOL);
      expect(MCP_TOOLS).toContain(AUTOMATED_ML_TOOL);
    });
  });

  describe('handleShellExecution', () => {
    it('should return error when permission is denied', async () => {
      vi.mocked(permissions.checkPermission).mockReturnValue({ allowed: false, reason: 'Unauthorized' });

      const res = await handleShellExecution({ command: 'echo hi' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Permission denied: Unauthorized');
    });

    it('should execute command and return output when permission is granted', async () => {
      vi.mocked(permissions.checkPermission).mockReturnValue({ allowed: true });
      vi.mocked(bash.executeBash).mockResolvedValue({
        stdout: 'hello',
        stderr: '',
        exitCode: 0,
      });

      const res = await handleShellExecution({ command: 'echo hello' });
      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.stdout).toBe('hello');
      expect(parsed.exitCode).toBe(0);
    });

    it('should report isError true if command fails with non-zero exit code', async () => {
      vi.mocked(permissions.checkPermission).mockReturnValue({ allowed: true });
      vi.mocked(bash.executeBash).mockResolvedValue({
        stdout: '',
        stderr: 'failed',
        exitCode: 1,
      });

      const res = await handleShellExecution({ command: 'invalid' });
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.stderr).toBe('failed');
      expect(parsed.exitCode).toBe(1);
    });
  });

  describe('handleMlTrainAndEvaluate', () => {
    it('should return error when permission is denied', async () => {
      vi.mocked(permissions.checkPermission).mockReturnValue({ allowed: false, reason: 'Forbidden' });

      const res = await handleMlTrainAndEvaluate({});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Permission denied: Forbidden');
    });

    it('should handle classification task with default parameters', async () => {
      vi.mocked(permissions.checkPermission).mockReturnValue({ allowed: true });

      const res = await handleMlTrainAndEvaluate({});
      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.status).toBe('success');
      expect(parsed.taskType).toBe('auto');
      expect(parsed.metrics.accuracy).toBeDefined();
    });

    it('should handle regression task with custom parameters', async () => {
      vi.mocked(permissions.checkPermission).mockReturnValue({ allowed: true });

      const res = await handleMlTrainAndEvaluate({
        taskType: 'regression',
        modelType: 'linear',
        datasetPath: 'data.csv',
        testSize: 0.3,
      });
      expect(res.isError).toBe(false);
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.taskType).toBe('regression');
      expect(parsed.metrics.mse).toBeDefined();
      expect(parsed.split.testRatio).toBe(0.3);
    });
  });

  describe('McpCoverageRunner', () => {
    it('should fallback to ShellTestRunner when process command is not set or connect fails', async () => {
      const runner = new McpCoverageRunner('', []);
      const result = await runner.run('const a = 1;', 'test()', 1);
      expect(result.coverage).toBe(85);
      expect(result.passed).toBe(true);
    });

    it('should close properly without error when client is null', async () => {
      const runner = new McpCoverageRunner();
      await expect(runner.close()).resolves.not.toThrow();
    });
  });
});
