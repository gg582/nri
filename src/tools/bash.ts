import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BashOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export async function executeBash(command: string, options: BashOptions = {}): Promise<BashResult> {
  const { cwd = process.cwd(), timeout = 30000, env } = options;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      stdout: stdout.toString().trim(),
      stderr: stderr.toString().trim(),
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout ? error.stdout.toString().trim() : '',
      stderr: error.stderr ? error.stderr.toString().trim() : '',
      exitCode: typeof error.code === 'number' ? error.code : 1,
      error: error.message || String(error),
    };
  }
}
