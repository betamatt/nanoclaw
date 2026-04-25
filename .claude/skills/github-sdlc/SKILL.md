---
name: github-sdlc
description: Add GitHub SDLC pipeline. Receives issue webhooks and drives issues through Triage, Plan, Implement, Review, Validate stages using container agents and git worktrees.
---

# GitHub SDLC Pipeline

Adds an automated software development lifecycle driven by GitHub issues. A webhook server receives issue events and orchestrates container agents through five stages.

## Prerequisites

- GitHub skill must be applied first (`/add-github`)
- `GITHUB_TOKEN` and `GH_REPO` must be set in `.env`
- The server must be reachable from GitHub (direct, tunnel, or reverse proxy)

## Phase 1: Create types and DB schema

### `src/sdlc/types.ts`

Define the SDLC types:

```typescript
export type SdlcStage = 'triage' | 'plan' | 'awaiting_approval' | 'implement' | 'review' | 'validate' | 'done' | 'failed';
export type IssueType = 'bug' | 'feature' | 'chore' | 'security';
export type Complexity = 'small' | 'med' | 'large';

export interface SdlcIssue {
  id: number;
  repo: string;
  issue_number: number;
  current_stage: SdlcStage;
  issue_title: string;
  issue_body: string | null;
  issue_labels: string | null;       // JSON array
  classification: string | null;     // JSON: {type: IssueType, complexity: Complexity}
  branch_name: string | null;
  pr_number: number | null;
  retry_count: number;
  metadata: string | null;           // JSON blob
  created_at: string;
  updated_at: string;
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
  queue: import('../group-queue.js').GroupQueue;
  registeredGroups: () => Record<string, import('../types.js').RegisteredGroup>;
  registerGroup: (jid: string, group: import('../types.js').RegisteredGroup) => void;
  getSessions: () => Record<string, string>;
  setSession: (folder: string, sessionId: string) => void;
  onProcess: (jid: string, proc: import('child_process').ChildProcess, name: string, folder: string) => void;
  sendNotification: (text: string) => Promise<void>;  // Send status to main channel
}
```

### `src/sdlc/db.ts`

Create the `sdlc_issues` table and query functions:

```sql
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
```

Functions needed:
- `initSdlcSchema(db)` -- create table (called from `src/db.ts`)
- `upsertSdlcIssue(issue)` -- insert or update
- `getSdlcIssue(repo, issueNumber)` -- lookup
- `updateSdlcStage(repo, issueNumber, stage, updates?)` -- advance stage
- `getSdlcIssuesByStage(stage)` -- list issues at a stage
- `getAllSdlcIssues()` -- list all

### Wire into `src/db.ts`

Call `initSdlcSchema(db)` at the end of `createSchema()`.

## Phase 2: Configuration

### `src/sdlc/config.ts`

Read SDLC-specific env vars:

```typescript
import { readEnvFile } from '../env.js';

const sdlcEnv = readEnvFile([
  'SDLC_ENABLED',
  'SDLC_WEBHOOK_PORT',
  'SDLC_WEBHOOK_URL',
  'GITHUB_WEBHOOK_SECRET',
  'SDLC_REPOS',
]);

export const SDLC_ENABLED = (process.env.SDLC_ENABLED || sdlcEnv.SDLC_ENABLED) === 'true';
export const SDLC_WEBHOOK_PORT = parseInt(process.env.SDLC_WEBHOOK_PORT || sdlcEnv.SDLC_WEBHOOK_PORT || '3456', 10);
export const SDLC_WEBHOOK_URL = process.env.SDLC_WEBHOOK_URL || sdlcEnv.SDLC_WEBHOOK_URL || '';
export const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || sdlcEnv.GITHUB_WEBHOOK_SECRET || '';
export const SDLC_REPOS = (process.env.SDLC_REPOS || sdlcEnv.SDLC_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
export const SDLC_REPOS_BASE = 'data/sdlc-repos';  // Base dir for repo clones/worktrees
export const MAX_SDLC_RETRIES = 2;
```

`SDLC_WEBHOOK_URL` is the externally reachable base URL of this server (e.g., `https://nanoclaw.example.com`). On startup, the SDLC system automatically registers webhooks on all `SDLC_REPOS` using `gh api`. If the webhook already exists, it is verified and updated if needed.

## Phase 3: Webhook server

### `src/sdlc/webhook-server.ts`

Node `http` module (no new deps). Single route: `POST /webhook/github`.

1. Read raw body as Buffer
2. Verify HMAC-SHA256 signature from `X-Hub-Signature-256` header using `GITHUB_WEBHOOK_SECRET`
3. Parse JSON, route on `X-GitHub-Event` header:
   - `issues` + `action: "opened"` -- call `pipeline.handleIssueOpened()`
   - `issues` + `action: "labeled"` -- if label is `sdlc:approve-plan`, call `pipeline.handlePlanApproved()`
   - `issue_comment` + `action: "created"` -- if body contains `/sdlc retry`, call `pipeline.handleRetry()`
4. Check `repository.full_name` against `SDLC_REPOS` allowlist
5. Respond 200 immediately, process async
6. Idempotent: check DB before creating duplicate entries

Export `startWebhookServer(pipeline: SdlcPipeline): void`.

## Phase 4: Repo & worktree management

### `src/sdlc/repo-manager.ts`

Manages clones and worktrees in `data/sdlc-repos/`.

```
data/sdlc-repos/
  owner/
    repo/                  # Main clone (bare or regular)
      worktrees/
        issue-42/          # Worktree for issue 42
        issue-99/          # Worktree for issue 99
```

