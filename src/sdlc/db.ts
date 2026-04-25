import type Database from 'better-sqlite3';

import { log } from '../log.js';
import { applyStateLabel } from './labels.js';
import type { SdlcState } from './transitions.js';
import type { BlockerRef, SdlcIssue, SdlcStage } from './types.js';

/** Map old DB stages to new label states. Null means no label (terminal/internal). */
const STAGE_TO_LABEL: Partial<Record<SdlcStage, SdlcState>> = {
  triage: 'triage',
  plan: 'triage', // plan is part of triage in the new model
  blocked: 'blocked',
  awaiting_approval: 'plan-ready',
  implement: 'plan-approved',
  review: 'review',
  review_flagged: 'review', // review_flagged = review + feedback-required flag
  validate: 'validate',
  awaiting_merge: 'awaiting-merge',
  merge: 'merge',
  // done and failed have no label (closed or state+flag)
};

let db: Database.Database;

export function initSdlcSchema(database: Database.Database): void {
  db = database;

  // Legacy table — kept for backward compatibility during migration
  database.exec(`
    CREATE TABLE IF NOT EXISTS sdlc_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      current_stage TEXT NOT NULL,
      issue_title TEXT NOT NULL,
      issue_body TEXT,
      issue_labels TEXT,
      classification TEXT,
      branch_name TEXT,
      pr_number INTEGER,
      retry_count INTEGER DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo, issue_number)
    );
    CREATE INDEX IF NOT EXISTS idx_sdlc_repo_issue ON sdlc_issues(repo, issue_number);
    CREATE INDEX IF NOT EXISTS idx_sdlc_stage ON sdlc_issues(current_stage);
  `);

  // Add blocked_by column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE sdlc_issues ADD COLUMN blocked_by TEXT`);
  } catch {
    /* column already exists */
  }

  // New slim cache table — labels are the source of truth for state
  database.exec(`
    CREATE TABLE IF NOT EXISTS sdlc_cache (
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      branch_name TEXT,
      pr_number INTEGER,
      retry_count INTEGER DEFAULT 0,
      metadata TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(repo, issue_number)
    );
    CREATE INDEX IF NOT EXISTS idx_sdlc_cache_repo_issue ON sdlc_cache(repo, issue_number);
    CREATE INDEX IF NOT EXISTS idx_sdlc_cache_pr ON sdlc_cache(repo, pr_number);
  `);

  // Migrate data from old table to new cache if cache is empty
  const cacheCount = database.prepare('SELECT COUNT(*) as n FROM sdlc_cache').get() as { n: number };
  const oldCount = database.prepare('SELECT COUNT(*) as n FROM sdlc_issues').get() as { n: number };
  if (cacheCount.n === 0 && oldCount.n > 0) {
    database.exec(`
      INSERT OR IGNORE INTO sdlc_cache (repo, issue_number, branch_name, pr_number, retry_count, metadata, updated_at)
      SELECT repo, issue_number, branch_name, pr_number, retry_count, metadata, updated_at
      FROM sdlc_issues
    `);
    log.info('Migrated sdlc_issues → sdlc_cache', { migrated: oldCount.n });
  }
}

export function upsertSdlcIssue(issue: Omit<SdlcIssue, 'id'>): SdlcIssue | undefined {
  db.prepare(
    `INSERT INTO sdlc_issues (repo, issue_number, current_stage, issue_title, issue_body, issue_labels, classification, branch_name, pr_number, retry_count, blocked_by, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, issue_number) DO UPDATE SET
       issue_title = excluded.issue_title,
       issue_body = excluded.issue_body,
       issue_labels = excluded.issue_labels,
       updated_at = excluded.updated_at`,
  ).run(
    issue.repo,
    issue.issue_number,
    issue.current_stage,
    issue.issue_title,
    issue.issue_body,
    issue.issue_labels,
    issue.classification,
    issue.branch_name,
    issue.pr_number,
    issue.retry_count,
    issue.blocked_by,
    issue.metadata,
    issue.created_at,
    issue.updated_at,
  );
  return getSdlcIssue(issue.repo, issue.issue_number);
}

export function getSdlcIssue(repo: string, issueNumber: number): SdlcIssue | undefined {
  return db.prepare('SELECT * FROM sdlc_issues WHERE repo = ? AND issue_number = ?').get(repo, issueNumber) as
    | SdlcIssue
    | undefined;
}

export function getSdlcIssueByPr(repo: string, prNumber: number): SdlcIssue | undefined {
  return db.prepare('SELECT * FROM sdlc_issues WHERE repo = ? AND pr_number = ?').get(repo, prNumber) as
    | SdlcIssue
    | undefined;
}

