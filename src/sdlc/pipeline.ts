import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { runContainerAgent } from '../container-runner.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { MAX_SDLC_RETRIES, SDLC_WEBHOOK_URL } from './config.js';
import {
  getAllSdlcIssues,
  getIssuesBlockedBy,
  getSdlcIssue,
  getSdlcIssuesByStage,
  updateSdlcStage,
  upsertSdlcIssue,
} from './db.js';
import { getPromptForStage } from './prompts.js';
import {
  createWorktree,
  getWorktreePath,
  removeWorktree,
  switchWorktreeToBranch,
} from './repo-manager.js';
import { startFunnel, stopFunnel } from './tailscale-funnel.js';
import type {
  BlockerRef,
  SdlcIssue,
  SdlcPipelineDeps,
  SdlcStage,
  SdlcStageResult,
} from './types.js';
import { startWebhookServer } from './webhook-server.js';
import { ensureWebhooks, setWebhookUrl } from './webhook-setup.js';

/** Next stage after a successful completion */
const STAGE_TRANSITIONS: Record<string, SdlcStage> = {
  triage: 'plan',
  plan: 'awaiting_approval',
  implement: 'review',
  review: 'validate',
  validate: 'awaiting_merge',
};

/** Stages that run a container agent */
const RUNNABLE_STAGES = new Set<SdlcStage>([
  'triage',
  'plan',
  'implement',
  'review',
  'validate',
]);

function issueJid(repo: string, issueNumber: number): string {
  return `sdlc:${repo}#${issueNumber}`;
}

