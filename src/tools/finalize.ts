import type { ExecutionResult, ParsedChangeRequest, CommitResult } from '../graph/nodes.js';
import { execSync } from 'child_process';

export function generateCommitMessage(parsed?: ParsedChangeRequest): string {
  const description = parsed?.changeDescription || 'automated simple change';
  const safe = description.replace(/"/g, '\\"');
  return `Simple change: ${safe}`;
}

export async function finalize(
  executionResult: ExecutionResult,
  parsed?: ParsedChangeRequest,
): Promise<CommitResult> {
  execSync('git add -A', { stdio: 'pipe' });

  const message = generateCommitMessage(parsed);

  const commitOutput = execSync(`git commit -m "${message}"`, { stdio: 'pipe' }).toString();
  const commitHashMatch = commitOutput.match(/\[.+\s+([a-f0-9]+)\]/);
  const commitHash = commitHashMatch ? commitHashMatch[1] : '';

  let remoteUrl = '';
  try {
    remoteUrl = execSync('git config --get remote.origin.url', { stdio: 'pipe' }).toString().trim();
  } catch (err) {
    remoteUrl = process.env.GIT_REMOTE_URL || '';
  }

  let pushed = false;
  let remoteRef = '';
  try {
    execSync('git push', { stdio: 'pipe' });
    pushed = true;
    remoteRef = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }).toString().trim();
  } catch (err) {
    pushed = false;
  }

  return {
    commitHash,
    pushed,
    remoteUrl,
    remoteRef,
  };
}
