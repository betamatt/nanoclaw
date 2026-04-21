import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { runContainerAgent } from '../container-runner.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import {
  MAX_SDLC_RETRIES,
  SDLC_MAX_HEAVY_CONTAINERS,
  SDLC_WEBHOOK_URL,
} from './config.js';
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
  rebaseWorktree,
  removeWorktree,
  switchWorktreeToBranch,
} from './repo-manager.js';
import { addFlag } from './labels.js';
import { getPluginsCacheDir, syncPluginsForRepo } from './plugin-cache.js';
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
  validate: 'merge',
};

/** Stages that run a container agent */
const RUNNABLE_STAGES = new Set<SdlcStage>([
  'triage',
  'plan',
  'implement',
  'review',
  'validate',
  'merge',
]);

/** Heavy stages that are capped by SDLC_MAX_HEAVY_CONTAINERS */
const HEAVY_STAGES = new Set<SdlcStage>([
  'implement',
  'review',
  'validate',
  'merge',
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
    const { execSync } =
      require('child_process') as typeof import('child_process');
    const flag = action === 'add' ? '--add-label' : '--remove-label';
    execSync(`gh issue edit ${issueNumber} ${flag} "${label}" --repo ${repo}`, {
      env: { ...process.env, GITHUB_TOKEN: token },
      stdio: 'pipe',
    });
  } catch {
    // best-effort
  }
}

/**
 * Fetch open sub-issues for a GitHub issue via GraphQL.
 * Returns empty array if the issue has no sub-issues or on error.
 */
