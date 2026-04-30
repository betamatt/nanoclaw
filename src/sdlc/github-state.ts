/**
 * GitHub-as-source-of-truth query layer.
 * Replaces the local sdlc_issues DB table — all state is derived from
 * GitHub labels, issue metadata, and PR links.
 */
import { execSync } from 'child_process';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { stateFromLabels } from './transitions.js';
import type { BlockerRef, SdlcStage } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SdlcIssueView {
  repo: string;
  issue_number: number;
  current_stage: SdlcStage;
  issue_title: string;
  issue_body: string | null;
  issue_labels: string[];
  classification: string | null; // from type:* / complexity:* labels
  branch_name: string | null;
  pr_number: number | null;
  blocked_by: BlockerRef[];
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function ghEnv(): Record<string, string> {
  const env = readEnvFile(['GITHUB_TOKEN']);
  const token = env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  return {
    ...process.env,
    ...(token ? { GITHUB_TOKEN: token } : {}),
  } as Record<string, string>;
}

function gh(cmd: string): string {
  return execSync(cmd, {
    encoding: 'utf-8',
    env: ghEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/** Map GitHub label state → internal stage name. */
const LABEL_TO_STAGE: Record<string, SdlcStage> = {
  triage: 'triage',
  blocked: 'blocked',
  'plan-ready': 'awaiting_approval',
  implementing: 'implement',
  review: 'review',
  validate: 'validate',
  merging: 'merge',
};

function deriveClassification(labels: string[]): string | null {
  let type: string | null = null;
  let complexity: string | null = null;
  for (const l of labels) {
    if (l.startsWith('type:')) type = l.slice(5);
    if (l.startsWith('complexity:')) complexity = l.slice(11);
    // Legacy labels (e.g. "feature", "bug") without prefix
    if (['bug', 'feature', 'chore', 'security'].includes(l)) type = l;
    if (['small', 'med', 'large'].includes(l)) complexity = l;
  }
  if (!type && !complexity) return null;
  return JSON.stringify({ type, complexity });
}

/**
 * Fetch blockedBy + subIssues from GitHub's native issue dependency API.
 * Returns all open blockers (blockedBy issues + open sub-issues).
 */
function fetchBlockers(repo: string, issueNumber: number): BlockerRef[] {
  try {
    const [owner, name] = repo.split('/');
    const query = `{
      repository(owner: "${owner}", name: "${name}") {
        issue(number: ${issueNumber}) {
          blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
          subIssues(first: 50) { nodes { number state } }
        }
      }
    }`;
    const result = gh(`gh api graphql -f query='${query}'`);
    const data = JSON.parse(result);
    const issue = data?.data?.repository?.issue;
    if (!issue) return [];

    const refs: BlockerRef[] = [];

    // Open blockedBy issues
    const blockedBy = issue.blockedBy?.nodes as Array<{ number: number; state: string; repository: { nameWithOwner: string } }> | undefined;
    if (blockedBy) {
      for (const b of blockedBy) {
        if (b.state === 'OPEN') {
          refs.push({ repo: b.repository.nameWithOwner, issue_number: b.number });
        }
      }
    }

    // Open sub-issues
    const subIssues = issue.subIssues?.nodes as Array<{ number: number; state: string }> | undefined;
    if (subIssues) {
      for (const s of subIssues) {
        if (s.state === 'OPEN') {
          refs.push({ repo, issue_number: s.number });
        }
      }
    }

    return refs;
  } catch {
    return [];
  }
}

// ── Per-request cache ────────────────────────────────────────────────────────

const cache = new Map<string, { data: SdlcIssueView; at: number }>();
const CACHE_TTL_MS = 30_000;

function cacheKey(repo: string, num: number): string {
  return `${repo}#${num}`;
}

function getCached(repo: string, num: number): SdlcIssueView | null {
  const entry = cache.get(cacheKey(repo, num));
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.data;
  return null;
}

function putCache(view: SdlcIssueView): void {
  cache.set(cacheKey(view.repo, view.issue_number), { data: view, at: Date.now() });
}

/** Invalidate cache for a specific issue. */
export function invalidateCache(repo: string, issueNumber: number): void {
  cache.delete(cacheKey(repo, issueNumber));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Assemble a full issue view from GitHub.
 * Queries the issue API, derives stage from labels, finds linked PR.
 */
export function fetchIssueView(repo: string, issueNumber: number): SdlcIssueView {
  const cached = getCached(repo, issueNumber);
  if (cached) return cached;

  // Fetch issue data
  const raw = gh(
    `gh api repos/${repo}/issues/${issueNumber} --jq '{title: .title, body: .body, labels: [.labels[].name], state: .state, pull_request: .pull_request}'`,
  );
  const data = JSON.parse(raw) as {
    title: string;
    body: string | null;
    labels: string[];
    state: string;
    pull_request: unknown | null;
  };

  // Derive stage from labels
  const labelState = stateFromLabels(data.labels.map((name) => ({ name })));
  let stage: SdlcStage = 'triage';
  if (data.state === 'closed') {
    stage = 'done';
  } else if (labelState) {
    stage = LABEL_TO_STAGE[labelState] ?? 'triage';
  }

  // Derive classification from labels
  const classification = deriveClassification(data.labels);

  // Find linked PR
  let prNumber: number | null = null;
  let branchName: string | null = null;
  try {
    const prResult = gh(
      `gh pr list --repo ${repo} --search "closes #${issueNumber}" --json number,headRefName --jq '.[0] | "\\(.number)\\t\\(.headRefName)"'`,
    );
    if (prResult) {
      const [num, branch] = prResult.split('\t');
      prNumber = parseInt(num, 10) || null;
      branchName = branch || null;
    }
  } catch {
    // No linked PR
  }

  // Fetch blockers from GitHub's native dependency API
  const blockedBy = fetchBlockers(repo, issueNumber);

  const view: SdlcIssueView = {
    repo,
    issue_number: issueNumber,
    current_stage: stage,
    issue_title: data.title,
    issue_body: data.body,
    issue_labels: data.labels,
    classification,
    branch_name: branchName,
    pr_number: prNumber,
    blocked_by: blockedBy,
  };

  putCache(view);
  return view;
}

/**
 * Resolve a PR number to its linked issue number.
 * Parses the PR body for "Resolves #N" / "Closes #N" / "Fixes #N".
 */
export function resolveIssueForPr(repo: string, prNumber: number): number | null {
  try {
    const body = gh(`gh pr view ${prNumber} --repo ${repo} --json body --jq .body`);
    const match = body.match(/(?:Resolves|Closes|Fixes)\s+#(\d+)/i);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Find all open sdlc:blocked issues that are now fully unblocked.
 * Uses GitHub's native blockedBy + subIssues API — no body parsing.
 */
export function fetchNewlyUnblockedIssues(repos: string[]): SdlcIssueView[] {
  const results: SdlcIssueView[] = [];

  for (const repo of repos) {
    try {
      const raw = gh(
        `gh api "repos/${repo}/issues?labels=sdlc:blocked&state=open&per_page=100" --jq '[.[] | .number]'`,
      );
      const numbers = JSON.parse(raw) as number[];

      for (const num of numbers) {
        const openBlockers = fetchBlockers(repo, num);
        if (openBlockers.length === 0) {
          results.push(fetchIssueView(repo, num));
        }
      }
    } catch (err) {
      log.warn('Failed to search blocked issues', { repo, err });
    }
  }

  return results;
}


/**
 * Fetch all open issues with a specific sdlc:* label across repos.
 */
export function fetchIssuesByLabel(label: string, repos: string[]): Array<{ repo: string; number: number; title: string }> {
  const results: Array<{ repo: string; number: number; title: string }> = [];
  for (const repo of repos) {
    try {
      const raw = gh(
        `gh api "repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=open&per_page=100" --jq '[.[] | {number, title}]'`,
      );
      const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
      for (const issue of issues) {
        results.push({ repo, number: issue.number, title: issue.title });
      }
    } catch (err) {
      log.warn('Failed to fetch issues by label', { repo, label, err });
    }
  }
  return results;
}

/**
 * Check if an issue or PR has the feedback-required flag.
 */
export function hasFeedbackFlag(repo: string, number: number): boolean {
  try {
    const raw = gh(`gh api repos/${repo}/issues/${number}/labels --jq '[.[].name]'`);
    const labels: string[] = JSON.parse(raw);
    return labels.includes('sdlc:flag:feedback-required');
  } catch {
    return false;
  }
}
