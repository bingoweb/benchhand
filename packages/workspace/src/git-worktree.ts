import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT = 1024 * 1024;

export class GitWorktreeError extends Error {
  readonly code: string;
  readonly stderr: string;

  constructor(code: string, message: string, stderr = '') {
    super(message);
    this.name = 'GitWorktreeError';
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitWorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null;
  lockedReason: string | null;
  prunableReason: string | null;
}

export async function resolveGitCommit(repoRoot: string, baseRef: string): Promise<string> {
  if (baseRef.length === 0) {
    throw new GitWorktreeError('WORKTREE_BASE_REF_INVALID', 'baseRef must not be empty');
  }

  const stdout = await runGit(
    repoRoot,
    ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
    'WORKTREE_BASE_REF_INVALID',
  );
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new GitWorktreeError(
      'WORKTREE_BASE_REF_INVALID',
      `Git resolved an invalid commit id for baseRef ${JSON.stringify(baseRef)}`,
    );
  }
  return commit.toLowerCase();
}

export async function createLockedWorktree(options: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  ownershipKey: string;
}): Promise<void> {
  await runGit(
    options.repoRoot,
    [
      'worktree',
      'add',
      '--lock',
      '--reason',
      `udmcp:${options.ownershipKey}`,
      '-b',
      options.branch,
      options.worktreePath,
      options.baseCommit,
    ],
    'WORKTREE_CREATE_FAILED',
  );
}

export async function listGitWorktrees(repoRoot: string): Promise<GitWorktreeInfo[]> {
  const stdout = await runGit(
    repoRoot,
    ['worktree', 'list', '--porcelain', '-z'],
    'WORKTREE_LIST_FAILED',
  );
  return parseWorktreePorcelain(stdout);
}

export async function readLocalBranchCommit(
  repoRoot: string,
  branch: string,
): Promise<string | null> {
  try {
    const result = await execFileAsync(
      'git',
      [
        '-C',
        repoRoot,
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `refs/heads/${branch}^{commit}`,
      ],
      {
        encoding: 'utf8',
        maxBuffer: GIT_OUTPUT_LIMIT,
        windowsHide: true,
      },
    );
    const commit = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new GitWorktreeError(
        'WORKTREE_BRANCH_CHECK_FAILED',
        `Git resolved an invalid commit id for branch ${JSON.stringify(branch)}`,
      );
    }
    return commit.toLowerCase();
  } catch (error) {
    if (error instanceof GitWorktreeError) throw error;
    if (extractExitCode(error) === 1) return null;
    const stderr = extractStderr(error);
    throw new GitWorktreeError(
      'WORKTREE_BRANCH_CHECK_FAILED',
      stderr.length > 0 ? stderr.trim() : `failed to inspect branch ${JSON.stringify(branch)}`,
      stderr,
    );
  }
}

function parseWorktreePorcelain(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = [];
  let current: GitWorktreeInfo | null = null;

  for (const token of output.split('\0')) {
    if (token.length === 0) {
      if (current !== null) {
        worktrees.push(current);
        current = null;
      }
      continue;
    }

    if (token.startsWith('worktree ')) {
      if (current !== null) worktrees.push(current);
      current = {
        path: token.slice('worktree '.length),
        head: null,
        branch: null,
        lockedReason: null,
        prunableReason: null,
      };
      continue;
    }
    if (current === null) continue;
    if (token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length);
    } else if (token.startsWith('branch ')) {
      current.branch = token.slice('branch '.length);
    } else if (token === 'locked') {
      current.lockedReason = '';
    } else if (token.startsWith('locked ')) {
      current.lockedReason = token.slice('locked '.length);
    } else if (token === 'prunable') {
      current.prunableReason = '';
    } else if (token.startsWith('prunable ')) {
      current.prunableReason = token.slice('prunable '.length);
    }
  }

  if (current !== null) worktrees.push(current);
  return worktrees;
}

async function runGit(cwd: string, args: readonly string[], errorCode: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const stderr = extractStderr(error);
    throw new GitWorktreeError(
      errorCode,
      stderr.length > 0 ? stderr.trim() : `git ${args[0] ?? 'command'} failed`,
      stderr,
    );
  }
}

function extractStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  const stderr = error.stderr;
  if (typeof stderr === 'string') return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  return '';
}

function extractExitCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'number' ? error.code : undefined;
}
