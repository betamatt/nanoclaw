import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { updateContainerConfig } from '../container-config.js';
import { wakeContainer, getActiveContainerCount, killContainer, onContainerExit } from '../container-runner.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { readEnvFile } from '../env.js';
import { initGroupFilesystem } from '../group-init.js';
import { log } from '../log.js';
import { resolveSession, writeSessionMessage, sessionDir, outboundDbPath } from '../session-manager.js';
import type { AgentGroup, Session } from '../types.js';
import { MAX_SDLC_RETRIES, SDLC_MAX_HEAVY_CONTAINERS, SDLC_REPOS, SDLC_WEBHOOK_URL } from './config.js';
import {
  fetchIssueView,
  fetchNewlyUnblockedIssues,
  fetchIssuesByLabel,
  resolveIssueForPr,
  hasFeedbackFlag,
  invalidateCache,
  type SdlcIssueView,
} from './github-state.js';
import { getPromptForStage } from './prompts.js';
import {
  createWorktree,
  getWorktreePath,
  rebaseWorktree,
  removeWorktree,
  switchWorktreeToBranch,
} from './repo-manager.js';
import { addFlag, applyStateLabel, removeFlag } from './labels.js';
import { getPluginsCacheDir, syncPluginsForRepo } from './plugin-cache.js';
import { startFunnel, stopFunnel } from './tailscale-funnel.js';
import type { BlockerRef, SdlcPipelineDeps, SdlcStage, SdlcStageResult } from './types.js';
import { startWebhookServer } from './webhook-server.js';
import { ensureWebhooks, setWebhookUrl } from './webhook-setup.js';

/** Next stage after a successful completion */
const STAGE_TRANSITIONS: Record<string, SdlcStage> = {
  triage: 'plan',
  plan: 'awaiting_approval',
  implement: 'review',
  review: 'validate',
  // validate → merge is triggered by sdlc:cmd:merge command, not automatic
};

/** Label state names corresponding to internal stages */
const STAGE_TO_LABEL: Record<string, string> = {
  triage: 'triage',
  plan: 'triage', // plan is part of triage in the label model
  blocked: 'blocked',
  awaiting_approval: 'plan-ready',
  implement: 'implementing',
  review: 'review',
  validate: 'validate',
  merge: 'merging',
};

/** Stages that run a container agent */
const RUNNABLE_STAGES = new Set<SdlcStage>(['triage', 'plan', 'implement', 'review', 'validate', 'merge']);

/** Heavy stages that are capped by SDLC_MAX_HEAVY_CONTAINERS */
const HEAVY_STAGES = new Set<SdlcStage>(['implement', 'review', 'validate', 'merge']);

