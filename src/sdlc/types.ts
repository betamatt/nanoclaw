import type { ChildProcess } from 'child_process';

import type { GroupQueue } from '../group-queue.js';
import type { RegisteredGroup } from '../types.js';

export type SdlcStage =
  | 'triage'
  | 'blocked'
  | 'plan'
  | 'awaiting_approval'
  | 'implement'
  | 'review'
  | 'review_flagged'
  | 'validate'
  | 'awaiting_merge'
  | 'done'
  | 'failed';

export type IssueType = 'bug' | 'feature' | 'chore' | 'security';
export type Complexity = 'small' | 'med' | 'large';

export interface SdlcIssue {
  id: number;
  repo: string;
  issue_number: number;
  current_stage: SdlcStage;
  issue_title: string;
  issue_body: string | null;
  issue_labels: string | null;
  classification: string | null;
  branch_name: string | null;
  pr_number: number | null;
  retry_count: number;
  blocked_by: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlockerRef {
  repo: string;
  issue_number: number;
}

export interface SdlcStageResult {
  type: 'sdlc_stage_result';
  issueNumber: number;
  repo: string;
  stage: SdlcStage;
  success: boolean;
  metadata?: Record<string, unknown>;
}

export interface SdlcPipelineDeps {
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getSessions: () => Record<string, string>;
  setSession: (folder: string, sessionId: string) => void;
  onProcess: (
    jid: string,
    proc: ChildProcess,
    name: string,
    folder: string,
  ) => void;
  sendNotification: (text: string) => Promise<void>;
}