function issueFolder(repo: string, issueNumber: number): string {
  const slug = repo.replace(/\//g, '-');
  return `sdlc-${slug}-${issueNumber}`;
}

/**
 * Parse blocker references from issue body text.
 * Matches patterns like: "blocked by #42", "depends on #7", "after #10", "requires #3"
 * Also matches cross-repo refs: "blocked by owner/repo#42"
 */
function parseBlockerRefs(body: string, defaultRepo: string): BlockerRef[] {
  const pattern =
    /(?:blocked\s+by|depends\s+on|after|requires)\s+(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+))?#(\d+)/gi;
  const refs: BlockerRef[] = [];
  const seen = new Set<string>();
  let match;

  while ((match = pattern.exec(body)) !== null) {
    const repo = match[1] || defaultRepo;
    const num = parseInt(match[2], 10);
    const key = `${repo}#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ repo, issue_number: num });
    }
  }

  return refs;
}

/** Best-effort label add/remove via gh CLI. */
function ghLabel(
  repo: string,
  issueNumber: number,
  action: 'add' | 'remove',
  label: string,
): void {
  try {
    const { readEnvFile } = require('../env.js') as typeof import('../env.js');
    const ghEnv = readEnvFile(['GITHUB_TOKEN']);
    const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return;
    const { execSync } = require('child_process') as typeof import('child_process');
    const flag = action === 'add' ? '--add-label' : '--remove-label';
    execSync(
      `gh issue edit ${issueNumber} ${flag} "${label}" --repo ${repo}`,
      { env: { ...process.env, GITHUB_TOKEN: token }, stdio: 'pipe' },
    );
  } catch {
    // best-effort
  }
}

/**
 * Fetch open sub-issues for a GitHub issue via GraphQL.
 * Returns empty array if the issue has no sub-issues or on error.
 */
function getOpenSubIssues(
  repo: string,
  issueNumber: number,
): BlockerRef[] {
  try {
    const { readEnvFile } = require('../env.js') as typeof import('../env.js');
    const { execSync } = require('child_process') as typeof import('child_process');
    const ghEnv = readEnvFile(['GITHUB_TOKEN']);
    const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return [];

    const [owner, name] = repo.split('/');
    const query = `{ repository(owner: "${owner}", name: "${name}") { issue(number: ${issueNumber}) { subIssues(first: 50) { nodes { number state } } } } }`;
    const result = execSync(`gh api graphql -f query='${query}'`, {
      encoding: 'utf-8',
      env: { ...process.env, GITHUB_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const data = JSON.parse(result);
    const subIssues = data?.data?.repository?.issue?.subIssues?.nodes as
      | Array<{ number: number; state: string }>
      | undefined;
    if (!subIssues) return [];

    return subIssues
      .filter((s) => s.state === 'OPEN')
      .map((s) => ({ repo, issue_number: s.number }));
  } catch {
    return [];
  }
}

/** Best-effort comment on an issue via gh CLI. */
function ghComment(repo: string, issueNumber: number, body: string): void {
  try {
    const { readEnvFile } = require('../env.js') as typeof import('../env.js');
    const ghEnv = readEnvFile(['GITHUB_TOKEN']);
    const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return;
    const { execSync } = require('child_process') as typeof import('child_process');
    execSync(
      `gh issue comment ${issueNumber} --repo ${repo} --body "${body.replace(/"/g, '\\"')}"`,
      { env: { ...process.env, GITHUB_TOKEN: token }, stdio: 'pipe' },
    );
  } catch {
    // best-effort
  }
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export class SdlcPipeline {
  private deps: SdlcPipelineDeps;

  constructor(deps: SdlcPipelineDeps) {
    this.deps = deps;
  }

  async handleIssueOpened(
    repo: string,
    issueNumber: number,
    title: string,
    body: string,
    labels: string[],
  ): Promise<void> {
    // Idempotent: skip if already tracked
    const existing = getSdlcIssue(repo, issueNumber);
    if (existing) {
      logger.info(
        { repo, issueNumber, stage: existing.current_stage },
        'Issue already tracked, skipping',
      );
      return;
    }

    const now = new Date().toISOString();
    const issue = upsertSdlcIssue({
      repo,
      issue_number: issueNumber,
      current_stage: 'triage',
      issue_title: title,
      issue_body: body,
      issue_labels: JSON.stringify(labels),
      classification: null,
      branch_name: null,
      pr_number: null,
      retry_count: 0,
      blocked_by: null,
      metadata: null,
      created_at: now,
      updated_at: now,
    });

    if (!issue) {
      logger.error({ repo, issueNumber }, 'Failed to create SDLC issue');
      return;
    }

    logger.info({ repo, issueNumber }, 'SDLC issue created, starting triage');
    await this.deps.sendNotification(
      `SDLC: New issue #${issueNumber} in ${repo} — starting triage`,
    );

    // Create worktree on main for investigation
    createWorktree(repo, issueNumber);

    // Register synthetic group and enqueue triage
    this.ensureGroup(issue);
    this.enqueueStage(issue);
  }

  async handlePlanApproved(repo: string, issueNumber: number): Promise<void> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) {
      logger.warn({ repo, issueNumber }, 'Plan approved for unknown issue');
      return;
    }

    if (issue.current_stage !== 'awaiting_approval') {
      logger.debug(
        { repo, issueNumber, stage: issue.current_stage },
        'Plan approval ignored — not awaiting approval',
      );
      return;
    }

    logger.info(
      { repo, issueNumber },
      'Plan approved, starting implementation',
    );
    await this.deps.sendNotification(
      `SDLC: Plan approved for #${issueNumber} in ${repo} — starting implementation`,
    );

    // Add the approval label for visibility (may already exist if triggered by label)
    ghLabel(repo, issueNumber, 'add', 'sdlc:approve-plan');

    // Check for open sub-issues — parent waits for all sub-issues to complete
    const openSubIssues = getOpenSubIssues(repo, issueNumber);
    if (openSubIssues.length > 0) {
      const blockerList = openSubIssues
        .map((b) => `#${b.issue_number}`)
        .join(', ');

      updateSdlcStage(repo, issueNumber, 'blocked', {
        blocked_by: JSON.stringify(openSubIssues),
        retry_count: 0,
      });

      ghLabel(repo, issueNumber, 'add', 'sdlc:blocked');

      logger.info(
        { repo, issueNumber, subIssues: blockerList },
        'Parent issue blocked by open sub-issues',
      );

      await this.deps.sendNotification(
        `SDLC: #${issueNumber} in ${repo} plan approved but blocked by sub-issues ${blockerList} — will resume when they close`,
      );
      return;
    }

    // Create implementation branch and switch worktree to it
    const branchName = `sdlc/${issueNumber}-${slugify(issue.issue_title)}`;
    switchWorktreeToBranch(repo, issueNumber, branchName);

    updateSdlcStage(repo, issueNumber, 'implement', {
      branch_name: branchName,
      retry_count: 0,
    });

    const updated = getSdlcIssue(repo, issueNumber)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  async handleStageResult(result: SdlcStageResult): Promise<void> {
    const issue = getSdlcIssue(result.repo, result.issueNumber);
    if (!issue) {
      logger.warn(
        { repo: result.repo, issueNumber: result.issueNumber },
        'Stage result for unknown issue',
      );
      return;
    }

    if (result.success) {
      await this.advanceStage(issue, result.metadata);
    } else {
      await this.handleFailure(issue, result.metadata);
    }
  }

  async handleRetry(repo: string, issueNumber: number): Promise<void> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) {
      logger.warn({ repo, issueNumber }, 'Retry for unknown issue');
      return;
    }

    if (issue.current_stage !== 'failed') {
      logger.debug(
        { repo, issueNumber, stage: issue.current_stage },
        'Retry ignored — not in failed state',
      );
      return;
    }

    // Recover: look at metadata to find the stage that failed
    const meta = issue.metadata ? JSON.parse(issue.metadata) : {};
    const retryStage = (meta.failed_stage as SdlcStage) || 'triage';

    logger.info({ repo, issueNumber, retryStage }, 'Retrying failed issue');
    await this.deps.sendNotification(
      `SDLC: Retrying #${issueNumber} in ${repo} from ${retryStage}`,
    );

    updateSdlcStage(repo, issueNumber, retryStage, { retry_count: 0 });

    const updated = getSdlcIssue(repo, issueNumber)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  async handleReviewResolved(
    repo: string,
    issueNumber: number,
  ): Promise<void> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) {
      logger.warn({ repo, issueNumber }, 'Review resolved for unknown issue');
      return;
    }

    if (issue.current_stage !== 'review_flagged') {
      logger.debug(
        { repo, issueNumber, stage: issue.current_stage },
        'Review resolved ignored — not awaiting review',
      );
      return;
    }

    logger.info(
      { repo, issueNumber },
      'Review items resolved, advancing to validation',
    );
    await this.deps.sendNotification(
      `SDLC: Review resolved for #${issueNumber} in ${repo} — starting validation`,
    );

    updateSdlcStage(repo, issueNumber, 'validate', { retry_count: 0 });

    const updated = getSdlcIssue(repo, issueNumber)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  async handleResume(repo: string, issueNumber: number): Promise<void> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) {
      logger.warn({ repo, issueNumber }, 'Resume for unknown issue');
      return;
    }

    // If already in a runnable stage, just re-enqueue
    if (RUNNABLE_STAGES.has(issue.current_stage)) {
      logger.info(
        { repo, issueNumber, stage: issue.current_stage },
        'Resuming — re-enqueueing current stage',
      );
      this.ensureGroup(issue);
      this.enqueueStage(issue);
      return;
    }

    // Determine the right re-entry point from GitHub state
    const resumeStage = this.determineResumeStage(issue);

    logger.info(
      { repo, issueNumber, from: issue.current_stage, to: resumeStage },
      'Resuming SDLC issue',
    );
    await this.deps.sendNotification(
      `SDLC: Resuming #${issueNumber} in ${repo} at ${resumeStage} (was ${issue.current_stage})`,
    );

    // Ensure worktree exists
    const wtPath = getWorktreePath(repo, issueNumber);
    if (!fs.existsSync(wtPath)) {
      createWorktree(repo, issueNumber);
    }

    // If resuming to implement and we have a branch, switch to it
    if (resumeStage === 'implement' && issue.branch_name) {
      switchWorktreeToBranch(repo, issueNumber, issue.branch_name);
    }

    updateSdlcStage(repo, issueNumber, resumeStage, { retry_count: 0 });

    const updated = getSdlcIssue(repo, issueNumber)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  private determineResumeStage(issue: SdlcIssue): SdlcStage {
    try {
      const { readEnvFile } = require('../env.js') as typeof import('../env.js');
      const { execSync } = require('child_process') as typeof import('child_process');
      const ghEnv = readEnvFile(['GITHUB_TOKEN']);
      const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
      if (!token) return 'triage';
      const env = { ...process.env, GITHUB_TOKEN: token };

      // If there's a PR, check its state
      if (issue.pr_number) {
        const prJson = execSync(
          `gh pr view ${issue.pr_number} --repo ${issue.repo} --json state,merged,reviewDecision`,
          { encoding: 'utf-8', env, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const pr = JSON.parse(prJson) as {
          state: string;
          merged: boolean;
          reviewDecision: string;
        };

        if (pr.merged) {
          return 'done' as SdlcStage;
        }

        // PR is open — go back to implement so the agent can read
        // comments/reviews and make any needed changes
        return 'implement';
      }

      // No PR yet — check how far we got
      if (issue.branch_name) return 'implement';
      if (issue.classification) return 'plan';
      return 'triage';
    } catch (err) {
      logger.warn({ err, issue: issue.issue_number }, 'Failed to determine resume stage, defaulting to triage');
      return 'triage';
    }
  }

  async handlePrMerged(repo: string, prNumber: number): Promise<void> {
    // Find the SDLC issue associated with this PR
    const allIssues = getAllSdlcIssues();
    const issue = allIssues.find(
      (i) => i.repo === repo && i.pr_number === prNumber,
    );
    if (!issue) return;

    logger.info(
      { repo, issueNumber: issue.issue_number, prNumber },
      'PR merged — completing SDLC issue',
    );

    updateSdlcStage(issue.repo, issue.issue_number, 'done');
    removeWorktree(issue.repo, issue.issue_number);

    await this.deps.sendNotification(
      `SDLC: #${issue.issue_number} in ${issue.repo} — PR #${prNumber} merged. Done.`,
    );
  }

  /**
   * When an issue is closed, check if any blocked issues can advance.
   */
  async handleIssueClosed(repo: string, issueNumber: number): Promise<void> {
    // If this issue is tracked by the pipeline, mark it done
    const self = getSdlcIssue(repo, issueNumber);
    if (self && self.current_stage !== 'done') {
      logger.info(
        { repo, issueNumber, stage: self.current_stage },
        'Issue closed — marking done',
      );

      updateSdlcStage(repo, issueNumber, 'done');
      removeWorktree(repo, issueNumber);

      await this.deps.sendNotification(
        `SDLC: #${issueNumber} in ${repo} closed. Done.`,
      );
    }

    // Check if any blocked issues can advance
    const blockedIssues = getIssuesBlockedBy(repo, issueNumber);
    if (blockedIssues.length === 0) return;

    for (const issue of blockedIssues) {
      const blockers: BlockerRef[] = issue.blocked_by
        ? JSON.parse(issue.blocked_by)
        : [];
      const remaining = blockers.filter(
        (b) => !(b.repo === repo && b.issue_number === issueNumber),
      );

      if (remaining.length === 0) {
        // Fully unblocked — advance to plan
        updateSdlcStage(issue.repo, issue.issue_number, 'plan', {
          blocked_by: null,
          retry_count: 0,
        });

        ghLabel(issue.repo, issue.issue_number, 'remove', 'sdlc:blocked');

        logger.info(
          { repo: issue.repo, issueNumber: issue.issue_number },
          'Issue unblocked, advancing to plan',
        );

        await this.deps.sendNotification(
          `SDLC: #${issue.issue_number} in ${issue.repo} unblocked — starting plan`,
        );

        const updated = getSdlcIssue(issue.repo, issue.issue_number)!;
        this.ensureGroup(updated);
        this.enqueueStage(updated);
      } else {
        // Still blocked by other issues — update the list
        updateSdlcStage(issue.repo, issue.issue_number, 'blocked', {
          blocked_by: JSON.stringify(remaining),
        });

        const remainingList = remaining
          .map((b) => `${b.repo}#${b.issue_number}`)
          .join(', ');
        logger.info(
          {
            repo: issue.repo,
            issueNumber: issue.issue_number,
            remaining: remainingList,
          },
          'Blocker removed but still blocked',
        );
      }
    }
  }

  /**
   * When an issue body is edited, re-check for blocker references.
   */
  async handleIssueEdited(
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<void> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) return;

    const blockers = parseBlockerRefs(body, repo);

    if (issue.current_stage === 'blocked') {
      if (blockers.length === 0) {
        // Blockers removed from body — unblock
        updateSdlcStage(repo, issueNumber, 'plan', {
          blocked_by: null,
          retry_count: 0,
        });

        ghLabel(repo, issueNumber, 'remove', 'sdlc:blocked');

        logger.info(
          { repo, issueNumber },
          'Blockers removed from issue body, advancing to plan',
        );

        await this.deps.sendNotification(
          `SDLC: #${issueNumber} in ${repo} unblocked (blockers removed) — starting plan`,
        );

        const updated = getSdlcIssue(repo, issueNumber)!;
        this.ensureGroup(updated);
        this.enqueueStage(updated);
      } else {
        // Update the blocker list
        updateSdlcStage(repo, issueNumber, 'blocked', {
          blocked_by: JSON.stringify(blockers),
        });
      }
    } else if (
      blockers.length > 0 &&
      ['plan', 'awaiting_approval'].includes(issue.current_stage)
    ) {
      // New blockers added to an issue that hasn't started implementation yet
      const blockerList = blockers
        .map((b) => `${b.repo}#${b.issue_number}`)
        .join(', ');
      updateSdlcStage(repo, issueNumber, 'blocked', {
        blocked_by: JSON.stringify(blockers),
        retry_count: 0,
      });

      logger.info(
        { repo, issueNumber, blockers: blockerList },
        'Issue moved to blocked (body edited)',
      );

      await this.deps.sendNotification(
        `SDLC: #${issueNumber} in ${repo} now blocked by ${blockerList}`,
      );
    }
  }

  /**
   * Recover in-progress issues on startup.
   */
  recoverInProgress(): void {
    for (const stage of RUNNABLE_STAGES) {
      const issues = getSdlcIssuesByStage(stage);
      for (const issue of issues) {
        logger.info(
          { repo: issue.repo, issueNumber: issue.issue_number, stage },
          'Recovering in-progress SDLC issue',
        );
        this.ensureGroup(issue);
        this.enqueueStage(issue);
      }
    }
  }

  private async advanceStage(
    issue: SdlcIssue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const nextStage = STAGE_TRANSITIONS[issue.current_stage];
    if (!nextStage) {
      logger.warn(
        { stage: issue.current_stage },
        'No transition from current stage',
      );
      return;
    }

    const updates: Parameters<typeof updateSdlcStage>[3] = { retry_count: 0 };

    // Persist stage-specific metadata
    if (metadata) {
      if (issue.current_stage === 'triage' && metadata.classification) {
        updates.classification = JSON.stringify(metadata.classification);
      }
      if (metadata.pr_number) {
        updates.pr_number = metadata.pr_number as number;

        // Comment on the issue linking to the PR
        ghComment(
          issue.repo,
          issue.issue_number,
          `Implementation PR opened: #${metadata.pr_number}`,
        );
      }
      if (metadata.branch) {
        updates.branch_name = metadata.branch as string;
      }
    }

    // After triage, check for blockers before advancing to plan
    if (issue.current_stage === 'triage' && metadata?.blockers) {
      const blockers = metadata.blockers as BlockerRef[];
      if (blockers.length > 0) {
        const blockerList = blockers
          .map((b) => `${b.repo}#${b.issue_number}`)
          .join(', ');
        updates.blocked_by = JSON.stringify(blockers);
        updateSdlcStage(issue.repo, issue.issue_number, 'blocked', updates);

        ghLabel(issue.repo, issue.issue_number, 'add', 'sdlc:blocked');

        logger.info(
          {
            repo: issue.repo,
            issueNumber: issue.issue_number,
            blockers: blockerList,
          },
          'Issue blocked',
        );

        await this.deps.sendNotification(
          `SDLC: #${issue.issue_number} in ${issue.repo} blocked by ${blockerList} — will resume when they close`,
        );
        return;
      }
    }

    // After review, if items were flagged for human, pause until resolved
    if (
      issue.current_stage === 'review' &&
      metadata?.items_flagged &&
      (metadata.items_flagged as number) > 0
    ) {
      updateSdlcStage(issue.repo, issue.issue_number, 'review_flagged', updates);

      logger.info(
        {
          repo: issue.repo,
          issueNumber: issue.issue_number,
          itemsFlagged: metadata.items_flagged,
        },
        'Review flagged items for human — pausing pipeline',
      );

      ghComment(
        issue.repo,
        issue.issue_number,
        `Code review flagged ${metadata.items_flagged} item(s) for human review on PR #${issue.pr_number}. Pipeline paused.\n\nAdd the \`sdlc:review-resolved\` label or comment \`/sdlc review resolved\` to continue to validation.`,
      );

      await this.deps.sendNotification(
        `SDLC: #${issue.issue_number} in ${issue.repo} — review flagged ${metadata.items_flagged} item(s) for human. Paused until resolved.`,
      );
      return;
    }

    updateSdlcStage(issue.repo, issue.issue_number, nextStage, updates);

    logger.info(
      {
        repo: issue.repo,
        issueNumber: issue.issue_number,
        from: issue.current_stage,
        to: nextStage,
      },
      'SDLC stage advanced',
    );

    await this.deps.sendNotification(
      `SDLC: #${issue.issue_number} in ${issue.repo} — ${issue.current_stage} -> ${nextStage}`,
    );

    if (nextStage === 'awaiting_merge') {
      // Don't enqueue — wait for PR merge webhook
      return;
    }

    if (nextStage === 'awaiting_approval') {
      // Don't enqueue — wait for human label
      return;
    }

    // Enqueue the next stage
    const updated = getSdlcIssue(issue.repo, issue.issue_number)!;
    this.enqueueStage(updated);
  }

  private async handleFailure(
    issue: SdlcIssue,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const retryCount = issue.retry_count + 1;

    if (retryCount <= MAX_SDLC_RETRIES) {
      logger.info(
        {
          repo: issue.repo,
          issueNumber: issue.issue_number,
          stage: issue.current_stage,
          retryCount,
        },
        'Retrying SDLC stage',
      );

      updateSdlcStage(issue.repo, issue.issue_number, issue.current_stage, {
        retry_count: retryCount,
      });

      const updated = getSdlcIssue(issue.repo, issue.issue_number)!;
      this.enqueueStage(updated);
      return;
    }

    // Max retries exhausted — mark as failed
    const reason =
      (metadata?.error as string) || 'Stage failed after maximum retries';

    updateSdlcStage(issue.repo, issue.issue_number, 'failed', {
      metadata: JSON.stringify({
        failed_stage: issue.current_stage,
        error: reason,
      }),
    });

    logger.error(
      {
        repo: issue.repo,
        issueNumber: issue.issue_number,
        stage: issue.current_stage,
      },
      'SDLC issue failed after max retries',
    );

    await this.deps.sendNotification(
      `SDLC: #${issue.issue_number} in ${issue.repo} FAILED at ${issue.current_stage} — comment \`/sdlc retry\` on the issue to retry`,
    );
  }

  private ensureGroup(issue: SdlcIssue): void {
    const jid = issueJid(issue.repo, issue.issue_number);
    const folder = issueFolder(issue.repo, issue.issue_number);
    const wtPath = getWorktreePath(issue.repo, issue.issue_number);

    const existing = this.deps.registeredGroups()[jid];
    if (existing) return;

    this.deps.registerGroup(jid, {
      name: `SDLC: ${issue.repo}#${issue.issue_number}`,
      folder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      containerConfig: {
        timeout: 3600000, // 60 minutes for implementation
        additionalMounts: [
          {
            hostPath: wtPath,
            containerPath: 'repo',
            readonly: false,
          },
        ],
      },
    });
  }

  private enqueueStage(issue: SdlcIssue): void {
    const stage = issue.current_stage;
    if (!RUNNABLE_STAGES.has(stage)) return;

    const jid = issueJid(issue.repo, issue.issue_number);
    const folder = issueFolder(issue.repo, issue.issue_number);

    // Close any idle container from the previous stage so the new task starts promptly
    this.deps.queue.closeStdin(jid);
    const taskId = `sdlc-${issue.repo}-${issue.issue_number}-${stage}-${Date.now()}`;

    const prompt = getPromptForStage(stage, issue);

    this.deps.queue.enqueueTask(jid, taskId, async () => {
      const group = this.deps.registeredGroups()[jid];
      if (!group) {
        logger.error({ jid }, 'SDLC group not found');
        return;
      }

      // Ensure IPC sdlc directory exists for this group
      const ipcSdlcDir = path.join(DATA_DIR, 'ipc', folder, 'sdlc');
      fs.mkdirSync(ipcSdlcDir, { recursive: true });

      const sessionId = this.deps.getSessions()[folder];

      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: folder,
          chatJid: jid,
          isMain: false,
          isScheduledTask: true,
          assistantName: 'SDLC Agent',
        },
        (proc, containerName) =>
          this.deps.onProcess(jid, proc, containerName, folder),
      );

      if (output.newSessionId) {
        this.deps.setSession(folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          {
            repo: issue.repo,
            issueNumber: issue.issue_number,
            stage,
            error: output.error,
          },
          'SDLC container error',
        );
        // IPC result may not have been written — treat container error as stage failure
        const currentIssue = getSdlcIssue(issue.repo, issue.issue_number);
        if (currentIssue && currentIssue.current_stage === stage) {
          await this.handleFailure(currentIssue, {
            error: output.error || 'Container exited with error',
          });
        }
      }
    });
  }
}

export function startSdlcSystem(deps: SdlcPipelineDeps): SdlcPipeline {
  const pipeline = new SdlcPipeline(deps);
  startWebhookServer(pipeline);

  // If no explicit webhook URL, start Tailscale Funnel to get one
  let webhookUrl = SDLC_WEBHOOK_URL;
  if (!webhookUrl) {
    const funnelUrl = startFunnel();
    if (funnelUrl) {
      webhookUrl = funnelUrl;
      setWebhookUrl(funnelUrl);
      logger.info({ webhookUrl }, 'Using Tailscale Funnel for webhook URL');
    }
  }

  // Register webhooks on configured repos
  if (webhookUrl) {
    const results = ensureWebhooks();
    for (const r of results) {
      logger.info({ repo: r.repo, status: r.status }, 'Webhook setup');
    }
  } else {
    logger.warn(
      'No webhook URL available — set SDLC_WEBHOOK_URL or install Tailscale for automatic Funnel setup',
    );
  }

  pipeline.recoverInProgress();
  logger.info('SDLC system started');
  return pipeline;
}

export function stopSdlcSystem(): void {
  stopFunnel();
}
