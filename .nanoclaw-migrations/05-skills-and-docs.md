# Skills and Documentation

## Host skills (copy directories as-is from main tree)

- `.claude/skills/add-github/` — Custom skill for adding GitHub CLI to containers
- `.claude/skills/github-sdlc/` — SDLC pipeline host skill (SKILL.md + STATE_MACHINE.md)

## Modified host skills

### add-whatsapp — dedicated phone number support

**File:** `.claude/skills/add-whatsapp/SKILL.md`

**How to apply:** In the WhatsApp setup flow, add handling for dedicated phone number choice. Add `--dedicated-number` flag to the register command.

### claw — SDLC status dashboard

**File:** `.claude/skills/claw/scripts/claw`

**How to apply:** Add `--sdlc` flag and `sdlc_status()` function to the claw Python CLI. The function queries `store/messages.db` for SDLC issue counts by stage, running containers, active issues, and failed issues. Supports multi-repo display.

## All other skill directories

Copy all `.claude/skills/*/` directories from the main tree. These are skill definitions (not branch merges) and should be preserved as-is. There are ~31 directories.

## Documentation

### CLAUDE.md

**How to apply:** Add "Custom Skills Documentation" section explaining that custom skills must be documented in `CUSTOM_SKILLS.md`.

### CUSTOM_SKILLS.md (new)

Copy as-is from main tree. Documents the GitHub integration and SDLC pipeline skills.

### .env.example

**How to apply:** Add these variables:
```
ASSISTANT_HAS_OWN_NUMBER=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
```

### groups/global/CLAUDE.md and groups/main/CLAUDE.md

Copy as-is from main tree (user content/persona files).
