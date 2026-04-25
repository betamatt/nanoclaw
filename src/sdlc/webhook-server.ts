import crypto from 'crypto';
import http from 'http';

import { log } from '../log.js';
import { GITHUB_WEBHOOK_SECRET, SDLC_REPOS } from './config.js';
import { execSync } from 'child_process';
import { readEnvFile } from '../env.js';
import { removeStateLabel } from './labels.js';
import type { SdlcPipeline } from './pipeline.js';
import {
  FEEDBACK_FLAG_LABEL,
  LEGAL_TRANSITIONS,
  type SdlcState,
  stateFromLabels,
  validateTransition,
} from './transitions.js';

/** Add a thumbs-up reaction to a comment to acknowledge it. */
function ghReact(repo: string, commentId: number): void {
  try {
    const ghEnv = readEnvFile(['GITHUB_TOKEN']);
    const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return;
    execSync(`gh api repos/${repo}/issues/comments/${commentId}/reactions -X POST -f content="+1"`, {
      env: { ...process.env, GITHUB_TOKEN: token },
      stdio: 'pipe',
    });
  } catch {
    // best-effort
  }
}

function verifySignature(payload: Buffer, signature: string | undefined): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    log.warn('GITHUB_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }
  if (!signature) return false;

  const expected = `sha256=${crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(payload).digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Register the GitHub webhook handler on the shared webhook server.
 * Route: /webhook/github
 */
export function startWebhookServer(pipeline: SdlcPipeline): void {
  // Import at top level to avoid require() in ESM
  import('../webhook-server.js').then(({ registerRawWebhookRoute }) => {

  registerRawWebhookRoute('github', (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'] as string | undefined;

      if (!verifySignature(body, signature)) {
        log.warn('Webhook signature verification failed');
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      // Respond immediately — process async
      res.writeHead(200);
      res.end('OK');

      const event = req.headers['x-github-event'] as string;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body.toString());
      } catch (err) {
        log.error('Failed to parse webhook payload', { err });
        return;
      }

      handleEvent(event, payload, pipeline).catch((err) => log.error('Error handling webhook event', { err, event }));
    });
  });
  }); // end import().then()
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
}

interface GitHubLabel {
  name: string;
}

const APPROVAL_PATTERNS = [
  /\bapproved?\b/i,
  /\bproceed\b/i,
  /\blgtm\b/i,
  /\bship\s*it\b/i,
  /\bgo\s*ahead\b/i,
  /\blets?\s*go\b/i,
  /\bimplement\s*(it|this)?\b/i,
  /\b(looks?\s*good|sounds?\s*good)\b/i,
];

function isAgentComment(body: string): boolean {
  return /\*Automated .+ by SDLC pipeline\*/.test(body);
}

function isPlanApproval(body: string): boolean {
  // Reject agent's own comments — they share the same GH identity as the user
  if (isAgentComment(body)) return false;
  const trimmed = body.trim().toLowerCase();
  // Short comments are more likely to be approvals; long ones are discussion
  if (trimmed.length > 280) return false;
  return APPROVAL_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Determine if a GitHub actor is the agent (bot/app) or a human.
 * GitHub Apps have [bot] suffix; the SDLC agent uses the same PAT as the user
 * so we check if the event was triggered by a known bot login.
 */
function isAgentActor(sender: Record<string, unknown> | undefined): boolean {
  if (!sender) return false;
  const type = sender.type as string | undefined;
  if (type === 'Bot') return true;
  // If the actor login matches the token owner, it could be either.
  // For now, label events from humans are the norm; agent applies labels via CLI.
  // We'll treat all webhook label events as human-initiated unless type is Bot.
  return false;
}

/**
 * Handle a label guard check for sdlc:* state labels.
 * Validates the transition and rolls back if invalid.
 * Returns the new state if valid, null if invalid or not an sdlc label.
 */
function guardLabelTransition(
  repo: string,
  number: number,
  appliedLabel: string,
  currentLabels: Array<{ name: string }>,
  sender: Record<string, unknown> | undefined,
): SdlcState | null {
  // Only guard sdlc:* state labels (not flags)
  if (!appliedLabel.startsWith('sdlc:') || appliedLabel === FEEDBACK_FLAG_LABEL) {
    return null;
  }

  const newState = appliedLabel.slice(5) as SdlcState;

  // Check if this is actually a known state
  if (!(newState in LEGAL_TRANSITIONS)) return null;

  const currentState = stateFromLabels(currentLabels.filter((l) => l.name !== appliedLabel));
  const actorIsAgent = isAgentActor(sender);

  // Validate but don't rollback — log only during migration period.
  // Humans need to be able to rescue stuck issues by applying any label.
  const error = validateTransition(currentState, newState, actorIsAgent);
  if (error) {
    log.info('Label guard: transition would be invalid (allowing during migration)', {
      repo,
      number,
      from: currentState,
      to: newState,
      error,
    });
  }

  return newState;
}

async function handleEvent(event: string, payload: Record<string, unknown>, pipeline: SdlcPipeline): Promise<void> {
  const repo = (payload.repository as { full_name: string })?.full_name;
  if (!repo) {
    log.warn('Webhook missing repository.full_name', { event });
    return;
  }

  // Check repo allowlist
  if (SDLC_REPOS.length > 0 && !SDLC_REPOS.includes(repo)) {
    log.debug('Ignoring webhook for non-configured repo', { repo, event });
    return;
  }

  const action = payload.action as string;

  switch (event) {
    case 'issues': {
      const issue = payload.issue as GitHubIssue;
      if (!issue) break;

      if (action === 'opened') {
        await pipeline.handleIssueOpened(
          repo,
          issue.number,
          issue.title,
          issue.body || '',
          issue.labels.map((l) => l.name),
        );
      } else if (action === 'closed') {
        await pipeline.handleIssueClosed(repo, issue.number);
      } else if (action === 'edited') {
        await pipeline.handleIssueEdited(repo, issue.number, issue.body || '');
      } else if (action === 'labeled') {
        const label = payload.label as GitHubLabel | undefined;
        if (!label) break;

        // New state machine: guard and dispatch sdlc:* labels
        const sender = payload.sender as Record<string, unknown> | undefined;
        const newState = guardLabelTransition(repo, issue.number, label.name, issue.labels, sender);
        if (newState === 'plan-approved') {
          await pipeline.handlePlanApproved(repo, issue.number);
        } else if (newState === 'merge') {
          // Human applied merge label on a PR (handled via issues API since PRs are issues)
          await pipeline.handleMergeRequested(repo, issue.number);
        }
      } else if (action === 'unlabeled') {
        // Flag removal: re-run the current stage
        const label = payload.label as GitHubLabel | undefined;
        if (label?.name === FEEDBACK_FLAG_LABEL) {
          await pipeline.handleFeedbackFlagRemoved(repo, issue.number);
        }
      }
      break;
    }

    case 'issue_comment': {
      if (action !== 'created') break;
      const comment = payload.comment as { id: number; body: string } | undefined;
      const issue = payload.issue as GitHubIssue | undefined;
      if (!comment || !issue) break;

      // Resolve the SDLC issue number — PRs have different numbers than their issues
      const { getSdlcIssue, getSdlcIssueByPr } = await import('./db.js');
      const isPr = !!(issue as unknown as Record<string, unknown>).pull_request;
      let sdlcIssueNumber = issue.number;
      if (!getSdlcIssue(repo, issue.number) && isPr) {
        const byPr = getSdlcIssueByPr(repo, issue.number);
        if (byPr) sdlcIssueNumber = byPr.issue_number;
      }

      let acted = false;
      if (comment.body.includes('/sdlc resume')) {
        await pipeline.handleResume(repo, sdlcIssueNumber);
        acted = true;
      } else if (comment.body.includes('/sdlc retry')) {
        await pipeline.handleRetry(repo, sdlcIssueNumber);
        acted = true;
      } else if (comment.body.includes('/sdlc review resolved')) {
        await pipeline.handleReviewResolved(repo, sdlcIssueNumber);
        acted = true;
      } else if (isPlanApproval(comment.body)) {
        await pipeline.handlePlanApproved(repo, sdlcIssueNumber);
        acted = true;
      } else if (!isAgentComment(comment.body)) {
        acted = await pipeline.handleFeedback(repo, sdlcIssueNumber, comment.body);
      }

      if (acted) ghReact(repo, comment.id);
      break;
    }

    case 'pull_request': {
      const pr = payload.pull_request as { number: number; merged: boolean; labels?: GitHubLabel[] } | undefined;
      if (!pr) break;

      if (action === 'closed' && pr.merged) {
        await pipeline.handlePrMerged(repo, pr.number);
      } else if (action === 'labeled') {
        const label = payload.label as GitHubLabel | undefined;
        if (label && pr.labels) {
          const sender = payload.sender as Record<string, unknown> | undefined;
          const newState = guardLabelTransition(repo, pr.number, label.name, pr.labels, sender);
          if (newState === 'merge') {
            await pipeline.handleMergeRequested(repo, pr.number);
          }
        }
      } else if (action === 'unlabeled') {
        const label = payload.label as GitHubLabel | undefined;
        if (label?.name === FEEDBACK_FLAG_LABEL) {
          await pipeline.handleFeedbackFlagRemoved(repo, pr.number);
        }
      }
      break;
    }

    case 'pull_request_review': {
      if (action !== 'submitted') break;
      const review = payload.review as { body: string; state: string } | undefined;
      const pr = payload.pull_request as { number: number } | undefined;
      if (!review || !pr) break;
      if (isAgentComment(review.body || '')) break;

      // Find the SDLC issue for this PR
      const { getSdlcIssueByPr } = await import('./db.js');
      const prIssue = getSdlcIssueByPr(repo, pr.number);
      if (!prIssue) break;

      if (review.state === 'changes_requested' || review.body?.trim()) {
        await pipeline.handleFeedback(repo, prIssue.issue_number, review.body || '');
      }
      break;
    }

    case 'pull_request_review_comment': {
      if (action !== 'created') break;
      const comment = payload.comment as { id: number; body: string } | undefined;
      const pr = payload.pull_request as { number: number } | undefined;
      if (!comment || !pr) break;
      if (isAgentComment(comment.body)) break;

      const { getSdlcIssueByPr: getByPr } = await import('./db.js');
      const prIssue2 = getByPr(repo, pr.number);
      if (!prIssue2) break;

      const prActed = await pipeline.handleFeedback(repo, prIssue2.issue_number, comment.body);
      if (prActed) {
        try {
          const ghEnv = readEnvFile(['GITHUB_TOKEN']);
          const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
          if (token) {
            execSync(`gh api repos/${repo}/pulls/comments/${comment.id}/reactions -X POST -f content="+1"`, {
              env: { ...process.env, GITHUB_TOKEN: token },
              stdio: 'pipe',
            });
          }
        } catch {
          /* best-effort */
        }
      }
      break;
    }

    default:
      log.debug('Ignoring unhandled webhook event', { event, action });
  }
}