export function updateSdlcStage(
  repo: string,
  issueNumber: number,
  stage: SdlcStage,
  updates?: Partial<
    Pick<SdlcIssue, 'classification' | 'branch_name' | 'pr_number' | 'retry_count' | 'blocked_by' | 'metadata'>
  >,
): void {
  const now = new Date().toISOString();
  const fields = ['current_stage = ?', 'updated_at = ?'];
  const values: unknown[] = [stage, now];

  if (updates?.classification !== undefined) {
    fields.push('classification = ?');
    values.push(updates.classification);
  }
  if (updates?.branch_name !== undefined) {
    fields.push('branch_name = ?');
    values.push(updates.branch_name);
  }
  if (updates?.pr_number !== undefined) {
    fields.push('pr_number = ?');
    values.push(updates.pr_number);
  }
  if (updates?.retry_count !== undefined) {
    fields.push('retry_count = ?');
    values.push(updates.retry_count);
  }
  if (updates?.blocked_by !== undefined) {
    fields.push('blocked_by = ?');
    values.push(updates.blocked_by);
  }
  if (updates?.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(updates.metadata);
  }

  values.push(repo, issueNumber);
  db.prepare(`UPDATE sdlc_issues SET ${fields.join(', ')} WHERE repo = ? AND issue_number = ?`).run(...values);

  // Dual-write: apply corresponding label on GitHub
  const labelState = STAGE_TO_LABEL[stage];
  if (labelState) {
    const prStages = new Set(['review', 'review_flagged', 'validate', 'awaiting_merge', 'merge']);
    const isPrStage = prStages.has(stage);

    // For PR stages, we need the PR number to apply labels
    let targetNumber = issueNumber;
    if (isPrStage) {
      const issue = getSdlcIssue(repo, issueNumber);
      if (issue?.pr_number) {
        targetNumber = issue.pr_number;
      }
    }

    try {
      applyStateLabel(repo, targetNumber, labelState);

      // If entering review_flagged, also add the feedback flag
      if (stage === 'review_flagged') {
        const { addFlag } = require('./labels.js') as typeof import('./labels.js');
        addFlag(repo, targetNumber, 'feedback-required');
      }
    } catch (err) {
      log.warn('Dual-write label failed (non-fatal)', { repo, issueNumber, stage, err });
    }
  }
}

export function getSdlcIssuesByStage(stage: SdlcStage): SdlcIssue[] {
  return db.prepare('SELECT * FROM sdlc_issues WHERE current_stage = ? ORDER BY updated_at').all(stage) as SdlcIssue[];
}

export function getAllSdlcIssues(): SdlcIssue[] {
  return db.prepare('SELECT * FROM sdlc_issues ORDER BY updated_at DESC').all() as SdlcIssue[];
}

/**
 * Find all issues in 'blocked' stage that are blocked by the given issue.
 * Searches the blocked_by JSON array for matching repo + issue_number.
 */
export function getIssuesBlockedBy(repo: string, issueNumber: number): SdlcIssue[] {
  // SQLite JSON: match any element in the blocked_by array
  return db
    .prepare(
      `SELECT * FROM sdlc_issues
       WHERE current_stage = 'blocked'
         AND blocked_by IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM json_each(blocked_by)
           WHERE json_extract(value, '$.repo') = ?
             AND json_extract(value, '$.issue_number') = ?
         )`,
    )
    .all(repo, issueNumber) as SdlcIssue[];
}

// ── Slim cache operations ──────────────────────────────────────────────────

export interface SdlcCacheEntry {
  repo: string;
  issue_number: number;
  branch_name: string | null;
  pr_number: number | null;
  retry_count: number;
  metadata: string | null;
  updated_at: string;
}

export function getCache(repo: string, issueNumber: number): SdlcCacheEntry | undefined {
  return db.prepare('SELECT * FROM sdlc_cache WHERE repo = ? AND issue_number = ?').get(repo, issueNumber) as
    | SdlcCacheEntry
    | undefined;
}

export function getCacheByPr(repo: string, prNumber: number): SdlcCacheEntry | undefined {
  return db.prepare('SELECT * FROM sdlc_cache WHERE repo = ? AND pr_number = ?').get(repo, prNumber) as
    | SdlcCacheEntry
    | undefined;
}

export function upsertCache(entry: Partial<SdlcCacheEntry> & { repo: string; issue_number: number }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sdlc_cache (repo, issue_number, branch_name, pr_number, retry_count, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, issue_number) DO UPDATE SET
       branch_name = COALESCE(excluded.branch_name, branch_name),
       pr_number = COALESCE(excluded.pr_number, pr_number),
       retry_count = COALESCE(excluded.retry_count, retry_count),
       metadata = COALESCE(excluded.metadata, metadata),
       updated_at = excluded.updated_at`,
  ).run(
    entry.repo,
    entry.issue_number,
    entry.branch_name ?? null,
    entry.pr_number ?? null,
    entry.retry_count ?? 0,
    entry.metadata ?? null,
    now,
  );
}

export function updateCache(
  repo: string,
  issueNumber: number,
  updates: Partial<Pick<SdlcCacheEntry, 'branch_name' | 'pr_number' | 'retry_count' | 'metadata'>>,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.branch_name !== undefined) {
    fields.push('branch_name = ?');
    values.push(updates.branch_name);
  }
  if (updates.pr_number !== undefined) {
    fields.push('pr_number = ?');
    values.push(updates.pr_number);
  }
  if (updates.retry_count !== undefined) {
    fields.push('retry_count = ?');
    values.push(updates.retry_count);
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(updates.metadata);
  }

  values.push(repo, issueNumber);
  db.prepare(`UPDATE sdlc_cache SET ${fields.join(', ')} WHERE repo = ? AND issue_number = ?`).run(...values);
}

export function deleteCache(repo: string, issueNumber: number): void {
  db.prepare('DELETE FROM sdlc_cache WHERE repo = ? AND issue_number = ?').run(repo, issueNumber);
}

export function getAllCache(): SdlcCacheEntry[] {
  return db.prepare('SELECT * FROM sdlc_cache ORDER BY updated_at DESC').all() as SdlcCacheEntry[];
}
