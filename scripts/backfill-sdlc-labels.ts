#!/usr/bin/env npx tsx
/**
 * One-time migration: backfill new SDLC state labels on GitHub from the DB.
 * Idempotent — checks existing labels before applying.
 *
 * Usage: npx tsx scripts/backfill-sdlc-labels.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { execSync } from 'child_process';

const STORE_DIR = path.join(process.cwd(), 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

const STAGE_TO_LABEL: Record<string, string | null> = {
  triage: 'sdlc:triage',
  plan: 'sdlc:triage',
  blocked: 'sdlc:blocked',
  awaiting_approval: 'sdlc:plan-ready',
  implement: 'sdlc:plan-approved',
  review: 'sdlc:review',
  review_flagged: 'sdlc:review',
  validate: 'sdlc:validate',
  awaiting_merge: 'sdlc:awaiting-merge',
  merge: 'sdlc:merge',
  done: null,
  failed: null,
};

const PR_STAGES = new Set(['review', 'review_flagged', 'validate', 'awaiting_merge', 'merge']);

const dryRun = process.argv.includes('--dry-run');

const db = new Database(DB_PATH);

interface Row {
  repo: string;
  issue_number: number;
  current_stage: string;
  pr_number: number | null;
}

const issues = db.prepare('SELECT repo, issue_number, current_stage, pr_number FROM sdlc_issues').all() as Row[];

console.log(`Found ${issues.length} SDLC issues`);

for (const issue of issues) {
  const label = STAGE_TO_LABEL[issue.current_stage];
  if (!label) {
    console.log(`  #${issue.issue_number} (${issue.current_stage}) — skipping (terminal state)`);
    continue;
  }

  const targetNumber = PR_STAGES.has(issue.current_stage) && issue.pr_number
    ? issue.pr_number
    : issue.issue_number;

  // Check if label already exists
  try {
    const existing = execSync(
      `gh api repos/${issue.repo}/issues/${targetNumber}/labels --jq '[.[].name]'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const labels: string[] = JSON.parse(existing);
    if (labels.includes(label)) {
      console.log(`  #${issue.issue_number} → ${label} on ${targetNumber} — already present`);
      continue;
    }
  } catch {
    // ignore — will try to apply anyway
  }

  if (dryRun) {
    console.log(`  #${issue.issue_number} → ${label} on ${targetNumber} — would apply (dry run)`);
  } else {
    try {
      execSync(
        `gh api repos/${issue.repo}/issues/${targetNumber}/labels -X POST -f "labels[]=${label}"`,
        { stdio: 'pipe' },
      );
      console.log(`  #${issue.issue_number} → ${label} on ${targetNumber} — applied`);

      // If review_flagged or failed, also add feedback-required
      if (issue.current_stage === 'review_flagged' || issue.current_stage === 'failed') {
        execSync(
          `gh api repos/${issue.repo}/issues/${targetNumber}/labels -X POST -f "labels[]=sdlc:feedback-required"`,
          { stdio: 'pipe' },
        );
        console.log(`  #${issue.issue_number} → sdlc:feedback-required — applied`);
      }
    } catch (err) {
      console.error(`  #${issue.issue_number} → ${label} on ${targetNumber} — FAILED: ${err}`);
    }
  }
}

db.close();
console.log('Done');
