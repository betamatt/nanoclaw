# Custom Skills

Skills added directly to this fork (not via `/add-skill`). These are bespoke customizations that extend NanoClaw beyond the upstream feature set.

> **Claude:** When adding or updating custom skills on this fork, update this file to reflect the changes. Keep each skill's documentation current with its actual behavior, required env vars, and lifecycle.

---

## GitHub Integration

### Agent GitHub (`container/skills/agent-github/`)

**Type:** Container skill (loaded inside agent containers at runtime)

**Purpose:** Gives container agents access to the GitHub CLI (`gh`) for managing issues, pull requests, and code review. The `gh` CLI is installed in the container image and pre-authenticated via `GITHUB_TOKEN`.

**What it does:**
- Agents can list, view, and search issues and PRs
- Agents can post comments, add labels, and submit PR reviews
- Agents can check CI status, view diffs, and query repo metadata

**Restrictions enforced by the skill doc:**
- No merging, closing, or reopening PRs/issues
- No creating releases or deleting repos
- No force pushing or modifying branch protection

**Required `.env`:**

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub personal access token with `repo` scope | `ghp_...` |
| `GH_REPO` | Default repository for `gh` commands | `owner/repo` |

**Container changes:**
- `container/Dockerfile` — installs `gh` CLI via GitHub's apt repository
- `src/container-runner.ts` — passes `GITHUB_TOKEN` and `GH_REPO` as env vars to containers

---

## SDLC Pipeline (`src/sdlc/`)

**Type:** Host subsystem + container skill

**Purpose:** Automated software development lifecycle driven by GitHub issues. When an issue is opened on a configured repository, the pipeline triages it, creates an implementation plan, implements the changes, reviews the code, and validates the result — all autonomously using container agents.

### Lifecycle

```
Issue Opened
    |
    v
1. TRIAGE — Agent reads the issue and codebase. Classifies as bug/feature/chore/security
   and small/med/large complexity. Adds labels. If the issue is unclear, asks clarifying
   questions and pauses (resume with `/sdlc retry` comment). Only proceeds when 90%+
   confident it can produce a realistic plan.
    |
    v
2. PLAN — Agent investigates the codebase in a git worktree, creates a detailed
   implementation plan, and posts it as an issue comment. Adds `sdlc:plan-ready` label.
    |
    v
3. AWAITING APPROVAL — Pipeline pauses. A human must approve by:
   - Adding the `sdlc:approve-plan` label, OR
   - Commenting "approved", "proceed", "lgtm", "ship it", etc.
   (Agent's own comments are ignored to prevent self-approval.)
    |
    v
4. IMPLEMENT — Agent creates a branch (sdlc/{number}-{slug}), implements the plan,
   runs tests, commits, pushes, and opens a PR. Tests must pass — the agent will never
   remove or skip tests to get a clean build. If tests need human input, the PR is
   opened with failures clearly documented.
    |
    v
5. REVIEW — Agent reads the PR diff and performs code review. Fixes clear issues
   directly (bugs, typos, convention violations). Leaves inline PR comments for
   things it can't resolve (design questions, domain-dependent trade-offs).
   Sets `sdlc/review` commit status.
    |
    v
6. VALIDATE — Agent compares the PR against original issue requirements, checks CI
   status, and posts a validation summary. Sets `sdlc/validate` commit status.
   Adds `sdlc:validated` label if requirements are met.
    |
    v
7. DONE — Worktree cleaned up. Human merges the PR.
```

**Error handling:** Each stage retries up to 2 times. On final failure, the issue is marked `sdlc:failed` and a comment explains what went wrong. Comment `/sdlc retry` on the issue to restart the failed stage.

### Architecture

