# NanoClaw Migration Guide

Generated: 2026-04-24
Base: 934f063aff5c30e7b49ce58b53b41901d3472a3e
HEAD at generation: b036614
Upstream: 8d85222 (upstream/main)

## Migration Plan

### Order of Operations
1. Start with clean upstream checkout
2. Apply upstream skill branches (add-github comes from a local skill, not upstream branch)
3. Install dependencies (Slack, WhatsApp/Baileys, QR code)
4. Apply container changes (Dockerfile: Rust, build-essential, gh CLI)
5. Apply agent runner changes (plugins support)
6. Apply core source modifications (config, container-runner, db, group-queue, index, ipc)
7. Copy new source directories (src/sdlc/, src/channels/, src/calendar.ts, src/whatsapp-auth.ts)
8. Copy new container skills (agent-github, agent-sdlc, calendar)
9. Copy new/modified host skills (add-github, github-sdlc, claw --sdlc)
10. Apply setup changes (whatsapp-auth, groups.ts)
11. Copy documentation (CLAUDE.md, CUSTOM_SKILLS.md, .env.example)
12. Copy migration scripts (scripts/backfill-sdlc-labels.ts)
13. Build and validate

### Risk Areas
- `src/index.ts` — heavily modified by both upstream and this fork (SDLC integration)
- `src/ipc.ts` — SDLC + calendar IPC handlers added
- `src/container-runner.ts` — GitHub token injection, OneCLI agent routing, plugins
- `setup/groups.ts` — Baileys v6 fixes may conflict with upstream WhatsApp changes
- `package.json` — dependency additions need merging with upstream dep changes

## Applied Skills

No upstream skill branches are actively applied. The apple-container merge was reverted.

Skills installed via .claude/skills/ (these are skill definitions, not branch merges — they'll be preserved by copying the directories):
- All 31+ skill directories in `.claude/skills/` — copy from main tree as-is

## Skill Interactions

No inter-skill conflicts identified. The SDLC pipeline is self-contained in `src/sdlc/`.

## Customizations

See section files:
- [01-container.md](01-container.md) — Dockerfile, agent runner, container skills
- [02-core-source.md](02-core-source.md) — Config, container-runner, db, group-queue, index, ipc
- [03-sdlc-pipeline.md](03-sdlc-pipeline.md) — Entire src/sdlc/ directory (new)
- [04-channels.md](04-channels.md) — Slack, WhatsApp channel files (new)
- [05-skills-and-docs.md](05-skills-and-docs.md) — Host skills, container skills, documentation
- [06-setup-and-scripts.md](06-setup-and-scripts.md) — Setup files, migration scripts
