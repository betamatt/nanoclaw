import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { runContainerAgent } from '../container-runner.js';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { MAX_SDLC_RETRIES, SDLC_WEBHOOK_URL } from './config.js';
import {
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
  validate: 'done',
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
    try {
      const { readEnvFile } = await import('../env.js');
      const ghEnv = readEnvFile(['GITHUB_TOKEN']);
      const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
      if (token) {
        const { execSync } = await import('child_process');
        execSync(
          `gh issue edit ${issueNumber} --add-label "sdlc:approve-plan" --repo ${repo}`,
          { env: { ...process.env, GITHUB_TOKEN: token }, stdio: 'pipe' },
        );
      }
    } catch {
      // Best-effort — don't block the pipeline
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
      }
      if (metadata.branch) {
        updates.branch_name = metadata.branch as string;
      }
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

    if (nextStage === 'done') {
      // Cleanup worktree
      removeWorktree(issue.repo, issue.issue_number);
      await this.deps.sendNotification(
        `SDLC: #${issue.issue_number} in ${issue.repo} completed successfully`,
      );
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