function issueAgentGroupId(repo: string, issueNumber: number): string {
  const slug = repo.replace(/\//g, '-').toLowerCase();
  return `sdlc-${slug}-${issueNumber}`;
}

function issueFolder(repo: string, issueNumber: number): string {
  const slug = repo.replace(/\//g, '-').toLowerCase();
  return `sdlc-${slug}-${issueNumber}`;
}


/** Best-effort label add/remove via gh CLI. */
function ghLabel(repo: string, issueNumber: number, action: 'add' | 'remove', label: string): void {
  try {
    const ghEnv = readEnvFile(['GITHUB_TOKEN']);
    const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return;
    const flag = action === 'add' ? '--add-label' : '--remove-label';
    execSync(`gh issue edit ${issueNumber} ${flag} "${label}" --repo ${repo}`, {
      env: { ...process.env, GITHUB_TOKEN: token },
      stdio: 'pipe',
    });
  } catch {
    // best-effort
  }
}

/** Best-effort comment on an issue via gh CLI. */
function ghComment(repo: string, issueNumber: number, body: string): void {
  try {
    const ghEnv = readEnvFile(['GITHUB_TOKEN']);
    const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return;
    execSync(`gh issue comment ${issueNumber} --repo ${repo} --body "${body.replace(/"/g, '\\"')}"`, {
      env: { ...process.env, GITHUB_TOKEN: token },
      stdio: 'pipe',
    });
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

function linkifyRefs(text: string): string {
  const repoMatch = text.match(/\bin\s+([\w.-]+\/[\w.-]+)/);
  if (!repoMatch) return text;
  const repo = repoMatch[1];
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

// ── Ephemeral state (in-memory only, lost on restart) ────────────────────────

interface EphemeralState {
  retryCount: number;
}

const ephemeral = new Map<string, EphemeralState>();

function ephemeralKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function getRetryCount(repo: string, issueNumber: number): number {
  return ephemeral.get(ephemeralKey(repo, issueNumber))?.retryCount ?? 0;
}

function setRetryCount(repo: string, issueNumber: number, count: number): void {
  const key = ephemeralKey(repo, issueNumber);
  const existing = ephemeral.get(key) ?? { retryCount: 0 };
  existing.retryCount = count;
  ephemeral.set(key, existing);
}

function resetRetryCount(repo: string, issueNumber: number): void {
  ephemeral.delete(ephemeralKey(repo, issueNumber));
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/** Deferred queue entry — lightweight, just repo + issue number. */
interface DeferredEntry {
  repo: string;
  issue_number: number;
}

export type SdlcPipeline = InstanceType<typeof SdlcPipelineImpl>;

class SdlcPipelineImpl {
  private deps: SdlcPipelineDeps;
  private heavyActiveCount = 0;
  private deferredHeavyQueue: DeferredEntry[] = [];
  private heavyDrainTimer: ReturnType<typeof setInterval> | null = null;
  private repoPlugins = new Map<string, string[]>();
  private mergeActive = new Set<string>();
  private deferredMergeQueue: DeferredEntry[] = [];

  constructor(deps: SdlcPipelineDeps) {
    this.deps = deps;
  }

  private syncPlugins(repo: string): string[] {
    if (this.repoPlugins.has(repo)) return this.repoPlugins.get(repo)!;
    try {
      const hostPaths = syncPluginsForRepo(repo);
      const containerPaths = hostPaths.map((p) => {
        const name = path.basename(p);
        return `/workspace/extra/plugins/${name}`;
      });
      this.repoPlugins.set(repo, containerPaths);
      if (containerPaths.length > 0) {
        log.info('Plugins synced for repo', { repo, plugins: containerPaths });
      }
      return containerPaths;
    } catch (err) {
      log.warn('Failed to sync plugins', { repo, err });
      return [];
    }
  }

  private async notify(text: string): Promise<void> {
    await this.deps.sendNotification(linkifyRefs(text));
  }

  // ── Stage label helper ───────────────────────────────────────────────────

  /** Apply a label state on the correct target (issue or PR). */
  private applyLabel(issue: SdlcIssueView, stage: SdlcStage): void {
    const labelState = STAGE_TO_LABEL[stage];
    if (!labelState) return;

    const prStages = new Set(['review', 'review_flagged', 'validate', 'merge', 'merge']);
    const target = prStages.has(stage) && issue.pr_number ? issue.pr_number : issue.issue_number;

    try {
      applyStateLabel(issue.repo, target, labelState as import('./transitions.js').SdlcState);
    } catch (err) {
      log.warn('Label apply failed (non-fatal)', { repo: issue.repo, issueNumber: issue.issue_number, stage, err });
    }
  }

  /** Get the GitHub number to apply flags to (PR for PR stages, issue otherwise). */
  private getTargetNumber(issue: SdlcIssueView): number {
    const prStages = new Set(['review', 'review_flagged', 'validate', 'merge', 'merge']);
    return prStages.has(issue.current_stage) && issue.pr_number ? issue.pr_number : issue.issue_number;
  }

  // ── Webhook handlers ─────────────────────────────────────────────────────

  async handleIssueOpened(
    repo: string,
    issueNumber: number,
    title: string,
    body: string,
    labels: string[],
  ): Promise<void> {
    // Idempotent: skip if already has an SDLC label
    if (labels.some((l) => l.startsWith('sdlc:'))) {
      log.info('Issue already has SDLC label, skipping', { repo, issueNumber });
      return;
    }

    log.info('SDLC issue created, starting triage', { repo, issueNumber });
    await this.notify(`SDLC: New issue #${issueNumber} in ${repo} — starting triage`);

    // Apply triage label
    ghLabel(repo, issueNumber, 'add', 'sdlc:triage');

    // Create worktree on main for investigation
    createWorktree(repo, issueNumber);

    // Fetch the view now that labels are applied
    invalidateCache(repo, issueNumber);
    const issue = fetchIssueView(repo, issueNumber);

    this.ensureAgentGroup(issue);
    this.enqueueStage(issue);
  }

  async handlePlanApproved(repo: string, issueNumber: number): Promise<void> {
    const issue = fetchIssueView(repo, issueNumber);

    if (issue.current_stage !== 'awaiting_approval' && issue.current_stage !== 'implement') {
      log.debug('Plan approval ignored — not awaiting approval', { repo, issueNumber, stage: issue.current_stage });
      return;
    }

    log.info('Plan approved, starting implementation', { repo, issueNumber });
    await this.notify(`SDLC: Plan approved for #${issueNumber} in ${repo} — starting implementation`);

    // Check for open blockers (blockedBy + sub-issues) via GitHub API
    if (issue.blocked_by.length > 0) {
      const blockerList = issue.blocked_by.map((b) => `${b.repo}#${b.issue_number}`).join(', ');
      applyStateLabel(repo, issueNumber, 'blocked');
      log.info('Issue blocked', { repo, issueNumber, blockers: blockerList });
      await this.notify(
        `SDLC: #${issueNumber} in ${repo} plan approved but blocked by ${blockerList} — will resume when they close`,
      );
      return;
    }

    // Create implementation branch and switch worktree to it
    const branchName = `sdlc/${issueNumber}-${slugify(issue.issue_title)}`;
    switchWorktreeToBranch(repo, issueNumber, branchName);

    // Label is already sdlc:plan-approved from the human action
    resetRetryCount(repo, issueNumber);

    invalidateCache(repo, issueNumber);
    const updated = fetchIssueView(repo, issueNumber);
    this.ensureAgentGroup(updated);
    this.enqueueStage(updated);
  }

  async handleFeedback(repo: string, issueNumber: number, feedbackText?: string): Promise<boolean> {
    const issue = fetchIssueView(repo, issueNumber);

    const stage = issue.current_stage;
    const terminalStages = new Set<SdlcStage>(['done']);
    if (terminalStages.has(stage)) {
      log.debug('Feedback ignored — terminal stage', { repo, issueNumber, stage });
      return false;
    }

    // Skip non-actionable comments
    if (feedbackText) {
      const text = feedbackText.trim().toLowerCase();
      if (/^@\w/.test(text) && !text.startsWith('@sdlc')) return false;
      if (['thanks', 'thank you', 'ty', 'ok', 'k', 'cool', 'nice', '\u{1F44D}', '\u{1F389}', '\u{2705}'].includes(text)) return false;
    }

    let targetStage: SdlcStage;
    const humanGateStages = new Set<SdlcStage>(['awaiting_approval', 'merge']);

    if (stage === 'awaiting_approval') {
      targetStage = 'plan';
    } else if (stage === 'merge') {
      targetStage = 'review';
    } else if (RUNNABLE_STAGES.has(stage)) {
      targetStage = stage;
    } else {
      return false;
    }

    log.info('Feedback received — re-running stage', { repo, issueNumber, from: stage, to: targetStage });
    await this.notify(`SDLC: Feedback on #${issueNumber} in ${repo} — re-running ${targetStage}`);

    // Remove feedback-required flag if present
    const targetNumber = this.getTargetNumber(issue);
    try { removeFlag(repo, targetNumber, 'feedback-required'); } catch { /* best effort */ }

    // Apply the target stage label
    this.applyLabel(issue, targetStage);
    resetRetryCount(repo, issueNumber);

    invalidateCache(repo, issueNumber);
    const updated = fetchIssueView(repo, issueNumber);
    this.ensureAgentGroup(updated);
    this.enqueueStage(updated);
    return true;
  }

  async handleStageResult(result: SdlcStageResult): Promise<void> {
    const issue = fetchIssueView(result.repo, result.issueNumber);

    if (result.success) {
      await this.advanceStage(issue, result.metadata);
    } else {
      await this.handleFailure(issue, result.metadata);
    }
  }

  async handleRetry(repo: string, issueNumber: number): Promise<void> {
    const issue = fetchIssueView(repo, issueNumber);

    log.info('Retrying issue', { repo, issueNumber, stage: issue.current_stage });
    await this.notify(`SDLC: Retrying #${issueNumber} in ${repo} from ${issue.current_stage}`);

    const targetNumber = this.getTargetNumber(issue);
    try { removeFlag(repo, targetNumber, 'feedback-required'); } catch { /* best effort */ }

    resetRetryCount(repo, issueNumber);

    this.ensureAgentGroup(issue);
    this.enqueueStage(issue);
  }

  async handleMergeRequested(repo: string, prNumber: number): Promise<void> {
    const issueNum = resolveIssueForPr(repo, prNumber);
    if (!issueNum) {
      log.debug('Merge requested for unknown PR', { repo, prNumber });
      return;
    }

    const issue = fetchIssueView(repo, issueNum);
    if (issue.current_stage !== 'validate' && issue.current_stage !== 'merge') {
      log.debug('Merge requested but not in validate/merge stage', {
        repo, issueNumber: issueNum, stage: issue.current_stage,
      });
      return;
    }

    log.info('Merge requested by human', { repo, issueNumber: issueNum, prNumber });
    await this.notify(`SDLC: Merge requested for #${issueNum} in ${repo} — queuing PR #${prNumber}`);

    resetRetryCount(repo, issueNum);
    this.ensureAgentGroup(issue);
    this.enqueueStage(issue);
  }

  async handleFeedbackFlagRemoved(repo: string, number: number): Promise<void> {
    // Could be issue or PR number — try both
    let issueNum = number;
    const issue = fetchIssueView(repo, number);
    if (issue.current_stage === 'done') {
      // Might be a PR — resolve to issue
      const resolved = resolveIssueForPr(repo, number);
      if (resolved) issueNum = resolved;
    }

    const view = issueNum !== number ? fetchIssueView(repo, issueNum) : issue;
    if (!RUNNABLE_STAGES.has(view.current_stage)) {
      log.debug('Flag removed but stage not runnable', { repo, issueNumber: issueNum, stage: view.current_stage });
      return;
    }

    log.info('Feedback flag removed — re-running stage', { repo, issueNumber: issueNum, stage: view.current_stage });
    await this.notify(`SDLC: Feedback resolved for #${issueNum} in ${repo} — re-running ${view.current_stage}`);

    resetRetryCount(repo, issueNum);
    this.ensureAgentGroup(view);
    this.enqueueStage(view);
  }

  async handleReviewResolved(repo: string, issueNumber: number): Promise<void> {
    const issue = fetchIssueView(repo, issueNumber);

    if (issue.current_stage !== 'review') {
      log.debug('Review resolved ignored — not in review', { repo, issueNumber, stage: issue.current_stage });
      return;
    }

    log.info('Review items resolved, advancing to validation', { repo, issueNumber });
    await this.notify(`SDLC: Review resolved for #${issueNumber} in ${repo} — starting validation`);

    if (issue.pr_number) {
      try { removeFlag(repo, issue.pr_number, 'feedback-required'); } catch { /* best effort */ }
    }

    applyStateLabel(repo, issue.pr_number || issueNumber, 'validate');
    resetRetryCount(repo, issueNumber);

    invalidateCache(repo, issueNumber);
    const updated = fetchIssueView(repo, issueNumber);
    this.ensureAgentGroup(updated);
    this.enqueueStage(updated);
  }

  async handleResume(repo: string, issueNumber: number): Promise<void> {
    const issue = fetchIssueView(repo, issueNumber);

    if (RUNNABLE_STAGES.has(issue.current_stage)) {
      log.info('Resuming — re-enqueueing current stage', { repo, issueNumber, stage: issue.current_stage });
      this.ensureAgentGroup(issue);
      this.enqueueStage(issue);
      return;
    }

    // Determine resume stage from GitHub state
    const resumeStage = this.determineResumeStage(issue);

    log.info('Resuming SDLC issue', { repo, issueNumber, from: issue.current_stage, to: resumeStage });
    await this.notify(`SDLC: Resuming #${issueNumber} in ${repo} at ${resumeStage}`);

    // Ensure worktree exists
    const wtPath = getWorktreePath(repo, issueNumber);
    if (!fs.existsSync(wtPath)) {
      createWorktree(repo, issueNumber);
    }

    if (resumeStage === 'implement' && issue.branch_name) {
      switchWorktreeToBranch(repo, issueNumber, issue.branch_name);
    }

    // Apply the resume label
    this.applyLabel(issue, resumeStage);
    resetRetryCount(repo, issueNumber);

    invalidateCache(repo, issueNumber);
    const updated = fetchIssueView(repo, issueNumber);
    this.ensureAgentGroup(updated);
    this.enqueueStage(updated);
  }

  private determineResumeStage(issue: SdlcIssueView): SdlcStage {
    try {
      if (issue.pr_number) {
        const ghEnv = readEnvFile(['GITHUB_TOKEN']);
        const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
        if (!token) return 'triage';
        const prJson = execSync(
          `gh pr view ${issue.pr_number} --repo ${issue.repo} --json state,merged`,
          { encoding: 'utf-8', env: { ...process.env, GITHUB_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const pr = JSON.parse(prJson) as { state: string; merged: boolean };
        if (pr.merged) return 'done' as SdlcStage;
        return 'implement';
      }
      if (issue.branch_name) return 'implement';
      if (issue.classification) return 'plan';
      return 'triage';
    } catch {
      return 'triage';
    }
  }

  async handlePrMerged(repo: string, prNumber: number): Promise<void> {
    const issueNum = resolveIssueForPr(repo, prNumber);
    if (!issueNum) return;

    log.info('PR merged — completing SDLC issue', { repo, issueNumber: issueNum, prNumber });

    // Close the issue
    try {
      execSync(`gh issue close ${issueNum} --repo ${repo}`, {
        env: { ...process.env, ...readEnvFile(['GITHUB_TOKEN']) },
        stdio: 'pipe',
      });
    } catch { /* best effort */ }

    removeWorktree(repo, issueNum);
    await this.notify(`SDLC: #${issueNum} in ${repo} — PR #${prNumber} merged. Done.`);

    // Rebase other in-flight branches
    await this.rebaseInFlightBranches(repo);
  }

  private async rebaseInFlightBranches(repo: string): Promise<void> {
    // Find open PRs with SDLC labels that need rebasing
    const rebaseLabels = ['sdlc:review', 'sdlc:validate', 'sdlc:merging'];
    const candidates: SdlcIssueView[] = [];

    for (const label of rebaseLabels) {
      const issues = fetchIssuesByLabel(label, [repo]);
      for (const { number } of issues) {
        const issueNum = resolveIssueForPr(repo, number);
        if (issueNum) {
          candidates.push(fetchIssueView(repo, issueNum));
        }
      }
    }

    if (candidates.length === 0) return;
    log.info('Post-merge: rebasing in-flight branches', { repo, count: candidates.length });

    for (const issue of candidates) {
      if (!issue.branch_name) continue;
      const success = rebaseWorktree(repo, issue.issue_number);

      if (success) {
        try {
          const wtPath = getWorktreePath(repo, issue.issue_number);
          execSync(`git push --force-with-lease origin ${issue.branch_name}`, { cwd: wtPath, stdio: 'pipe' });
          log.info('Rebased and pushed branch', { repo, issueNumber: issue.issue_number, branch: issue.branch_name });
        } catch (err) {
          log.warn('Rebase succeeded but push failed', { repo, issueNumber: issue.issue_number, err });
        }
      } else {
        // Conflict — send to review
        if (issue.pr_number) {
          applyStateLabel(repo, issue.pr_number, 'review');
        }
        resetRetryCount(repo, issue.issue_number);

        invalidateCache(repo, issue.issue_number);
        const updated = fetchIssueView(repo, issue.issue_number);
        this.ensureAgentGroup(updated);
        this.enqueueStage(updated);

        await this.notify(`SDLC: #${issue.issue_number} in ${repo} — merge conflict detected, sending to review`);
      }
    }
  }

  /**
   * When an issue is closed, check if any blocked issues can advance.
   * Searches GitHub for ALL sdlc:blocked issues across configured repos.
   */
  async handleIssueClosed(repo: string, issueNumber: number): Promise<void> {
    log.info('Issue closed', { repo, issueNumber });
    removeWorktree(repo, issueNumber);

    // Check all sdlc:blocked issues — unblock any whose blockedBy + subIssues are all closed
    const unblocked = fetchNewlyUnblockedIssues(SDLC_REPOS);

    for (const issue of unblocked) {
      applyStateLabel(issue.repo, issue.issue_number, 'implementing');
      log.info('Issue unblocked, advancing', { repo: issue.repo, issueNumber: issue.issue_number });
      await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} unblocked — starting implementation`);

      createWorktree(issue.repo, issue.issue_number);
      const branchName = `sdlc/${issue.issue_number}-${slugify(issue.issue_title)}`;
      switchWorktreeToBranch(issue.repo, issue.issue_number, branchName);

      invalidateCache(issue.repo, issue.issue_number);
      const updated = fetchIssueView(issue.repo, issue.issue_number);
      this.ensureAgentGroup(updated);
      this.enqueueStage(updated);
    }
  }

  async handleIssueEdited(repo: string, issueNumber: number, _body: string): Promise<void> {
    // Re-fetch blockers from GitHub's native API (not body text)
    invalidateCache(repo, issueNumber);
    const issue = fetchIssueView(repo, issueNumber);

    if (issue.current_stage === 'blocked' && issue.blocked_by.length === 0) {
      applyStateLabel(repo, issueNumber, 'implementing');
      log.info('Issue unblocked (edit cleared blockers)', { repo, issueNumber });
      await this.notify(`SDLC: #${issueNumber} in ${repo} unblocked — starting implementation`);

      const updated = fetchIssueView(repo, issueNumber);
      this.ensureAgentGroup(updated);
      this.enqueueStage(updated);
    } else if (issue.blocked_by.length > 0 && ['plan', 'awaiting_approval'].includes(issue.current_stage)) {
      applyStateLabel(repo, issueNumber, 'blocked');
      log.info('Issue moved to blocked', { repo, issueNumber });
      await this.notify(`SDLC: #${issueNumber} in ${repo} now blocked`);
    }
  }

  // ── Recovery ──────────────────────────────────────────────────────────────

  /** Re-enqueue a runnable issue. Used by the container exit hook. */
  retryIfRunnable(repo: string, issueNumber: number): void {
    const issue = fetchIssueView(repo, issueNumber);
    if (!RUNNABLE_STAGES.has(issue.current_stage)) return;
    this.ensureAgentGroup(issue);
    this.enqueueStage(issue);
  }

  recoverInProgress(): void {
    // Scan GitHub labels across all configured repos — labels are the source of truth
    const labelToStage: Record<string, SdlcStage> = {
      triage: 'triage',
      blocked: 'blocked',
      'plan-ready': 'awaiting_approval',
      'implementing': 'implement',
      review: 'review',
      validate: 'validate',
      'merging': 'merge',
    };

    for (const [labelState, dbStage] of Object.entries(labelToStage)) {
      if (!RUNNABLE_STAGES.has(dbStage)) continue;

      const label = `sdlc:${labelState}`;
      const issues = fetchIssuesByLabel(label, SDLC_REPOS);

      for (const { repo, number } of issues) {
        // Resolve issue number (might be a PR)
        let issueNum = number;
        const isPrState = ['review', 'validate', 'merging'].includes(labelState);
        if (isPrState) {
          const resolved = resolveIssueForPr(repo, number);
          if (resolved) issueNum = resolved;
        }

        // Skip feedback-required flagged issues
        if (hasFeedbackFlag(repo, number)) {
          log.debug('Skipping recovery — feedback-required', { repo, issueNumber: number, stage: labelState });
          continue;
        }

        const issue = fetchIssueView(repo, issueNum);

        log.info('Recovering from GitHub label', {
          repo, issueNumber: issueNum, prNumber: issueNum !== number ? number : undefined, stage: labelState,
        });

        this.ensureAgentGroup(issue);
        this.enqueueStage(issue);
      }
    }
  }

  // ── Stage advancement ─────────────────────────────────────────────────────

  private async advanceStage(issue: SdlcIssueView, metadata?: Record<string, unknown>): Promise<void> {
    // Validate completion: low-risk auto-merges, high-risk waits for human sdlc:cmd:merge
    if (issue.current_stage === 'validate') {
      if (metadata?.risk === 'low') {
        log.info('Low-risk PR — auto-advancing to merge', { repo: issue.repo, issueNumber: issue.issue_number });
        await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — low-risk, auto-merging`);
        const prNum = issue.pr_number;
        if (prNum) applyStateLabel(issue.repo, prNum, 'merging');
        invalidateCache(issue.repo, issue.issue_number);
        const mergeIssue = fetchIssueView(issue.repo, issue.issue_number);
        this.ensureAgentGroup(mergeIssue);
        this.enqueueStage(mergeIssue);
      } else {
        log.info('Validation complete — waiting for human to apply sdlc:cmd:merge', { repo: issue.repo, issueNumber: issue.issue_number });
        await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — validation passed. Apply \`sdlc:cmd:merge\` to merge.`);
      }
      return;
    }

    const nextStage = STAGE_TRANSITIONS[issue.current_stage];
    if (!nextStage) {
      log.warn('No transition from current stage', { stage: issue.current_stage });
      return;
    }

    // Persist stage-specific metadata via GitHub
    if (metadata) {
      if (metadata.pr_number) {
        ghComment(issue.repo, issue.issue_number, `Implementation PR opened: #${metadata.pr_number}`);
      }
      if (issue.current_stage === 'triage' && metadata.classification) {
        // Add classification as labels
        const cls = metadata.classification as { type?: string; complexity?: string };
        if (cls.type) ghLabel(issue.repo, issue.issue_number, 'add', cls.type);
        if (cls.complexity) ghLabel(issue.repo, issue.issue_number, 'add', `complexity:${cls.complexity}`);
      }
    }

    // After triage, check for open blockers (blockedBy + sub-issues from GitHub API)
    if (issue.current_stage === 'triage') {
      // Re-fetch to get fresh blocker state
      invalidateCache(issue.repo, issue.issue_number);
      const fresh = fetchIssueView(issue.repo, issue.issue_number);
      if (fresh.blocked_by.length > 0) {
        applyStateLabel(issue.repo, issue.issue_number, 'blocked');
        log.info('Issue blocked after triage', { repo: issue.repo, issueNumber: issue.issue_number });
        await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} blocked — will resume when blockers close`);
        return;
      }
    }

    // After review, if items flagged for human, stay in review with feedback flag
    if (issue.current_stage === 'review' && metadata?.items_flagged && (metadata.items_flagged as number) > 0) {
      const targetNumber = this.getTargetNumber(issue);
      addFlag(issue.repo, targetNumber, 'feedback-required');
      log.info('Review flagged items for human', { repo: issue.repo, issueNumber: issue.issue_number });
      await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — review flagged items for human. sdlc:feedback-required added.`);
      return;
    }

    // After merge success: done
    if (issue.current_stage === 'merge') {
      removeWorktree(issue.repo, issue.issue_number);
      ghLabel(issue.repo, issue.issue_number, 'remove', 'sdlc:merging');
      // Close the issue
      try {
        execSync(`gh issue close ${issue.issue_number} --repo ${issue.repo}`, {
          env: { ...process.env, ...readEnvFile(['GITHUB_TOKEN']) },
          stdio: 'pipe',
        });
      } catch { /* best effort */ }

      log.info('Merge complete — issue done', { repo: issue.repo, issueNumber: issue.issue_number });
      await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — merged. Done.`);
      await this.rebaseInFlightBranches(issue.repo);
      return;
    }

    // Apply the next stage label
    const prNumber = (metadata?.pr_number as number) || issue.pr_number;
    const prStages = new Set<SdlcStage>(['review', 'validate', 'merge', 'merge']);
    const target = prStages.has(nextStage) && prNumber ? prNumber : issue.issue_number;
    const labelState = STAGE_TO_LABEL[nextStage];
    if (labelState) {
      applyStateLabel(issue.repo, target, labelState as import('./transitions.js').SdlcState);
    }

    resetRetryCount(issue.repo, issue.issue_number);

    log.info('SDLC stage advanced', { repo: issue.repo, issueNumber: issue.issue_number, from: issue.current_stage, to: nextStage });
    await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — ${issue.current_stage} -> ${nextStage}`);

    if (nextStage === 'awaiting_approval') {
      // Wait for human label
      return;
    }

    // Enqueue the next stage
    invalidateCache(issue.repo, issue.issue_number);
    const updated = fetchIssueView(issue.repo, issue.issue_number);
    this.enqueueStage(updated);
  }

  private async handleFailure(issue: SdlcIssueView, metadata?: Record<string, unknown>): Promise<void> {
    // Merge failures: stay in merge with feedback-required
    if (issue.current_stage === 'merge') {
      const targetNumber = this.getTargetNumber(issue);
      addFlag(issue.repo, targetNumber, 'feedback-required');
      log.warn('Merge failed — feedback-required added', { repo: issue.repo, issueNumber: issue.issue_number });
      await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — merge failed. sdlc:feedback-required added.`);
      return;
    }

    const retryCount = getRetryCount(issue.repo, issue.issue_number) + 1;

    if (retryCount <= MAX_SDLC_RETRIES) {
      log.info('Retrying SDLC stage', { repo: issue.repo, issueNumber: issue.issue_number, stage: issue.current_stage, retryCount });
      setRetryCount(issue.repo, issue.issue_number, retryCount);
      this.enqueueStage(issue);
      return;
    }

    // Max retries exhausted — add feedback-required flag
    const targetNumber = this.getTargetNumber(issue);
    addFlag(issue.repo, targetNumber, 'feedback-required');

    log.error('SDLC issue needs feedback after max retries', { repo: issue.repo, issueNumber: issue.issue_number, stage: issue.current_stage });
    await this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} needs help at ${issue.current_stage} — sdlc:feedback-required added`);
  }

  // ── Agent group + enqueue ─────────────────────────────────────────────────

  private ensureAgentGroup(issue: SdlcIssueView): void {
    const agId = issueAgentGroupId(issue.repo, issue.issue_number);
    const folder = issueFolder(issue.repo, issue.issue_number);

    if (getAgentGroup(agId)) return;
    if (getAgentGroupByFolder(folder)) return;

    const agentGroup: AgentGroup = {
      id: agId,
      name: `SDLC: ${issue.repo}#${issue.issue_number}`,
      folder,
      agent_provider: null,
      created_at: new Date().toISOString(),
    };

    createAgentGroup(agentGroup);
    initGroupFilesystem(agentGroup);
    log.info('Created SDLC agent group', { id: agId, folder });
  }

  private enqueueStage(issue: SdlcIssueView): void {
    const stage = issue.current_stage;
    if (!RUNNABLE_STAGES.has(stage)) return;

    // Guard: PR stages require an open PR
    const prStages = new Set<SdlcStage>(['review', 'validate', 'merge']);
    if (prStages.has(stage) && issue.pr_number) {
      try {
        const result = execSync(`gh pr view ${issue.pr_number} --repo ${issue.repo} --json state --jq .state`, {
          encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (result === 'CLOSED') {
          log.warn('PR is closed — adding feedback-required', { repo: issue.repo, issueNumber: issue.issue_number });
          addFlag(issue.repo, issue.pr_number, 'feedback-required');
          this.notify(`SDLC: #${issue.issue_number} in ${issue.repo} — PR #${issue.pr_number} is closed. sdlc:feedback-required added.`);
          return;
        }
      } catch { /* proceed */ }
    }

    // Guard: feedback-required flag pauses the pipeline
    const targetNumber = this.getTargetNumber(issue);
    if (hasFeedbackFlag(issue.repo, targetNumber)) {
      log.info('Issue has feedback-required flag — not enqueueing', { repo: issue.repo, issueNumber: issue.issue_number, stage });
      return;
    }

    const isHeavy = HEAVY_STAGES.has(stage);
    const isMerge = stage === 'merge';

    // Gate merges: one per repo
    if (isMerge && this.mergeActive.has(issue.repo)) {
      if (!this.deferredMergeQueue.some((i) => i.repo === issue.repo && i.issue_number === issue.issue_number)) {
        this.deferredMergeQueue.push({ repo: issue.repo, issue_number: issue.issue_number });
        log.info('Merge deferred', { repo: issue.repo, issueNumber: issue.issue_number });
      }
      return;
    }

    // Gate heavy stages
    if (isHeavy && this.heavyActiveCount >= SDLC_MAX_HEAVY_CONTAINERS) {
      if (!this.deferredHeavyQueue.some((i) => i.repo === issue.repo && i.issue_number === issue.issue_number)) {
        this.deferredHeavyQueue.push({ repo: issue.repo, issue_number: issue.issue_number });
        log.info('Heavy stage deferred', { repo: issue.repo, issueNumber: issue.issue_number, stage });
      }
      this.ensureHeavyDrainTimer();
      return;
    }

    if (isHeavy) this.heavyActiveCount++;
    if (isMerge) this.mergeActive.add(issue.repo);

    const agId = issueAgentGroupId(issue.repo, issue.issue_number);
    const folder = issueFolder(issue.repo, issue.issue_number);
    const prompt = getPromptForStage(stage, issue);

    // Ensure worktree is mounted
    const wtPath = getWorktreePath(issue.repo, issue.issue_number);
    if (fs.existsSync(wtPath)) {
      updateContainerConfig(folder, (config) => {
        const repoMount = { hostPath: wtPath, containerPath: 'repo', readonly: false };
        const existing = config.additionalMounts.find((m) => m.containerPath === 'repo');
        if (!existing) config.additionalMounts.push(repoMount);
        else existing.hostPath = wtPath;
      });
    }

    const { session } = resolveSession(agId, null, null, 'agent-shared');

    const messageId = `sdlc-${issue.repo}-${issue.issue_number}-${stage}-${Date.now()}`;
    writeSessionMessage(agId, session.id, {
      id: messageId,
      kind: 'task',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ prompt }),
    });

    wakeContainer(session)
      .then(() => {
        log.info('SDLC container woken', { repo: issue.repo, issueNumber: issue.issue_number, stage, sessionId: session.id });
      })
      .catch((err) => {
        log.error('Failed to wake SDLC container', { repo: issue.repo, issueNumber: issue.issue_number, stage, err });
        this.handleFailure(issue, { error: err instanceof Error ? err.message : 'Container wake failed' });
      })
      .finally(() => {
        if (isHeavy) {
          this.heavyActiveCount--;
          this.drainDeferredHeavy();
        }
        if (isMerge) {
          this.mergeActive.delete(issue.repo);
          this.drainDeferredMerge(issue.repo);
        }
      });
  }

  private drainDeferredHeavy(): void {
    while (this.deferredHeavyQueue.length > 0 && this.heavyActiveCount < SDLC_MAX_HEAVY_CONTAINERS) {
      const deferred = this.deferredHeavyQueue.shift()!;
      const issue = fetchIssueView(deferred.repo, deferred.issue_number);
      if (HEAVY_STAGES.has(issue.current_stage)) {
        log.info('Draining deferred heavy stage', { repo: issue.repo, issueNumber: issue.issue_number });
        this.enqueueStage(issue);
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
    const issue = fetchIssueView(deferred.repo, deferred.issue_number);
    if (issue.current_stage === 'merge') {
      log.info('Draining deferred merge', { repo, issueNumber: issue.issue_number });
      this.enqueueStage(issue);
    }
  }
}

// ── System startup ───────────────────────────────────────────────────────────

export function startSdlcSystem(deps: SdlcPipelineDeps): SdlcPipeline {
  const pipeline = new SdlcPipelineImpl(deps);
  startWebhookServer(pipeline);

  // If no explicit webhook URL, start Tailscale Funnel
  let webhookUrl = SDLC_WEBHOOK_URL;
  if (!webhookUrl) {
    const funnelUrl = startFunnel();
    if (funnelUrl) {
      webhookUrl = funnelUrl;
      setWebhookUrl(funnelUrl);
      log.info('Using Tailscale Funnel for webhook URL', { webhookUrl });
    }
  }

  if (webhookUrl) {
    const results = ensureWebhooks();
    for (const r of results) log.info('Webhook setup', { repo: r.repo, status: r.status });
  } else {
    log.warn('No webhook URL available — set SDLC_WEBHOOK_URL or install Tailscale');
  }

  pipeline.recoverInProgress();

  // Re-enqueue SDLC stages when their container exits without a result
  const RE_ENQUEUE_DELAY_MS = 30_000;
  onContainerExit((agentGroupId, _sessionId, _exitCode) => {
    if (!agentGroupId.startsWith('sdlc-')) return;

    setTimeout(() => {
      // Derive repo + issue number from agent group ID
      // Format: sdlc-{owner}-{repo}-{number}
      const parts = agentGroupId.split('-');
      const issueNum = parseInt(parts[parts.length - 1], 10);
      if (isNaN(issueNum)) return;
      // Reconstruct repo: everything between 'sdlc-' and '-{number}'
      const repoSlug = parts.slice(1, -1).join('-');
      // Find the matching configured repo
      const repo = SDLC_REPOS.find((r) => r.replace(/\//g, '-').toLowerCase() === repoSlug);
      if (!repo) return;

      const issue = fetchIssueView(repo, issueNum);
      if (!RUNNABLE_STAGES.has(issue.current_stage)) return;

      const retries = getRetryCount(repo, issueNum) + 1;
      if (retries > MAX_SDLC_RETRIES) {
        log.warn('SDLC container exit retry limit reached', { repo, issueNumber: issueNum, retries });
        return;
      }
      setRetryCount(repo, issueNum, retries);

      // Clear stale continuation keys
      try {
        const Database = require('better-sqlite3');
        const { getDb } = require('../db/connection.js');
        const db = getDb();
        const agId = issueAgentGroupId(repo, issueNum);
        const sessions = db.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').all(agId) as Array<{ id: string }>;
        for (const sess of sessions) {
          const outPath = outboundDbPath(agId, sess.id);
          if (fs.existsSync(outPath)) {
            const outDb = new Database(outPath);
            outDb.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'").run();
            outDb.close();
          }
        }
      } catch (err) {
        log.warn('Failed to clear continuation keys', { agentGroupId, err });
      }

      log.info('Re-enqueueing SDLC stage after container exit', { repo, issueNumber: issueNum, stage: issue.current_stage, retry: retries });
      pipeline.retryIfRunnable(repo, issueNum);
    }, RE_ENQUEUE_DELAY_MS);
  });

  log.info('SDLC system started');
  return pipeline;
}

export function stopSdlcSystem(): void {
  stopFunnel();
}