function getOpenSubIssues(repo: string, issueNumber: number): BlockerRef[] {
  try {
    const { readEnvFile } = require('../env.js') as typeof import('../env.js');
    const { execSync } =
      require('child_process') as typeof import('child_process');
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
    const { execSync } =
      require('child_process') as typeof import('child_process');
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

/**
 * Replace bare issue/PR references (#N) with GitHub links in notification text.
 * Finds the repo from "in owner/repo" context, then linkifies all #N in the message.
 */
function linkifyRefs(text: string): string {
  // Extract repo from the message (pattern: "in owner/repo")
  const repoMatch = text.match(/\bin\s+([\w.-]+\/[\w.-]+)/);
  if (!repoMatch) return text;
  const repo = repoMatch[1];

  // Replace bare #N that aren't already inside markdown links [#N](...)
  // Use a callback to avoid re-matching within replacement strings
  const parts: string[] = [];
  let lastIdx = 0;
  const re = /(?<!\[)#(\d+)(?!\])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push(text.slice(lastIdx, m.index));
    parts.push(`[#${m[1]}](https://github.com/${repo}/issues/${m[1]})`);
    lastIdx = re.lastIndex;
  }
  parts.push(text.slice(lastIdx));
  return parts.join('');
}

export class SdlcPipeline {
  private deps: SdlcPipelineDeps;
  private heavyActiveCount = 0;
  private deferredHeavyQueue: SdlcIssue[] = [];
  private heavyDrainTimer: ReturnType<typeof setInterval> | null = null;
  private repoPlugins = new Map<string, string[]>(); // repo -> container plugin paths
  private mergeActive = new Set<string>(); // repos with an active merge
  private deferredMergeQueue: SdlcIssue[] = [];

  constructor(deps: SdlcPipelineDeps) {
    this.deps = deps;
  }

  /**
   * Sync plugin cache for a repo and return container-relative plugin paths.
   */
  private syncPlugins(repo: string): string[] {
    if (this.repoPlugins.has(repo)) return this.repoPlugins.get(repo)!;

    try {
      const hostPaths = syncPluginsForRepo(repo);
      // Map host paths to container paths under /workspace/extra/plugins/
      // (mount security prepends /workspace/extra/ to the containerPath)
      const containerPaths = hostPaths.map((p) => {
        const name = path.basename(p);
        return `/workspace/extra/plugins/${name}`;
      });
      this.repoPlugins.set(repo, containerPaths);
      if (containerPaths.length > 0) {
        logger.info(
          { repo, plugins: containerPaths },
          'Plugins synced for repo',
        );
      }
      return containerPaths;
    } catch (err) {
      logger.warn({ repo, err }, 'Failed to sync plugins');
      return [];
    }
  }

  private async notify(text: string): Promise<void> {
    await this.deps.sendNotification(linkifyRefs(text));
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
    await this.notify(
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
    await this.notify(
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

      await this.notify(
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

  async handleFeedback(
    repo: string,
    issueNumber: number,
    feedbackText?: string,
  ): Promise<boolean> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) return false;

    const stage = issue.current_stage;

    // Feedback is accepted on human-gate stages and any stage with feedback-required flag
    const humanGateStages = new Set([
      'awaiting_approval',
      'awaiting_merge',
      'merge',
    ]);
    const isHumanGate = humanGateStages.has(stage);
    // For non-gate stages, feedback only matters if the issue is paused (feedback-required)
    // During migration, we accept feedback on any non-terminal stage
    const terminalStages = new Set(['done']);
    if (!isHumanGate && terminalStages.has(stage)) {
      logger.debug(
        { repo, issueNumber, stage },
        'Feedback ignored — terminal stage',
      );
      return false;
    }

    // Determine if the comment is actionable — skip comments that are
    // clearly directed at other people or are conversational noise
    if (feedbackText) {
      const text = feedbackText.trim().toLowerCase();
      // Skip @mentions to other users (not the bot)
      if (/^@\w/.test(text) && !text.startsWith('@sdlc')) {
        logger.debug(
          { repo, issueNumber },
          'Feedback ignored — directed at another user',
        );
        return false;
      }
      // Skip very short non-actionable responses
      if (
        [
          'thanks',
          'thank you',
          'ty',
          'ok',
          'k',
          'cool',
          'nice',
          '👍',
          '🎉',
          '✅',
        ].includes(text)
      ) {
        logger.debug(
          { repo, issueNumber },
          'Feedback ignored — non-actionable response',
        );
        return false;
      }
    }

    const meta = JSON.parse(issue.metadata || '{}');

    // Store the feedback so the prompt can reference it directly
    if (feedbackText) {
      meta.pending_feedback = feedbackText;
    }

    let targetStage: SdlcStage;

    if (stage === 'awaiting_approval') {
      // Re-run plan with feedback
      targetStage = 'plan';
    } else if (stage === 'awaiting_merge' || stage === 'merge') {
      // Send to review to apply requested changes
      targetStage = 'review';
    } else if (RUNNABLE_STAGES.has(stage)) {
      // Re-run the current stage (covers triage, plan, review, validate, merge with feedback flag)
      targetStage = stage;
    } else {
      return false;
    }

    logger.info(
      { repo, issueNumber, from: stage, to: targetStage },
      'Feedback received — re-running stage',
    );
    await this.notify(
      `SDLC: Feedback on #${issueNumber} in ${repo} — re-running ${targetStage}`,
    );

    // Remove feedback-required flag if present
    const targetNumber =
      issue.pr_number && ['review', 'validate', 'merge'].includes(stage)
        ? issue.pr_number
        : issueNumber;
    try {
      const { removeFlag } = await import('./labels.js');
      removeFlag(repo, targetNumber, 'feedback-required');
    } catch {
      /* best effort */
    }

    updateSdlcStage(repo, issueNumber, targetStage, {
      retry_count: 0,
      metadata: JSON.stringify(meta),
    });

    const updated = getSdlcIssue(repo, issueNumber)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
    return true;
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

    // Re-run the current stage with reset retry count
    // Works for both old `failed` state (legacy) and new feedback-required pattern
    let retryStage: SdlcStage = issue.current_stage;
    if (issue.current_stage === 'failed') {
      // Legacy: recover the original stage from metadata
      const meta = issue.metadata ? JSON.parse(issue.metadata) : {};
      retryStage = (meta.failed_stage as SdlcStage) || 'triage';
    }

    logger.info({ repo, issueNumber, retryStage }, 'Retrying issue');
    await this.notify(
      `SDLC: Retrying #${issueNumber} in ${repo} from ${retryStage}`,
    );

    // Remove feedback-required flag
    const targetNumber =
      issue.pr_number && ['review', 'validate', 'merge'].includes(retryStage)
        ? issue.pr_number
        : issueNumber;
    try {
      const { removeFlag } = await import('./labels.js');
      removeFlag(repo, targetNumber, 'feedback-required');
    } catch {
      /* best effort */
    }

    updateSdlcStage(repo, issueNumber, retryStage, { retry_count: 0 });

    const updated = getSdlcIssue(repo, issueNumber)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  /**
   * Handle human applying sdlc:merge label — enqueue the merge stage.
   */
  async handleMergeRequested(repo: string, prNumber: number): Promise<void> {
    // Look up the SDLC issue by PR number
    const { getSdlcIssueByPr } = await import('./db.js');
    const issue = getSdlcIssueByPr(repo, prNumber);
    if (!issue) {
      logger.debug({ repo, prNumber }, 'Merge requested for unknown PR');
      return;
    }

    if (
      issue.current_stage !== 'awaiting_merge' &&
      issue.current_stage !== 'merge'
    ) {
      logger.debug(
        { repo, issueNumber: issue.issue_number, stage: issue.current_stage },
        'Merge requested but not in awaiting_merge/merge stage',
      );
      return;
    }

    logger.info(
      { repo, issueNumber: issue.issue_number, prNumber },
      'Merge requested by human',
    );
    await this.notify(
      `SDLC: Merge requested for #${issue.issue_number} in ${repo} — queuing PR #${prNumber}`,
    );

    updateSdlcStage(repo, issue.issue_number, 'merge', { retry_count: 0 });

    const updated = getSdlcIssue(repo, issue.issue_number)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  /**
   * Handle removal of sdlc:feedback-required flag — re-run the current stage.
   */
  async handleFeedbackFlagRemoved(repo: string, number: number): Promise<void> {
    // Could be an issue number or PR number
    let issue = getSdlcIssue(repo, number);
    if (!issue) {
      const { getSdlcIssueByPr } = await import('./db.js');
      const byPr = getSdlcIssueByPr(repo, number);
      if (byPr) issue = byPr;
    }
    if (!issue) return;

    const stage = issue.current_stage;
    if (!RUNNABLE_STAGES.has(stage)) {
      logger.debug(
        { repo, issueNumber: issue.issue_number, stage },
        'Flag removed but stage not runnable',
      );
      return;
    }

    logger.info(
      { repo, issueNumber: issue.issue_number, stage },
      'Feedback flag removed — re-running stage',
    );
    await this.notify(
      `SDLC: Feedback resolved for #${issue.issue_number} in ${repo} — re-running ${stage}`,
    );

    updateSdlcStage(repo, issue.issue_number, stage, { retry_count: 0 });
    const updated = getSdlcIssue(repo, issue.issue_number)!;
    this.ensureGroup(updated);
    this.enqueueStage(updated);
  }

  async handleReviewResolved(repo: string, issueNumber: number): Promise<void> {
    const issue = getSdlcIssue(repo, issueNumber);
    if (!issue) {
      logger.warn({ repo, issueNumber }, 'Review resolved for unknown issue');
      return;
    }

    // Accept from both old review_flagged state and new review + feedback-required
    if (
      issue.current_stage !== 'review_flagged' &&
      issue.current_stage !== 'review'
    ) {
      logger.debug(
        { repo, issueNumber, stage: issue.current_stage },
        'Review resolved ignored — not in review',
      );
      return;
    }

    logger.info(
      { repo, issueNumber },
      'Review items resolved, advancing to validation',
    );
    await this.notify(
      `SDLC: Review resolved for #${issueNumber} in ${repo} — starting validation`,
    );

    // Remove feedback-required flag
    if (issue.pr_number) {
      try {
        const { removeFlag } = await import('./labels.js');
        removeFlag(repo, issue.pr_number, 'feedback-required');
      } catch {
        /* best effort */
      }
    }

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
    await this.notify(
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
      const { readEnvFile } =
        require('../env.js') as typeof import('../env.js');
      const { execSync } =
        require('child_process') as typeof import('child_process');
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
      logger.warn(
        { err, issue: issue.issue_number },
        'Failed to determine resume stage, defaulting to triage',
      );
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

    await this.notify(
      `SDLC: #${issue.issue_number} in ${issue.repo} — PR #${prNumber} merged. Done.`,
    );

    // Check all in-flight branches for conflicts with the new main
    await this.rebaseInFlightBranches(repo);
  }

  /**
   * After a PR merges, attempt to rebase all in-flight branches onto the new main.
   * If rebase fails (conflicts), pause the issue and post a comment on the PR.
   */
  private async rebaseInFlightBranches(repo: string): Promise<void> {
    const REBASE_STAGES: Set<SdlcStage> = new Set([
      'review',
      'review_flagged',
      'validate',
      'awaiting_merge',
      'merge',
    ]);

    const allIssues = getAllSdlcIssues();
    const candidates = allIssues.filter(
      (i) =>
        i.repo === repo && i.branch_name && REBASE_STAGES.has(i.current_stage),
    );

    if (candidates.length === 0) return;

    logger.info(
      { repo, count: candidates.length },
      'Post-merge: rebasing in-flight branches',
    );

    for (const issue of candidates) {
      const success = rebaseWorktree(repo, issue.issue_number);

      if (success) {
        // Push the rebased branch
        try {
          const wtPath = getWorktreePath(repo, issue.issue_number);
          execSync(`git push --force-with-lease origin ${issue.branch_name}`, {
            cwd: wtPath,
            stdio: 'pipe',
          });
          logger.info(
            {
              repo,
              issueNumber: issue.issue_number,
              branch: issue.branch_name,
            },
            'Rebased and pushed branch',
          );
        } catch (err) {
          logger.warn(
            { repo, issueNumber: issue.issue_number, err },
            'Rebase succeeded but push failed',
          );
        }
      } else {
        // Conflict — send to review stage so the agent can resolve it
        const meta = JSON.parse(issue.metadata || '{}');
        meta.pending_feedback = `Merge conflict: automatic rebase onto main failed. You must resolve the conflicts manually:\n1. Run \`git fetch origin main && git rebase origin/main\` in /workspace/extra/repo\n2. Resolve all conflicts\n3. Run \`git rebase --continue\`\n4. Run tests to verify nothing broke\n5. Push with \`git push --force-with-lease origin ${issue.branch_name}\`\n\nIf you cannot resolve a conflict because it requires human judgment, post a PR comment explaining the conflict and what decision is needed, then write a failure result.`;

        updateSdlcStage(repo, issue.issue_number, 'review', {
          retry_count: 0,
          metadata: JSON.stringify(meta),
        });

        const updated = getSdlcIssue(repo, issue.issue_number)!;
        this.ensureGroup(updated);
        this.enqueueStage(updated);

        await this.notify(
          `SDLC: #${issue.issue_number} in ${repo} — merge conflict detected, sending to review for resolution`,
        );

        logger.warn(
          { repo, issueNumber: issue.issue_number, stage: issue.current_stage },
          'Post-merge rebase conflict — sending to review',
        );
      }
    }
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

      await this.notify(`SDLC: #${issueNumber} in ${repo} closed. Done.`);
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

        await this.notify(
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

        await this.notify(
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

      await this.notify(
        `SDLC: #${issueNumber} in ${repo} now blocked by ${blockerList}`,
      );
    }
  }

  /**
   * Recover in-progress issues on startup.
   */
  recoverInProgress(): void {
    // Migrate legacy awaiting_merge issues to the active merge stage
    const awaitingMerge = getSdlcIssuesByStage('awaiting_merge' as SdlcStage);
    for (const issue of awaitingMerge) {
      logger.info(
        { repo: issue.repo, issueNumber: issue.issue_number },
        'Migrating awaiting_merge → merge',
      );
      updateSdlcStage(issue.repo, issue.issue_number, 'merge', {
        retry_count: 0,
      });
    }

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

        await this.notify(
          `SDLC: #${issue.issue_number} in ${issue.repo} blocked by ${blockerList} — will resume when they close`,
        );
        return;
      }
    }

    // After triage (and no explicit blockers), check sub-issues
    if (issue.current_stage === 'triage') {
      const openSubIssues = getOpenSubIssues(issue.repo, issue.issue_number);
      if (openSubIssues.length > 0) {
        const blockerList = openSubIssues
          .map((b) => `#${b.issue_number}`)
          .join(', ');
        updates.blocked_by = JSON.stringify(openSubIssues);
        updateSdlcStage(issue.repo, issue.issue_number, 'blocked', updates);

        ghLabel(issue.repo, issue.issue_number, 'add', 'sdlc:blocked');

        logger.info(
          {
            repo: issue.repo,
            issueNumber: issue.issue_number,
            subIssues: blockerList,
          },
          'Parent issue blocked by open sub-issues',
        );

        await this.notify(
          `SDLC: #${issue.issue_number} in ${issue.repo} blocked by sub-issues ${blockerList} — will resume when they close`,
        );
        return;
      }
    }

    // After review, if items were flagged for human, stay in review with feedback flag
    if (
      issue.current_stage === 'review' &&
      metadata?.items_flagged &&
      (metadata.items_flagged as number) > 0
    ) {
      updateSdlcStage(issue.repo, issue.issue_number, 'review', updates);

      const targetNumber = this.getTargetNumber(issue);
      addFlag(issue.repo, targetNumber, 'feedback-required');

      logger.info(
        {
          repo: issue.repo,
          issueNumber: issue.issue_number,
          itemsFlagged: metadata.items_flagged,
        },
        'Review flagged items for human — adding feedback-required',
      );

      ghComment(
        issue.repo,
        issue.issue_number,
        `Code review flagged ${metadata.items_flagged} item(s) for human review on PR #${issue.pr_number}. Pipeline paused.\n\nRemove \`sdlc:feedback-required\` label or comment to continue.`,
      );

      await this.notify(
        `SDLC: #${issue.issue_number} in ${issue.repo} — review flagged ${metadata.items_flagged} item(s) for human. sdlc:feedback-required added.`,
      );
      return;
    }

    // After merge success: mark done, cleanup worktree, rebase in-flight branches
    if (issue.current_stage === 'merge') {
      updateSdlcStage(issue.repo, issue.issue_number, 'done', updates);
      removeWorktree(issue.repo, issue.issue_number);
      ghLabel(issue.repo, issue.issue_number, 'remove', 'sdlc:merge-ready');

      logger.info(
        {
          repo: issue.repo,
          issueNumber: issue.issue_number,
          prNumber: issue.pr_number,
        },
        'Merge complete — issue done',
      );

      await this.notify(
        `SDLC: #${issue.issue_number} in ${issue.repo} — PR #${issue.pr_number} merged. Done.`,
      );

      // Rebase other in-flight branches onto the new main
      await this.rebaseInFlightBranches(issue.repo);
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

    await this.notify(
      `SDLC: #${issue.issue_number} in ${issue.repo} — ${issue.current_stage} -> ${nextStage}`,
    );

    // awaiting_merge is now legacy — merge stage is active
    if (nextStage === 'awaiting_merge') {
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
    // Merge failures: stay in merge with feedback-required flag (preserves queue position)
    if (issue.current_stage === 'merge') {
      const reason = (metadata?.error as string) || 'Merge failed';
      updateSdlcStage(issue.repo, issue.issue_number, 'merge', {
        retry_count: 0,
        metadata: JSON.stringify({
          ...JSON.parse(issue.metadata || '{}'),
          merge_failure: reason,
        }),
      });

      const targetNumber = this.getTargetNumber(issue);
      addFlag(issue.repo, targetNumber, 'feedback-required');

      logger.warn(
        { repo: issue.repo, issueNumber: issue.issue_number, reason },
        'Merge failed — feedback-required added',
      );
      await this.notify(
        `SDLC: #${issue.issue_number} in ${issue.repo} — merge failed: ${reason}. sdlc:feedback-required added.`,
      );
      return;
    }

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

    // Max retries exhausted — stay in current stage, add feedback-required flag
    const reason =
      (metadata?.error as string) || 'Stage failed after maximum retries';

    // Store error in metadata but keep the current stage
    updateSdlcStage(issue.repo, issue.issue_number, issue.current_stage, {
      metadata: JSON.stringify({
        ...JSON.parse(issue.metadata || '{}'),
        last_error: reason,
      }),
    });

    // Add feedback-required flag — blocks advance until human clears it
    const targetNumber = this.getTargetNumber(issue);
    addFlag(issue.repo, targetNumber, 'feedback-required');

    logger.error(
      {
        repo: issue.repo,
        issueNumber: issue.issue_number,
        stage: issue.current_stage,
      },
      'SDLC issue needs feedback after max retries',
    );

    await this.notify(
      `SDLC: #${issue.issue_number} in ${issue.repo} needs help at ${issue.current_stage} — sdlc:feedback-required added`,
    );
  }

  /** Get the GitHub number to apply labels to (PR number for PR stages, issue number otherwise) */
  private getTargetNumber(issue: SdlcIssue): number {
    const prStages = new Set([
      'review',
      'review_flagged',
      'validate',
      'awaiting_merge',
      'merge',
    ]);
    return prStages.has(issue.current_stage) && issue.pr_number
      ? issue.pr_number
      : issue.issue_number;
  }

  private ensureGroup(issue: SdlcIssue): void {
    const jid = issueJid(issue.repo, issue.issue_number);
    const folder = issueFolder(issue.repo, issue.issue_number);
    const wtPath = getWorktreePath(issue.repo, issue.issue_number);

    const mounts: Array<{
      hostPath: string;
      containerPath: string;
      readonly: boolean;
    }> = [{ hostPath: wtPath, containerPath: 'repo', readonly: false }];

    // Mount plugin cache if plugins are available
    const pluginsCacheDir = getPluginsCacheDir();
    if (fs.existsSync(pluginsCacheDir)) {
      mounts.push({
        hostPath: pluginsCacheDir,
        containerPath: 'plugins',
        readonly: true,
      });
    }

    this.deps.registerGroup(jid, {
      name: `SDLC: ${issue.repo}#${issue.issue_number}`,
      folder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      containerConfig: {
        timeout: 3600000,
        additionalMounts: mounts,
      },
    });
  }

  private enqueueStage(issue: SdlcIssue): void {
    const stage = issue.current_stage;
    if (!RUNNABLE_STAGES.has(stage)) return;

    const isHeavy = HEAVY_STAGES.has(stage);
    const isMerge = stage === 'merge';

    // Gate merges: only one merge per repo at a time
    if (isMerge && this.mergeActive.has(issue.repo)) {
      if (
        !this.deferredMergeQueue.some(
          (i) => i.repo === issue.repo && i.issue_number === issue.issue_number,
        )
      ) {
        this.deferredMergeQueue.push(issue);
        logger.info(
          {
            repo: issue.repo,
            issueNumber: issue.issue_number,
            queued: this.deferredMergeQueue.length,
          },
          'Merge deferred — another merge active for this repo',
        );
      }
      return;
    }

    // Gate heavy stages to keep slots available for triage/plan/chat
    if (isHeavy && this.heavyActiveCount >= SDLC_MAX_HEAVY_CONTAINERS) {
      if (
        !this.deferredHeavyQueue.some(
          (i) => i.repo === issue.repo && i.issue_number === issue.issue_number,
        )
      ) {
        this.deferredHeavyQueue.push(issue);
        logger.info(
          {
            repo: issue.repo,
            issueNumber: issue.issue_number,
            stage,
            heavyActive: this.heavyActiveCount,
            heavyLimit: SDLC_MAX_HEAVY_CONTAINERS,
            deferred: this.deferredHeavyQueue.length,
          },
          'Heavy stage deferred — at heavy-container limit',
        );
      }
      this.ensureHeavyDrainTimer();
      return;
    }

    if (isHeavy) this.heavyActiveCount++;
    if (isMerge) {
      this.mergeActive.add(issue.repo);
      ghLabel(issue.repo, issue.issue_number, 'add', 'sdlc:merge-ready');
    }

    const jid = issueJid(issue.repo, issue.issue_number);
    const folder = issueFolder(issue.repo, issue.issue_number);

    // Close any idle container from the previous stage so the new task starts promptly
    this.deps.queue.closeStdin(jid);
    const taskId = `sdlc-${issue.repo}-${issue.issue_number}-${stage}-${Date.now()}`;

    const prompt = getPromptForStage(stage, issue);
    const plugins = this.syncPlugins(issue.repo);

    this.deps.queue.enqueueTask(jid, taskId, async () => {
      try {
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
            plugins: plugins.length > 0 ? plugins : undefined,
          },
          (proc, containerName) =>
            this.deps.onProcess(jid, proc, containerName, folder),
          async (streamedOutput) => {
            // Close container immediately — SDLC stages are single-turn
            if (streamedOutput.status === 'success' || streamedOutput.result) {
              this.deps.queue.notifyIdle(jid);
              this.deps.queue.closeStdin(jid);
            }
          },
        );

        if (output.newSessionId) {
          this.deps.setSession(folder, output.newSessionId);
        }

        // Clear pending feedback after the stage has consumed it
        const currentMeta = getSdlcIssue(issue.repo, issue.issue_number);
        if (currentMeta?.metadata) {
          const m = JSON.parse(currentMeta.metadata);
          if (m.pending_feedback) {
            delete m.pending_feedback;
            updateSdlcStage(
              issue.repo,
              issue.issue_number,
              currentMeta.current_stage,
              {
                metadata: JSON.stringify(m),
              },
            );
          }
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
      } finally {
        if (isHeavy) {
          this.heavyActiveCount--;
          this.drainDeferredHeavy();
        }
        if (isMerge) {
          this.mergeActive.delete(issue.repo);
          this.drainDeferredMerge(issue.repo);
        }
      }
    });
  }

  private drainDeferredHeavy(): void {
    while (
      this.deferredHeavyQueue.length > 0 &&
      this.heavyActiveCount < SDLC_MAX_HEAVY_CONTAINERS
    ) {
      const deferred = this.deferredHeavyQueue.shift()!;
      // Re-read from DB in case stage changed while deferred
      const current = getSdlcIssue(deferred.repo, deferred.issue_number);
      if (current && HEAVY_STAGES.has(current.current_stage)) {
        logger.info(
          {
            repo: current.repo,
            issueNumber: current.issue_number,
            stage: current.current_stage,
            heavyActive: this.heavyActiveCount,
          },
          'Draining deferred heavy stage',
        );
        this.enqueueStage(current);
      }
    }
    if (this.deferredHeavyQueue.length === 0 && this.heavyDrainTimer) {
      clearInterval(this.heavyDrainTimer);
      this.heavyDrainTimer = null;
    }
  }

  private ensureHeavyDrainTimer(): void {
    if (this.heavyDrainTimer) return;
    this.heavyDrainTimer = setInterval(() => this.drainDeferredHeavy(), 30_000);
  }

  private drainDeferredMerge(repo: string): void {
    if (this.mergeActive.has(repo)) return;

    const idx = this.deferredMergeQueue.findIndex((i) => i.repo === repo);
    if (idx === -1) return;

    const [deferred] = this.deferredMergeQueue.splice(idx, 1);
    const current = getSdlcIssue(deferred.repo, deferred.issue_number);
    if (current && current.current_stage === 'merge') {
      logger.info(
        { repo, issueNumber: current.issue_number },
        'Draining deferred merge',
      );
      this.enqueueStage(current);
    }
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
