import type Database from 'better-sqlite3';

import type { SdlcIssue, SdlcStage } from './types.js';

let db: Database.Database;

export function initSdlcSchema(database: Database.Database): void {
  db = database;
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
}

export function upsertSdlcIssue(
  issue: Omit<SdlcIssue, 'id'>,
): SdlcIssue | undefined {
  db.prepare(
    `INSERT INTO sdlc_issues (repo, issue_number, current_stage, issue_title, issue_body, issue_labels, classification, branch_name, pr_number, retry_count, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    issue.metadata,
    issue.created_at,
    issue.updated_at,
  );
  return getSdlcIssue(issue.repo, issue.issue_number);
}

export function getSdlcIssue(
  repo: string,
  issueNumber: number,
): SdlcIssue | undefined {
  return db
    .prepare('SELECT * FROM sdlc_issues WHERE repo = ? AND issue_number = ?')
    .get(repo, issueNumber) as SdlcIssue | undefined;
}

export function updateSdlcStage(
  repo: string,
  issueNumber: number,
  stage: SdlcStage,
  updates?: Partial<
    Pick<
      SdlcIssue,
      | 'classification'
      | 'branch_name'
      | 'pr_number'
      | 'retry_count'
      | 'metadata'
    >
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
  if (updates?.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(updates.metadata);
  }

  values.push(repo, issueNumber);
  db.prepare(
    `UPDATE sdlc_issues SET ${fields.join(', ')} WHERE repo = ? AND issue_number = ?`,
  ).run(...values);
}

export function getSdlcIssuesByStage(stage: SdlcStage): SdlcIssue[] {
  return db
    .prepare(
      'SELECT * FROM sdlc_issues WHERE current_stage = ? ORDER BY updated_at',
    )
    .all(stage) as SdlcIssue[];
}

export function getAllSdlcIssues(): SdlcIssue[] {
  return db
    .prepare('SELECT * FROM sdlc_issues ORDER BY updated_at DESC')
    .all() as SdlcIssue[];
}