Functions:
- `ensureRepoCloned(repo: string): Promise<string>` -- clone if not exists, return path
- `createWorktree(repo: string, issueNumber: number, branch?: string): Promise<string>` -- create worktree, return path
- `removeWorktree(repo: string, issueNumber: number): Promise<void>` -- cleanup
- `getWorktreePath(repo: string, issueNumber: number): string` -- return path

Clone uses `GITHUB_TOKEN` for auth: `git clone https://x-access-token:{token}@github.com/{repo}.git`

Worktree creation:
- Triage/Plan: `git worktree add worktrees/issue-{N} origin/main`
- Implement: `git worktree add worktrees/issue-{N} -b sdlc/{N}-{slug}`

## Phase 5: Stage prompts

### `src/sdlc/prompts.ts`

Export a function per stage, each returning a prompt string parameterized by `SdlcIssue` data.

Each prompt instructs the agent to:
1. Perform the stage-specific work using `gh` CLI and local files
2. Write a result file to `/workspace/ipc/sdlc/result-{timestamp}.json` with `SdlcStageResult` format

**Triage prompt**: Read issue, classify type + complexity, add labels, post summary comment.

**Plan prompt**: Investigate codebase, create implementation plan, post as issue comment, add `sdlc:plan-ready` label.

**Implement prompt**: Create branch, implement changes based on plan (from issue comments), commit, push, open PR. Include plan from metadata.

**Review prompt**: Read PR diff, perform code review, fix issues, push fixes, post review summary.

**Validate prompt**: Compare PR against original requirements, check CI, post validation summary, add `sdlc:validated` label.

## Phase 6: Pipeline state machine

### `src/sdlc/pipeline.ts`

The `SdlcPipeline` class orchestrates the lifecycle.

**Per-issue group**: Each issue gets a synthetic registered group:
- JID: `sdlc:{repo}#{issueNumber}` (e.g., `sdlc:owner/repo#42`)
- Folder: `sdlc-{repo-slug}-{issueNumber}` (e.g., `sdlc-owner-repo-42`)
- No trigger required
- `containerConfig.additionalMounts`: the issue's worktree path mounted at `/workspace/repo` (read-write)

**Key methods:**
- `handleIssueOpened(repo, number, title, body, labels)` -- Create DB row, create worktree, register group, enqueue triage
- `handlePlanApproved(repo, number)` -- Advance from `awaiting_approval` to `implement`
- `handleStageResult(result: SdlcStageResult)` -- Process result, advance to next stage or handle failure
- `handleRetry(repo, number)` -- Reset retry count, re-enqueue current stage
- `enqueueStage(issue: SdlcIssue)` -- Build prompt, enqueue via `queue.enqueueTask()`

**Stage transitions:**
```
triage --success--> plan
plan --success--> awaiting_approval
awaiting_approval --label--> implement
implement --success--> review
review --success--> validate
validate --success--> done (cleanup worktree)
any --failure (retries exhausted)--> failed
```

Each stage runs `runContainerAgent()` with:
- The issue-specific group (with worktree mount)
- `isScheduledTask: true`
- `context_mode: 'isolated'` (fresh session per stage)
- Stage-specific prompt from `prompts.ts`

**Export** `startSdlcSystem(deps: SdlcPipelineDeps): void` -- creates pipeline, registers IPC handler, starts webhook server, recovers in-progress issues from DB.

## Phase 7: Container skill

### `container/skills/agent-sdlc/SKILL.md`

Agent-facing instructions for SDLC work:

```markdown
---
name: agent-sdlc
description: SDLC automation. Triage, plan, implement, review, and validate GitHub issues.
allowed-tools: Bash(gh:*), Bash(git:*)
---
```

Key instructions:
- The repo is mounted at `/workspace/repo` -- work there
- Use `gh` CLI for all GitHub operations (issues, PRs, labels, comments)
- Use `git` for branching, committing, pushing
- Write result file to `/workspace/ipc/sdlc/` when stage completes
- Never force push, never merge PRs, never delete branches
- Post clear structured comments with stage summaries

## Phase 8: IPC integration

### Modify `src/ipc.ts`

Add `onSdlcResult` callback to `IpcDeps`:

```typescript
onSdlcResult?: (sourceGroup: string, data: SdlcStageResult) => void;
```

In `processIpcFiles`, scan for `sdlc` subdirectory in each group's IPC path:

```typescript
const sdlcDir = path.join(ipcBaseDir, sourceGroup, 'sdlc');
if (fs.existsSync(sdlcDir)) {
  // Read and process result files, call deps.onSdlcResult()
}
```

## Phase 9: Wire into main

### Modify `src/index.ts`

After `startIpcWatcher()`, conditionally start SDLC:

```typescript
if (SDLC_ENABLED) {
  const { startSdlcSystem } = await import('./sdlc/pipeline.js');
  startSdlcSystem({ queue, registeredGroups: () => registeredGroups, ... });
}
```

Pass `onSdlcResult` when constructing IPC deps.

## Phase 10: Verify

1. `npm run build` -- clean compile
2. `npm test` -- existing tests pass
3. Manual test with curl:
   ```bash
   curl -X POST http://localhost:3456/webhook/github \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: issues" \
     -H "X-Hub-Signature-256: sha256=..." \
     -d '{"action":"opened","issue":{"number":1,"title":"Test issue","body":"Test body"},"repository":{"full_name":"owner/repo"}}'
   ```
4. Check logs for triage stage execution
5. Verify labels added to GitHub issue
