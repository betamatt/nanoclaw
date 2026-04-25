# SDLC Pipeline (entirely new)

**Intent:** GitHub-driven software development lifecycle. Receives issue webhooks, drives issues through triage/plan/implement/review/validate/merge stages using container agents and git worktrees.

**Files:** Copy the entire `src/sdlc/` directory as-is from the main tree:
- `src/sdlc/config.ts` — Environment variable configuration
- `src/sdlc/db.ts` — SQLite schema + cache table + CRUD operations + dual-write to GitHub labels
- `src/sdlc/labels.ts` — GitHub label read/write/guard operations
- `src/sdlc/pipeline.ts` — Core state machine, stage transitions, merge queue, plugin sync, recovery
- `src/sdlc/plugin-cache.ts` — Clone marketplaces, resolve plugins, mount into containers
- `src/sdlc/prompts.ts` — Stage-specific prompts for container agents
- `src/sdlc/repo-manager.ts` — Git clone, worktree management, rebase
- `src/sdlc/tailscale-funnel.ts` — Tailscale Funnel for webhook URL
- `src/sdlc/transitions.ts` — Legal transition table, validation, state types
- `src/sdlc/types.ts` — TypeScript types for SDLC stages, issues, results
- `src/sdlc/webhook-server.ts` — HTTP webhook handler with label guard
- `src/sdlc/webhook-setup.ts` — Webhook registration and label creation

**Key design decisions preserved:**
- Labels are the source of truth for state (dual-written to DB as cache)
- `sdlc:feedback-required` flag replaces old `failed` and `review_flagged` states
- Sequential merge queue (one merge per repo at a time)
- Heavy-stage cap (`SDLC_MAX_HEAVY_CONTAINERS` defaults to N-1)
- Containers close immediately after producing results
- Post-merge rebase of in-flight branches
- Plugin cache mounted read-only into containers
- Risk-based auto-merge (low-risk PRs skip human gate)
- PR-closed guard prevents looping on dead PRs
- Feedback-required flag halts enqueue
- Recovery from GitHub labels on startup (falls back to DB)
- Thumbs-up reaction on acted-upon comments
- Linkified issue references in Slack notifications

**Required .env variables:**
- `SDLC_ENABLED=true`
- `SDLC_WEBHOOK_PORT` (default 3456)
- `GITHUB_WEBHOOK_SECRET`
- `SDLC_REPOS` (comma-separated repo list)
- `GITHUB_TOKEN` (with repo, workflow scopes)

**Required mount allowlist entry** (`~/.config/nanoclaw/mount-allowlist.json`):
```json
{
  "allowedRoots": [
    {"path": "~/projects/nanoclaw/data/sdlc-repos", "allowReadWrite": true, "description": "SDLC pipeline repo worktrees"},
    {"path": "~/projects/nanoclaw/data/plugin-cache", "allowReadWrite": false, "description": "Plugin marketplace cache"}
  ]
}
```

**State machine reference:** See `.claude/skills/github-sdlc/STATE_MACHINE.md`
