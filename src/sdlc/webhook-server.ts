import crypto from 'crypto';
import http from 'http';

import { logger } from '../logger.js';
import { GITHUB_WEBHOOK_SECRET, SDLC_REPOS, SDLC_WEBHOOK_PORT } from './config.js';
import type { SdlcPipeline } from './pipeline.js';

function verifySignature(payload: Buffer, signature: string | undefined): boolean {
  if (!GITHUB_WEBHOOK_SECRET) {
    logger.warn('GITHUB_WEBHOOK_SECRET not set — skipping signature verification');
    return true;
  }
  if (!signature) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

export function startWebhookServer(pipeline: SdlcPipeline): http.Server {
  const server = http.createServer((req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'sdlc-webhook' }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook/github') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'] as string | undefined;

      if (!verifySignature(body, signature)) {
        logger.warn('Webhook signature verification failed');
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
        logger.error({ err }, 'Failed to parse webhook payload');
        return;
      }

      handleEvent(event, payload, pipeline).catch((err) =>
        logger.error({ err, event }, 'Error handling webhook event'),
      );
    });
  });

  server.listen(SDLC_WEBHOOK_PORT, () => {
    logger.info(
      { port: SDLC_WEBHOOK_PORT },
      'SDLC webhook server listening',
    );
  });

  return server;
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

async function handleEvent(
  event: string,
  payload: Record<string, unknown>,
  pipeline: SdlcPipeline,
): Promise<void> {
  const repo = (payload.repository as { full_name: string })?.full_name;
  if (!repo) {
    logger.warn({ event }, 'Webhook missing repository.full_name');
    return;
  }

  // Check repo allowlist
  if (SDLC_REPOS.length > 0 && !SDLC_REPOS.includes(repo)) {
    logger.debug({ repo, event }, 'Ignoring webhook for non-configured repo');
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
      } else if (action === 'labeled') {
        const label = payload.label as GitHubLabel | undefined;
        if (label?.name === 'sdlc:approve-plan') {
          await pipeline.handlePlanApproved(repo, issue.number);
        }
      }
      break;
    }

    case 'issue_comment': {
      if (action !== 'created') break;
      const comment = payload.comment as { body: string } | undefined;
      const issue = payload.issue as GitHubIssue | undefined;
      if (!comment || !issue) break;

      if (comment.body.includes('/sdlc retry')) {
        await pipeline.handleRetry(repo, issue.number);
      } else if (isPlanApproval(comment.body)) {
        await pipeline.handlePlanApproved(repo, issue.number);
      }
      break;
    }

    default:
      logger.debug({ event, action }, 'Ignoring unhandled webhook event');
  }
}
