import { execSync } from 'child_process';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  GITHUB_WEBHOOK_SECRET,
  SDLC_REPOS,
  SDLC_WEBHOOK_URL,
} from './config.js';

// Allow runtime override (e.g., from Tailscale Funnel)
let runtimeWebhookUrl: string | null = null;

export function setWebhookUrl(url: string): void {
  runtimeWebhookUrl = url;
}

function getWebhookUrl(): string {
  return runtimeWebhookUrl || SDLC_WEBHOOK_URL;
}

interface WebhookInfo {
  id: number;
  config: { url: string };
  events: string[];
  active: boolean;
}

/**
 * Register or update the SDLC webhook on all configured repos.
 * Uses `gh api` so GITHUB_TOKEN must be set.
 */
export function ensureWebhooks(): { repo: string; status: string }[] {
  const url = getWebhookUrl();
  if (!url) {
    logger.error(
      'SDLC_WEBHOOK_URL not set — cannot register webhooks. Set it to the externally reachable URL of this server.',
    );
    return [];
  }

  if (SDLC_REPOS.length === 0) {
    logger.warn('SDLC_REPOS is empty — no repos to register webhooks for');
    return [];
  }

  const ghEnv = readEnvFile(['GITHUB_TOKEN']);
  const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    logger.error('GITHUB_TOKEN not set — cannot register webhooks');
    return [];
  }

  const webhookUrl = `${getWebhookUrl().replace(/\/$/, '')}/webhook/github`;
  const results: { repo: string; status: string }[] = [];

  for (const repo of SDLC_REPOS) {
    try {
      const status = ensureWebhookForRepo(repo, webhookUrl, token);
      results.push({ repo, status });
      logger.info({ repo, status, webhookUrl }, 'Webhook setup result');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ repo, status: `error: ${msg}` });
      logger.error({ repo, err }, 'Failed to set up webhook');
    }

    // Ensure SDLC labels exist on the repo
    try {
      ensureLabelsForRepo(repo, token);
    } catch (err) {
      logger.warn({ repo, err }, 'Failed to ensure SDLC labels');
    }
  }

  return results;
}

function ensureWebhookForRepo(
  repo: string,
  webhookUrl: string,
  token: string,
): string {
  const env = { ...process.env, GITHUB_TOKEN: token };

  // List existing webhooks
  const existing = JSON.parse(
    execSync(`gh api repos/${repo}/hooks --jq '.'`, {
      encoding: 'utf-8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  ) as WebhookInfo[];

  // Check if our webhook already exists
  const match = existing.find((h) => h.config.url === webhookUrl);

  if (match) {
    // Ensure it has the right events and is active
    const needsUpdate =
      !match.active ||
      !['issues', 'issue_comment'].every((e) => match.events.includes(e));

    if (needsUpdate) {
      execSync(
        `gh api repos/${repo}/hooks/${match.id} -X PATCH -f 'active=true' --input -`,
        {
          input: JSON.stringify({
            events: ['issues', 'issue_comment'],
            active: true,
          }),
          encoding: 'utf-8',
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      return 'updated';
    }

    return 'already configured';
  }

  // Create new webhook
  const payload = JSON.stringify({
    name: 'web',
    active: true,
    events: ['issues', 'issue_comment'],
    config: {
      url: webhookUrl,
      content_type: 'json',
      secret: GITHUB_WEBHOOK_SECRET || undefined,
      insecure_ssl: '0',
    },
  });

  execSync(`gh api repos/${repo}/hooks -X POST --input -`, {
    input: payload,
    encoding: 'utf-8',
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return 'created';
}

const SDLC_LABELS = [
  // Classification labels
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'feature', color: 'a2eeef', description: 'New feature or request' },
  {
    name: 'chore',
    color: 'e4e669',
    description: 'Maintenance or housekeeping',
  },
  { name: 'security', color: 'b60205', description: 'Security-related issue' },
  // Complexity labels
  {
    name: 'complexity:small',
    color: 'c5def5',
    description: 'Small scope — straightforward, isolated change',
  },
  {
    name: 'complexity:med',
    color: 'bfd4f2',
    description: 'Medium scope — multiple files, moderate effort',
  },
  {
    name: 'complexity:large',
    color: '0075ca',
    description: 'Large scope — significant effort, architectural changes',
  },
  // Pipeline status labels
  {
    name: 'sdlc:plan-ready',
    color: '0e8a16',
    description: 'SDLC: Implementation plan is ready for review',
  },
  {
    name: 'sdlc:approve-plan',
    color: '006b75',
    description: 'SDLC: Plan approved — proceed to implementation',
  },
  {
    name: 'sdlc:validated',
    color: '2ea44f',
    description: 'SDLC: PR validated against requirements',
  },
  {
    name: 'sdlc:failed',
    color: 'b60205',
    description: 'SDLC: Pipeline stage failed',
  },
];

function ensureLabelsForRepo(repo: string, token: string): void {
  const env = { ...process.env, GITHUB_TOKEN: token };

  // Fetch existing labels
  let existing: Array<{ name: string }>;
  try {
    existing = JSON.parse(
      execSync(`gh api repos/${repo}/labels --paginate --jq '[.[].name]'`, {
        encoding: 'utf-8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
  } catch {
    existing = [];
  }

  const existingSet = new Set(
    Array.isArray(existing)
      ? existing.map((n) => (typeof n === 'string' ? n : ''))
      : [],
  );

  for (const label of SDLC_LABELS) {
    if (existingSet.has(label.name)) continue;

    try {
      execSync(`gh api repos/${repo}/labels -X POST --input -`, {
        input: JSON.stringify(label),
        encoding: 'utf-8',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logger.info({ repo, label: label.name }, 'Created SDLC label');
    } catch (err) {
      // 422 = already exists (race or case mismatch) — safe to ignore
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('422')) {
        logger.warn({ repo, label: label.name, err }, 'Failed to create label');
      }
    }
  }
}

/**
 * Remove SDLC webhooks from all configured repos.
 */
export function removeWebhooks(): { repo: string; status: string }[] {
  if (!getWebhookUrl()) return [];

  const ghEnv = readEnvFile(['GITHUB_TOKEN']);
  const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return [];

  const webhookUrl = `${getWebhookUrl().replace(/\/$/, '')}/webhook/github`;
  const results: { repo: string; status: string }[] = [];

  for (const repo of SDLC_REPOS) {
    try {
      const env = { ...process.env, GITHUB_TOKEN: token };
      const existing = JSON.parse(
        execSync(`gh api repos/${repo}/hooks --jq '.'`, {
          encoding: 'utf-8',
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      ) as WebhookInfo[];

      const match = existing.find((h) => h.config.url === webhookUrl);
      if (match) {
        execSync(`gh api repos/${repo}/hooks/${match.id} -X DELETE`, {
          encoding: 'utf-8',
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        results.push({ repo, status: 'removed' });
      } else {
        results.push({ repo, status: 'not found' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ repo, status: `error: ${msg}` });
    }
  }

  return results;
}