- **Webhook server** (`src/sdlc/webhook-server.ts`) — HTTP server receiving GitHub events on `POST /webhook/github`. HMAC-SHA256 signature verification.
- **Tailscale Funnel** (`src/sdlc/tailscale-funnel.ts`) — Automatically exposes the webhook port publicly via Tailscale Funnel if `SDLC_WEBHOOK_URL` is not set manually.
- **Webhook setup** (`src/sdlc/webhook-setup.ts`) — Auto-registers webhooks and SDLC labels on configured repos via `gh api` at startup.
- **Pipeline** (`src/sdlc/pipeline.ts`) — State machine managing stage transitions. Each issue gets a synthetic registered group (`sdlc:{repo}#{number}`) and its own git worktree for isolation.
- **Repo manager** (`src/sdlc/repo-manager.ts`) — Clones repos and manages per-issue git worktrees. Installs git guardrails (identity from repo history, commit-msg hook that strips Co-Authored-By).
- **Prompts** (`src/sdlc/prompts.ts`) — Stage-specific prompt templates.
- **DB** (`src/sdlc/db.ts`) — `sdlc_issues` table tracking issue state.
- **Container skill** (`container/skills/agent-sdlc/SKILL.md`) — Agent-facing instructions with elevated permissions (can create PRs, add labels, push branches).

### Required `.env`

| Variable | Description | Example |
|----------|-------------|---------|
| `SDLC_ENABLED` | Enable the SDLC pipeline (must be `true`) | `true` |
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope (shared with agent-github) | `ghp_...` |
| `GH_REPO` | Default repo for `gh` commands | `owner/repo` |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for webhook signature verification | `fa82ea98...` |
| `SDLC_REPOS` | Comma-separated repos to watch for issues | `owner/repo1,owner/repo2` |
| `TAILSCALE_SOCKET` | Path to Tailscale socket (macOS homebrew) | `/opt/homebrew/var/tailscale.socket` |

**Optional `.env`:**

| Variable | Default | Description |
|----------|---------|-------------|
| `SDLC_WEBHOOK_PORT` | `3456` | Local port for the webhook HTTP server |
| `SDLC_WEBHOOK_URL` | *(auto via Tailscale Funnel)* | Manual override for the externally reachable URL |

### Labels created automatically

On startup, the pipeline ensures these labels exist on each configured repo:

| Label | Purpose |
|-------|---------|
| `bug`, `feature`, `chore`, `security` | Issue type classification |
| `complexity:small`, `complexity:med`, `complexity:large` | Effort estimation |
| `sdlc:plan-ready` | Plan posted, awaiting human approval |
| `sdlc:approve-plan` | Human approved the plan |
| `sdlc:validated` | PR validated against requirements |
| `sdlc:failed` | Pipeline stage failed |

### Commit status checks

The review and validate stages set GitHub commit statuses on the PR:

| Context | Description |
|---------|-------------|
| `sdlc/review` | Pending while reviewing, success when complete |
| `sdlc/validate` | Pending while validating, success/failure based on verdict |

### Agent identity

The agent commits using the git identity from the target repo's most recent commit — never as Claude. A `commit-msg` hook in each worktree strips any `Co-Authored-By` or `Signed-off-by` lines mentioning Claude or Anthropic as a safety net.

### Key files

| File | Purpose |
|------|---------|
| `src/sdlc/pipeline.ts` | State machine and GroupQueue integration |
| `src/sdlc/webhook-server.ts` | HTTP server for GitHub webhooks |
| `src/sdlc/webhook-setup.ts` | Auto-registers webhooks and labels |
| `src/sdlc/tailscale-funnel.ts` | Tailscale Funnel management |
| `src/sdlc/prompts.ts` | Stage prompt templates |
| `src/sdlc/repo-manager.ts` | Git clone and worktree management |
| `src/sdlc/db.ts` | SDLC issues SQLite table |
| `src/sdlc/config.ts` | SDLC env var reading |
| `src/sdlc/types.ts` | TypeScript types |
| `container/skills/agent-sdlc/SKILL.md` | Agent-facing SDLC instructions |
| `.claude/skills/github-sdlc/SKILL.md` | Host skill definition |
