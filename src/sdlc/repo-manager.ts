import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { SDLC_REPOS_BASE } from './config.js';

function repoDir(repo: string): string {
  // repo is "owner/name" — store as data/sdlc-repos/owner/name
  return path.join(SDLC_REPOS_BASE, repo);
}

function worktreeBase(repo: string): string {
  return path.join(repoDir(repo), 'worktrees');
}

export function getWorktreePath(repo: string, issueNumber: number): string {
  return path.join(worktreeBase(repo), `issue-${issueNumber}`);
}

/**
 * Ensure the repo is cloned locally. Returns path to the main clone.
 */
export function ensureRepoCloned(repo: string): string {
  const dir = repoDir(repo);

  if (fs.existsSync(path.join(dir, '.git'))) {
    // Already cloned — fetch latest
    execSync('git fetch origin', { cwd: dir, stdio: 'pipe' });
    return dir;
  }

  // Clone fresh
  const ghEnv = readEnvFile(['GITHUB_TOKEN']);
  const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
  const cloneUrl = token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  logger.info({ repo, dir }, 'Cloning repo for SDLC');
  execSync(`git clone ${cloneUrl} ${dir}`, { stdio: 'pipe' });

  return dir;
}

/**
 * Create a git worktree for a specific issue.
 * For triage/plan stages, checks out the default branch.
 * For implement, creates and checks out a new branch.
 */
export function createWorktree(
  repo: string,
  issueNumber: number,
  branch?: string,
): string {
  const mainDir = ensureRepoCloned(repo);
  const wtPath = getWorktreePath(repo, issueNumber);

  // If worktree already exists, just return it
  if (fs.existsSync(wtPath)) {
    return wtPath;
  }

  fs.mkdirSync(worktreeBase(repo), { recursive: true });

  if (branch) {
    // Create new branch and worktree for implementation
    execSync(`git worktree add ${wtPath} -b ${branch} origin/main`, {
      cwd: mainDir,
      stdio: 'pipe',
    });
  } else {
    // Worktree on detached HEAD at origin/main for investigation
    execSync(`git worktree add --detach ${wtPath} origin/main`, {
      cwd: mainDir,
      stdio: 'pipe',
    });
  }

  installGitGuardrails(wtPath, repo);

  logger.info({ repo, issueNumber, wtPath, branch }, 'Created worktree');
  return wtPath;
}

/**
 * Set git identity from the repo's existing config and install a
 * commit-msg hook that strips Co-Authored-By lines.
 */
function installGitGuardrails(wtPath: string, repo: string): void {
  // Inherit identity from the repo's most recent commit
  try {
    const name = execSync('git log -1 --format=%an', {
      cwd: wtPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const email = execSync('git log -1 --format=%ae', {
      cwd: wtPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (name) {
      execSync(`git config user.name "${name}"`, {
        cwd: wtPath,
        stdio: 'pipe',
      });
    }
    if (email) {
      execSync(`git config user.email "${email}"`, {
        cwd: wtPath,
        stdio: 'pipe',
      });
    }
    logger.debug({ repo, name, email }, 'Git identity set from repo history');
  } catch {
    // Fallback — use repo name as identity
    const [owner] = repo.split('/');
    execSync(`git config user.name "${owner}"`, { cwd: wtPath, stdio: 'pipe' });
    execSync(`git config user.email "${owner}@users.noreply.github.com"`, {
      cwd: wtPath,
      stdio: 'pipe',
    });
  }

  // Install commit-msg hook that strips Co-Authored-By and Signed-off-by from Claude
  const hooksDir = path.join(wtPath, '.git', 'hooks');
  // Worktree .git is a file pointing to the real gitdir — resolve it
  const gitPath = path.join(wtPath, '.git');
  let resolvedHooksDir = hooksDir;
  try {
    const gitContent = fs.readFileSync(gitPath, 'utf-8').trim();
    if (gitContent.startsWith('gitdir:')) {
      const gitdir = gitContent.replace('gitdir:', '').trim();
      const absGitdir = path.isAbsolute(gitdir)
        ? gitdir
        : path.resolve(wtPath, gitdir);
      resolvedHooksDir = path.join(absGitdir, 'hooks');
    }
  } catch {
    // .git is a directory, not a file — use hooksDir as-is
  }

  fs.mkdirSync(resolvedHooksDir, { recursive: true });
  const hookPath = path.join(resolvedHooksDir, 'commit-msg');
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh
# SDLC guardrail: strip Co-Authored-By and Claude identity from commit messages
sed -i.bak '/^Co-Authored-By:.*[Cc]laude/d; /^Co-authored-by:.*[Cc]laude/d; /^Co-Authored-By:.*anthropic/d; /^Co-authored-by:.*anthropic/d; /^Signed-off-by:.*[Cc]laude/d' "$1"
rm -f "$1.bak"
`,
  );
  fs.chmodSync(hookPath, 0o755);
}

/**
 * Switch an existing worktree to a new branch for implementation.
 */
export function switchWorktreeToBranch(
  repo: string,
  issueNumber: number,
  branch: string,
): void {
  const mainDir = ensureRepoCloned(repo);
  const wtPath = getWorktreePath(repo, issueNumber);

  // Create branch from origin/main
  execSync(`git branch ${branch} origin/main`, {
    cwd: mainDir,
    stdio: 'pipe',
  });

  // Switch the worktree to the new branch
  execSync(`git checkout ${branch}`, {
    cwd: wtPath,
    stdio: 'pipe',
  });

  logger.info({ repo, issueNumber, branch }, 'Switched worktree to branch');
}

/**
 * Remove a worktree after an issue is done or failed.
 */
export function removeWorktree(repo: string, issueNumber: number): void {
  const mainDir = repoDir(repo);
  const wtPath = getWorktreePath(repo, issueNumber);

  if (!fs.existsSync(wtPath)) return;

  try {
    execSync(`git worktree remove --force ${wtPath}`, {
      cwd: mainDir,
      stdio: 'pipe',
    });
    logger.info({ repo, issueNumber }, 'Removed worktree');
  } catch (err) {
    logger.warn({ repo, issueNumber, err }, 'Failed to remove worktree');
    // Fallback: remove directory manually
    fs.rmSync(wtPath, { recursive: true, force: true });
    try {
      execSync('git worktree prune', { cwd: mainDir, stdio: 'pipe' });
    } catch {
      // ignore
    }
  }
}
